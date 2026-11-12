import { GatewayError } from "../core/errors";
import { log } from "../core/log";
import { clientResponseHeaders, providerUpstream } from "./proxy-rules";
import type { AppRecord, GatewayIdentity } from "../core/types";
import { observeUpstreamBody, type ObservedBody } from "../usage/body-observer";
import { recordUsageEvent } from "../usage/usage-record";
import { timeOrderedId } from "../core/ids";
import { conversationCapture, CAPTURE_MAX_BYTES, type CaptureSource } from "../conversations/capture";
import { attemptAttribution, type ExecutionAttempt, type ExecutionPlan, type ExecutionRequest } from "./plan";
import { serverTiming, type ServedTimings } from "./timing";
import { mintsCredential } from "./credential-minting";
import { isInferencePath } from "../shared/app-config";
import {
  fetchWithTtfbTimeout,
  providerTtfbTimeoutMs,
  ProviderTtfbTimeoutError,
} from "./transport";

export interface ExecutionContext {
  env: Env;
  app: Pick<AppRecord, "id" | "organizationId">;
  identity: GatewayIdentity;
  appVersion: string | null;
  /** Read when the response is built, so they are the figures admission settled on. */
  timings: ServedTimings;
  waitUntil: (promise: Promise<unknown>) => void;
  /** The client's `X-Client-Trace-Id`, recorded on the usage event. */
  clientTraceId?: string | null;
  /** Where the request body comes from when this request's conversation is stored; null when it is not. */
  capture?: CaptureSource | null;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Where an attempt's exchange is stored from, or null when it is not stored.
 *
 * Conversation storage keeps model calls alone: an API style the gateway
 * reads, or one of the provider type's own inference operations, the same two
 * lists an app that names no paths may reach. Anything else an app's
 * `allowed_paths` lets through — files, batches, jobs whose result a later
 * poll returns, a realtime session's key — is not a conversation, whatever
 * the app chose. A minted credential is refused by name as well, so adding a
 * realtime path to a provider's inference list cannot start storing keys.
 */
function captureFor(context: ExecutionContext, attempt: ExecutionAttempt): CaptureSource | null {
  if (!context.capture || mintsCredential(attempt.providerPath)) return null;
  const modelCall = attempt.apiStyle !== "other" || isInferencePath(attempt.resolved.type, attempt.providerPath);
  return modelCall ? context.capture : null;
}

function route(attempt: ExecutionAttempt): string {
  return `${attempt.resolved.slug}/${attempt.providerPath}`;
}

function record(
  plan: ExecutionPlan,
  context: ExecutionContext,
  input: {
    attempt: ExecutionAttempt;
    observed: Promise<ObservedBody> | null;
    contentType: string;
    status: "ok" | "provider_error";
    latencyMs: number;
    /** The upstream's status, where it answered: what a stored conversation records. */
    httpStatus?: number;
    /** What was sent upstream, where it answered: the request a stored conversation records. */
    sent?: ExecutionRequest;
  },
): void {
  // One id for the usage row and the stored conversation, so each finds the other.
  const eventId = timeOrderedId();
  const capture = captureFor(context, input.attempt);
  if (capture && input.observed && input.httpStatus !== undefined && input.sent) {
    context.waitUntil(conversationCapture({
      env: context.env,
      source: capture,
      sent: input.sent,
      eventId,
      appId: context.app.id,
      identity: context.identity,
      appVersion: context.appVersion,
      clientTraceId: context.clientTraceId ?? null,
      endpointSlug: plan.endpointSlug,
      attribution: attemptAttribution(input.attempt),
      status: input.status,
      httpStatus: input.httpStatus,
      latencyMs: input.latencyMs,
      responseContentType: input.contentType,
      observed: input.observed,
    }));
  }
  context.waitUntil(recordUsageEvent({
    eventId,
    clientTraceId: context.clientTraceId ?? null,
    organizationId: context.app.organizationId,
    env: context.env,
    observed: input.observed,
    contentType: input.contentType,
    identity: context.identity,
    attribution: attemptAttribution(input.attempt),
    endpointSlug: plan.endpointSlug,
    appVersion: context.appVersion,
    status: input.status,
    latencyMs: input.latencyMs,
  }));
}

function discardFailedBody(
  body: ReadableStream<Uint8Array> | null,
  context: ExecutionContext,
  attempt: ExecutionAttempt,
): void {
  if (!body) return;
  context.waitUntil(body.cancel().catch(() => {
    log("warn", "provider_response_discard_failed", {
      appId: context.app.id,
      providerSlug: attempt.resolved.slug,
      route: route(attempt),
    });
  }));
}

function throwBudgetExhausted(
  plan: ExecutionPlan,
  context: ExecutionContext,
  budgetMs: number,
  firstSkipped: number,
): never {
  log("warn", "provider_ttfb_budget_exhausted", {
    appId: context.app.id,
    ...(plan.endpointSlug === null ? {} : { endpointSlug: plan.endpointSlug }),
    budgetMs,
    skipped: plan.attempts.slice(firstSkipped).map((attempt) => attempt.resolved.slug),
  });
  throw new GatewayError(504, "provider_error", "Provider did not respond in time");
}

/** Dispatches a prepared plan without depending on an HTTP framework context. */
export async function execute(
  plan: ExecutionPlan,
  context: ExecutionContext,
): Promise<Response> {
  const budgetMs = providerTtfbTimeoutMs(context.env);
  let deadline: number | undefined;

  for (const [index, attempt] of plan.attempts.entries()) {
    const last = index === plan.attempts.length - 1;
    if (deadline !== undefined && deadline <= performance.now()) {
      throwBudgetExhausted(plan, context, budgetMs, index);
    }
    // Building a lazy fallback and composing its authenticated URL happen
    // before fetch. If either fails, no provider was contacted and no usage
    // event should pretend otherwise.
    const request = attempt.buildRequest();
    const upstreamRequest = providerUpstream({
      resolved: attempt.resolved,
      providerPath: attempt.providerPath,
      query: request.query,
      headers: request.headers,
      appId: context.app.id,
      userId: context.identity.userId,
    });
    if (deadline === undefined) deadline = performance.now() + budgetMs;
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      throwBudgetExhausted(plan, context, budgetMs, index);
    }
    const attemptTimeoutMs = index === 0 ? budgetMs : Math.round(remainingMs);

    const providerStart = performance.now();
    let upstream: Response;
    try {
      upstream = await fetchWithTtfbTimeout(
        upstreamRequest.url,
        {
          method: plan.method,
          headers: upstreamRequest.headers,
          body: request.body,
          redirect: "manual",
        },
        attemptTimeoutMs,
      );
    } catch (error) {
      const timedOut = error instanceof ProviderTtfbTimeoutError;
      if (timedOut) {
        log("warn", "provider_ttfb_timeout", {
          appId: context.app.id,
          providerSlug: attempt.resolved.slug,
          route: route(attempt),
          ...(plan.endpointSlug === null ? {} : { endpointSlug: plan.endpointSlug }),
          timeoutMs: attemptTimeoutMs,
          ...(plan.attempts.length === 1 ? {} : { budgetMs }),
        });
      }
      record(plan, context, {
        attempt,
        observed: null,
        contentType: "",
        status: "provider_error",
        latencyMs: timedOut
          ? attemptTimeoutMs
          : Math.round(performance.now() - providerStart),
      });
      if (!last) continue;
      throw timedOut
        ? new GatewayError(504, "provider_error", "Provider did not respond in time")
        : new GatewayError(502, "provider_error", "Provider request failed");
    }
    const providerTtfb = performance.now() - providerStart;

    if (!last && isRetryableStatus(upstream.status)) {
      // Attribution is independent of cleanup: even a broken cancel operation
      // cannot erase the attempt or prevent the next target from being tried.
      record(plan, context, {
        attempt,
        observed: null,
        contentType: "",
        status: "provider_error",
        latencyMs: Math.round(providerTtfb),
      });
      discardFailedBody(upstream.body, context, attempt);
      continue;
    }

    const headers = clientResponseHeaders(upstream);
    headers.set("Server-Timing", serverTiming(context.timings, providerTtfb));
    // A minted credential is the client's alone: no cache on the way may keep
    // it, whether the provider answered with one or with an error.
    if (mintsCredential(attempt.providerPath)) headers.set("Cache-Control", "no-store");
    let clientStream = upstream.body;
    let observed: Promise<ObservedBody> | null = null;
    if (upstream.body) {
      ({ stream: clientStream, observed } = observeUpstreamBody(
        upstream.body,
        captureFor(context, attempt) ? { keepWholeUpTo: CAPTURE_MAX_BYTES } : {},
      ));
    }
    record(plan, context, {
      attempt,
      observed,
      contentType: upstream.headers.get("content-type") ?? "",
      status: upstream.ok ? "ok" : "provider_error",
      latencyMs: Math.round(providerTtfb),
      httpStatus: upstream.status,
      sent: request,
    });
    return new Response(clientStream, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  // ExecutionPlan is nonempty; this only satisfies control-flow analysis.
  throw new GatewayError(502, "provider_error", "Provider request failed");
}

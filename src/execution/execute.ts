import { GatewayError } from "../core/errors";
import type { NoAnswer } from "../usage/provider-error";
import { log } from "../core/log";
import { clientResponseHeaders, providerUpstream } from "./proxy-rules";
import type { AppRecord, GatewayIdentity } from "../core/types";
import { observeUpstreamBody, type ObservedBody } from "../usage/body-observer";
import { recordUsageEvent } from "../usage/usage-record";
import { timeOrderedId } from "../core/ids";
import { conversationCapture, CAPTURE_MAX_BYTES, type CaptureSource } from "../conversations/capture";
import { attemptAttribution, type ExecutionAttempt, type ExecutionPlan, type ExecutionRequest } from "./plan";
import { serverTiming, type ServedTimings } from "./timing";
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
 * Conversation storage keeps model calls alone. A passthrough path — files,
 * batches, jobs whose result a later poll returns, a realtime session's key —
 * is not a conversation, whatever the app chose.
 */
function captureFor(context: ExecutionContext, attempt: ExecutionAttempt): CaptureSource | null {
  if (!context.capture) return null;
  return attempt.passthrough ? null : context.capture;
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
    /** The upstream's response headers, where it answered. */
    headers?: Headers;
    status: "ok" | "provider_error";
    latencyMs: number;
    /** The upstream's status, where it answered: what a stored conversation records. */
    httpStatus?: number;
    /** Why there is no status: the upstream never answered. */
    noAnswer?: NoAnswer;
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
    responseHeaders: input.headers,
    identity: context.identity,
    attribution: attemptAttribution(input.attempt),
    endpointSlug: plan.endpointSlug,
    appVersion: context.appVersion,
    status: input.status,
    latencyMs: input.latencyMs,
    ...(input.httpStatus !== undefined && { upstreamStatus: input.httpStatus }),
    ...(input.noAnswer && { noAnswer: input.noAnswer }),
  }));
}

/** How much of a failed attempt's body is read for its error code, and for how long at most. */
const FAILED_BODY_MAX_BYTES = 8 * 1024;
const FAILED_BODY_MAX_MS = 2_000;

/**
 * The start of a failed attempt's body, for the code its provider names in it,
 * and the rest cancelled. Read in the background, bounded in bytes and time,
 * and never awaited here: the next attempt goes out at once, and only the
 * usage event that records this one waits for it.
 */
function readFailedBody(
  body: ReadableStream<Uint8Array>,
  context: ExecutionContext,
  attempt: ExecutionAttempt,
): Promise<ObservedBody> {
  return (async () => {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), FAILED_BODY_MAX_MS);
    });
    try {
      while (bytes < FAILED_BODY_MAX_BYTES) {
        const next = await Promise.race([reader.read(), timedOut]);
        if (next === null) break;
        if (next.done) {
          finished = true;
          break;
        }
        chunks.push(next.value);
        bytes += next.value.byteLength;
      }
    } catch {
      // A body that breaks off has nothing more to say; what was read stands.
    } finally {
      clearTimeout(timer);
      if (!finished) {
        await reader.cancel().catch(() => {
          log("warn", "provider_response_discard_failed", {
            appId: context.app.id,
            providerSlug: attempt.resolved.slug,
            route: route(attempt),
          });
        });
      }
    }
    const kept = new Uint8Array(Math.min(bytes, FAILED_BODY_MAX_BYTES));
    let at = 0;
    for (const chunk of chunks) {
      if (at >= kept.length) break;
      const part = chunk.subarray(0, kept.length - at);
      kept.set(part, at);
      at += part.byteLength;
    }
    return {
      head: new TextDecoder().decode(kept),
      tail: "",
      truncated: !finished || bytes > FAILED_BODY_MAX_BYTES,
      totalBytes: bytes,
      aborted: false,
    };
  })();
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
        noAnswer: timedOut ? "timeout" : "connection_failed",
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
        // Read for the code the provider names, in the background.
        observed: upstream.body ? readFailedBody(upstream.body, context, attempt) : null,
        contentType: upstream.headers.get("content-type") ?? "",
        status: "provider_error",
        latencyMs: Math.round(providerTtfb),
        httpStatus: upstream.status,
      });
      continue;
    }

    const headers = clientResponseHeaders(upstream);
    headers.set("Server-Timing", serverTiming(context.timings, providerTtfb));
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
      headers: upstream.headers,
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

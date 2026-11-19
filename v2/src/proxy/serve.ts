/**
 * The provider request path: `/v2/apps/{app}/proxy/{provider}/{native path}`
 * (plan sections 4.1, 4.3 "Call").
 *
 * In order:
 *
 * 1. Load the app and the provider connection the path names.
 * 2. Check who is calling (`authenticateRequest`), the App Attest replay
 *    counter, and whether the end user is blocked.
 * 3. Match the path to a declared operation, closed by default, and check the
 *    app allows that connection, operation and model.
 * 4. Read the body once (20 MiB at most) and apply the operation's request
 *    policy.
 * 5. Send it with the connection's key, and pipe the answer back unchanged,
 *    provider errors included.
 * 6. After the answer is sent, read its usage, price it and write one charge.
 *    Counting never fails or delays the request (`AGENTS.md`).
 *
 * Only calls measured by the OpenAI chat usage reader are served in this step.
 * App limits, the plan allowance, fallback chains, presets and conversation
 * storage come in later steps.
 */
import type { Context } from "hono";
import { assertAppActive, loadApp } from "../apps/app-records.ts";
import { markApiKeyUsed } from "../client-auth/api-keys.ts";
import { authenticateRequest, clientAuth } from "../client-auth/client-auth.ts";
import { useAssertionCounter } from "../client-auth/replay.ts";
import { cachedAppUserBlocked } from "../client-auth/user-status.ts";
import { DEFAULT_END_USER_HEADER, PROVIDER_SLUG_PATTERN } from "../contracts/app-config.ts";
import { errorFacts } from "../core/error-facts.ts";
import { GatewayError } from "../core/errors.ts";
import { timeOrderedId } from "../core/ids.ts";
import { log } from "../core/log.ts";
import type { AppRecord, GatewayIdentity } from "../core/types.ts";
import { recordRejectionEvent, REJECTION_REASONS } from "../diagnostics/rejection-events.ts";
import { bodyOnce } from "../http/body.ts";
import { recordLedgerEntry } from "../ledger/write.ts";
import { resolvePrice } from "../pricing/prices.ts";
import {
  connectionDescription,
  connectionSecret,
  loadConnection,
  upstreamOrigin,
  type ConnectionRecord,
} from "../providers/connections.ts";
import { ProviderMatcher } from "../providers/matcher.ts";
import type { OperationDescription, ProviderDescription } from "../providers/operation.ts";
import { callCharge, type AttemptOutcome, type CallAttempt } from "./call-charge.ts";
import { applyChatOutputCap, requestStreamUsage } from "./chat-policy.ts";
import { clientResponseHeaders, upstreamHeaders } from "./headers.ts";
import { observeBody, streamFinished } from "./observe.ts";
import { readChatUsage } from "./openai-chat-usage.ts";

/** How long a provider may take to send its response headers (v1's default). */
export const PROVIDER_TTFB_TIMEOUT_MS = 120_000;

const CLIENT_TRACE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

const matchers = new Map<string, ProviderMatcher>();

function matcherFor(description: ProviderDescription): ProviderMatcher {
  let matcher = matchers.get(description.type);
  if (matcher === undefined) {
    matcher = new ProviderMatcher(description);
    matchers.set(description.type, matcher);
  }
  return matcher;
}

/** Whether this step can serve an operation: a call, measured by the OpenAI chat usage reader. */
function servedNow(operation: OperationDescription): boolean {
  return operation.lifecycle === "call" && operation.meter.kind === "response_json" && operation.meter.style === "openai-chat";
}

/** The parts of the URL after `/v2/apps/{app}/proxy/`, still encoded. */
function proxyTarget(url: URL): { slug: string; path: string } {
  const segments = url.pathname.split("/");
  // ["", "v2", "apps", app, "proxy", slug, ...rest]
  let slug: string;
  try {
    slug = decodeURIComponent(segments[5] ?? "");
  } catch {
    slug = "";
  }
  if (!PROVIDER_SLUG_PATTERN.test(slug)) throw new GatewayError(403, "path_not_allowed", "Provider slug is invalid");
  const path = segments.slice(6).join("/");
  if (path === "") throw new GatewayError(403, "path_not_allowed", "Provider path is required");
  return { slug, path };
}

type ProxyContext = Context<{ Bindings: Env }>;

export async function proxyHandler(c: ProxyContext): Promise<Response> {
  const startedAt = Date.now();
  const appId = c.req.param("app");
  if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
  const url = new URL(c.req.url);
  const target = proxyTarget(url);
  const app = await loadApp(c.env, appId);
  assertAppActive(app);
  // Only a slug the app lists is looked up: the caller is not verified yet, so
  // an unlisted one costs no D1 read and leaves nothing in the cache. It is
  // refused below, once the caller is known.
  const routing = Object.hasOwn(app.routing.providers, target.slug) ? app.routing.providers[target.slug] : undefined;
  const connection = routing === undefined ? null : await loadConnection(c.env, app.accountId, target.slug);
  const description = connection === null ? null : connectionDescription(connection);
  const readBody = bodyOnce(c.req.raw);

  const { identity, credential, assertionCounter } = await authenticateRequest({
    env: c.env,
    app,
    request: c.req.raw,
    body: readBody,
    ...(description === null ? {} : { providerAuthHeader: description.auth.header }),
  });
  const appVersion = c.req.header("x-app-version") ?? null;
  if (identity.credentialType === "gateway_token" && appVersion === null) {
    throw new GatewayError(400, "invalid_request", "X-App-Version header is required");
  }

  // From here on the caller is known, so a refusal is recorded as a rejection event.
  let operationName: string | null = null;
  let model: string | null = null;
  try {
    if (assertionCounter !== null && identity.installId !== null) {
      try {
        await useAssertionCounter(c.env, app.id, identity.installId, assertionCounter);
      } catch (error) {
        // A replayed proof is a refusal to record, as v1; a limiter that did not answer is not.
        throw error instanceof GatewayError && error.code === "attest_failed" ? refusal(error, "blocked_replay", "install") : error;
      }
    }
    // An app key's last use, at most hourly, as v1. Never part of the answer.
    if (identity.apiKeyId !== undefined) {
      const apiKeyId = identity.apiKeyId;
      c.executionCtx.waitUntil(
        markApiKeyUsed(c.env, apiKeyId).catch((error: unknown) =>
          log("warn", "api_key_used_failed", { app: app.id, error: errorFacts(error) }),
        ),
      );
    }
    if (identity.userId !== null && (await cachedAppUserBlocked(c.env.DB, app.id, identity.userId))) {
      throw refusal(new GatewayError(403, "auth_required", "User is blocked"), "blocked_user", "user");
    }
    const clientTraceId = c.req.header("x-client-trace-id") ?? null;
    if (clientTraceId !== null && !CLIENT_TRACE_ID.test(clientTraceId)) {
      throw new GatewayError(
        400,
        "invalid_request",
        "X-Client-Trace-Id must be 1-128 characters from A-Z, a-z, 0-9, '.', '_', ':' and '-'",
      );
    }
    if (connection === null || description === null || routing === undefined) {
      throw new GatewayError(
        502,
        "provider_not_configured",
        `No provider connection ${target.slug} is set up for this app`,
      );
    }
    if (connection.status === "disabled") {
      throw new GatewayError(502, "provider_disabled", `Provider connection ${target.slug} is disabled`);
    }

    const match = matcherFor(description).match(c.req.method, target.path);
    if (match.kind !== "operation") {
      throw new GatewayError(403, "path_not_allowed", "Provider path is not allowed");
    }
    const { operation } = match;
    operationName = operation.name;
    if (!routing.operations.includes(operation.name)) {
      throw new GatewayError(403, "path_not_allowed", `This app does not allow ${operation.name}`);
    }
    if (!servedNow(operation)) {
      throw new GatewayError(403, "path_not_allowed", `${operation.name} is not served yet`);
    }

    const bytes = await readBody();
    const body = jsonBody(bytes);
    model = requestModel(operation, body);
    if (routing.models !== undefined && !routing.models.includes(model)) {
      throw new GatewayError(403, "model_not_allowed", "Model is not allowed", undefined, { data: { model } });
    }
    const price = resolvePrice(connection.type, model, connection.rates);
    if (price === null && routing.models === undefined) {
      // Never served: a model with no price is refused, and nothing is listed by name.
      throw new GatewayError(400, "pricing_not_configured", `Model ${model} has no price`, undefined, { data: { model } });
    }

    const capped = applyChatOutputCap(body, routing.max_output_tokens);
    const metered = requestStreamUsage(body);
    const sent = capped || metered ? new TextEncoder().encode(JSON.stringify(body)) : bytes;

    const attempt: CallAttempt = {
      requestId: timeOrderedId(startedAt),
      seq: 1,
      accountId: app.accountId,
      appId: app.id,
      identity,
      providerType: connection.type,
      connectionId: connection.id,
      providerSlug: connection.slug,
      operation: operation.name,
      model,
      price,
      startedAt,
      appVersion,
      clientTraceId,
    };
    return await sendUpstream(c, {
      app,
      connection,
      description,
      hostKey: match.upstream.host,
      path: match.upstream.path,
      query: sanitizedQuery(url),
      stripped: [credential.headerName, ...clientAuth(app).consumedHeaders, DEFAULT_END_USER_HEADER],
      body: sent,
      attempt,
    });
  } catch (error) {
    const reason = refusalReason(error);
    if (REJECTION_REASONS.has(reason.reason)) {
      c.executionCtx.waitUntil(
        recordRejectionEvent(c.env, {
          identity,
          reason: reason.reason,
          scope: reason.scope,
          providerSlug: target.slug,
          model: model === null ? null : model.slice(0, 200),
          operation: operationName,
          appVersion,
          latencyMs: Date.now() - startedAt,
        }),
      );
    }
    throw error;
  }
}

const REFUSALS = new WeakMap<object, { reason: string; scope: string | null }>();

/** Marks an error with a rejection reason other than its code. */
function refusal(error: GatewayError, reason: string, scope: string | null): GatewayError {
  REFUSALS.set(error, { reason, scope });
  return error;
}

function refusalReason(error: unknown): { reason: string; scope: string | null } {
  if (typeof error === "object" && error !== null) {
    const marked = REFUSALS.get(error);
    if (marked !== undefined) return marked;
  }
  return { reason: error instanceof GatewayError ? error.code : "internal_error", scope: null };
}

function jsonBody(bytes: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new GatewayError(400, "invalid_request", "Request body must be a JSON object");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GatewayError(400, "invalid_request", "Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requestModel(operation: OperationDescription, body: Record<string, unknown>): string {
  const location = operation.model;
  if (location.in === "fixed") return location.model;
  if (location.in !== "body") throw new GatewayError(500, "internal_error", "This operation's model location is not served yet");
  const value = body[location.field] ?? location.default;
  if (typeof value !== "string" || value.trim() === "") {
    throw new GatewayError(400, "invalid_request", `Request body must name a model in ${location.field}`);
  }
  return value;
}

/** A provider error's own code, from `error.code` or `error.type`, if its body names one. */
function providerErrorCode(text: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const root = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const error =
    root !== null && typeof root.error === "object" && root.error !== null && !Array.isArray(root.error)
      ? (root.error as Record<string, unknown>)
      : null;
  // The first usable one, in v1's order: a number in `code` must not hide a good `type`.
  const candidates = error !== null ? [error.code, error.type, error.status] : [root?.code, root?.type];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^[A-Za-z0-9_.:-]{1,60}$/u.test(candidate)) return candidate;
  }
  return null;
}

/** The client's query without a key an SDK may have put there, as v1: the gateway never forwards a client key. */
function sanitizedQuery(url: URL): string {
  const copy = new URL(url);
  copy.searchParams.delete("key");
  copy.searchParams.delete("api_key");
  return copy.search;
}

async function sendUpstream(
  c: ProxyContext,
  input: {
    app: AppRecord;
    connection: ConnectionRecord;
    description: ProviderDescription;
    hostKey: string;
    path: string;
    query: string;
    /** Client headers that must never reach the provider, even if allowlisted: the gateway's own credentials and end-user ids. */
    stripped: readonly string[];
    body: Uint8Array;
    attempt: CallAttempt;
  },
): Promise<Response> {
  const { connection, description, attempt } = input;
  const secret = await connectionSecret(c.env, connection);
  const headers = upstreamHeaders(c.req.raw.headers);
  for (const name of input.stripped) headers.delete(name);
  // Every operation served now sends a JSON body, whatever type the client named, as v1.
  headers.set("content-type", "application/json");
  // A callback, so a key containing `$&` or `$1` is sent as it is.
  headers.set(description.auth.header, description.auth.format.replace("{key}", () => secret));
  const origin = upstreamOrigin(connection, description, input.hostKey);
  const url = `${origin}${input.path.replace(/^\//u, "")}${input.query}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TTFB_TIMEOUT_MS);
  const providerStart = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: c.req.method,
      headers,
      body: input.body as Uint8Array<ArrayBuffer>,
      // Never follow a redirect: it could take the key to another host.
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    const timedOut = controller.signal.aborted;
    log("warn", timedOut ? "provider_ttfb_timeout" : "provider_request_failed", {
      app: attempt.appId,
      providerSlug: connection.slug,
      operation: attempt.operation,
      error: errorFacts(error),
    });
    record(c, attempt, {
      status: timedOut ? "timeout" : "network_error",
      httpStatus: null,
      errorCode: null,
      usage: null,
      cut: false,
      latencyMs: Date.now() - providerStart,
    });
    throw timedOut
      ? new GatewayError(504, "provider_error", "Provider did not respond in time")
      : new GatewayError(502, "provider_error", "Provider request failed");
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - providerStart;
  const responseHeaders = clientResponseHeaders(upstream.headers);
  const contentType = upstream.headers.get("content-type") ?? "";
  const ok = upstream.status >= 200 && upstream.status < 300;

  if (upstream.body === null) {
    record(c, attempt, {
      status: ok ? "ok" : "provider_error",
      httpStatus: upstream.status,
      errorCode: null,
      usage: null,
      cut: false,
      latencyMs,
    });
    return new Response(null, { status: upstream.status, headers: responseHeaders });
  }

  const { stream, observed } = observeBody(upstream.body);
  c.executionCtx.waitUntil(
    observed.then(
      (body) => {
        const usage = ok ? readChatUsage(body, contentType) : null;
        // A stream closed right after its `[DONE]`, with its usage read, was
        // whole: the end of stream simply had not arrived yet.
        const finished = usage !== null && streamFinished(body);
        const cut = !finished && (body.clientAborted || body.upstreamFailed);
        const outcome: AttemptOutcome = ok
          ? {
              // A stream the provider broke is a failed attempt, not one the app left.
              status: !cut ? "ok" : body.clientAborted ? "client_aborted" : "network_error",
              httpStatus: upstream.status,
              errorCode: null,
              usage,
              cut,
              latencyMs,
            }
          : {
              status: "provider_error",
              httpStatus: upstream.status,
              errorCode: providerErrorCode(body.head),
              usage: null,
              cut,
              latencyMs,
            };
        return recordLedgerEntry(c.env, safeCharge(attempt, outcome));
      },
      (error: unknown) => log("error", "usage_observe_failed", { app: attempt.appId, error: errorFacts(error) }),
    ),
  );
  return new Response(stream, { status: upstream.status, headers: responseHeaders });
}

/** Writes the charge of an attempt that ended with no body to read, after the response. */
function record(c: ProxyContext, attempt: CallAttempt, outcome: AttemptOutcome): void {
  c.executionCtx.waitUntil(recordLedgerEntry(c.env, safeCharge(attempt, outcome)));
}

/**
 * The attempt's charge. If pricing throws (a cost too large to store, say),
 * the charge is still written, unpriced, and the failure is logged: a charge
 * is never lost or silently miscounted.
 */
function safeCharge(attempt: CallAttempt, outcome: AttemptOutcome) {
  try {
    return callCharge(attempt, outcome);
  } catch (error) {
    log("error", "usage_pricing_failed", {
      app: attempt.appId,
      providerSlug: attempt.providerSlug,
      model: attempt.model,
      error: errorFacts(error),
    });
    return callCharge({ ...attempt, price: null }, outcome);
  }
}

/** The identity of a request, for the type checker in tests. */
export type { GatewayIdentity };

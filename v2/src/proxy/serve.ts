/**
 * The provider request path: `/v2/apps/{app}/proxy/{provider}/{native path}`
 * (plan sections 4.1, 4.3 "Call").
 *
 * In order:
 *
 * 1. Load the app and the provider connection the path names.
 * 2. Check who is calling (`authenticateRequest`), use up a signed
 *    request's App Attest counter so it can never be sent again, and check
 *    whether the end user is blocked.
 * 3. Match the path to a declared operation, closed by default, and check the
 *    app allows that connection, operation and model. A path the connection
 *    lists for passthrough is sent as it is instead, when the app enables
 *    passthrough (`servePassthrough`).
 * 4. Read the body once (20 MiB at most), apply the request policy (the
 *    output cap refuses here), then admit the request: the app's own limits
 *    and the plan allowance, in that order (`../limits/admission.ts`).
 * 5. Send it with the connection's key, and pipe the answer back unchanged,
 *    provider errors included.
 * 6. After the answer is sent, read its usage, price it and write one charge.
 *    Counting never fails or delays the request (`AGENTS.md`).
 *
 * Calls measured from the response body are served: today's LLM APIs, with
 * their transcription, image, embedding and speech APIs (step 3). A body is
 * JSON, or a multipart form (an upload), read by its content type. The app's
 * model rewrites apply here. Presets, with their fallback chains, are in
 * `./presets.ts`, and share the caller checks and the attempt loop.
 * Conversation storage comes in a later step.
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
import { MAX_VALUE_BYTES, multipartBoundary, MultipartError, scanMultipart, type FieldValue } from "../http/multipart.ts";
import { admitRequest } from "../limits/admission.ts";
import { recordLedgerEntry } from "../ledger/write.ts";
import { listedUnitRate, priceSources, resolveCall, resolvePassthrough, servedNow, type CallRefusal } from "../pricing/billability.ts";
import {
  connectionDescription,
  connectionCredentials,
  loadConnection,
  type ConnectionRecord,
  type UpstreamCredentials,
} from "../providers/connections.ts";
import { ProviderMatcher, upstreamRoute, type PassthroughPath, type UpstreamRoute, type UpstreamTarget } from "../providers/matcher.ts";
import { compiledPassthrough, isPassthrough, PASSTHROUGH } from "../providers/passthrough.ts";
import { STANDARD_MODE } from "../usage/service-modes.ts";
import { upstreamRequest } from "../providers/route.ts";
import { readingRules, type OperationDescription, type ProviderDescription } from "../providers/operation.ts";
import type { Parts } from "../providers/path.ts";
import { callCharge, type AttemptOutcome, type CallAttempt } from "./call-charge.ts";
import { chargedAs, judgedAlternatives } from "./alternatives.ts";
import { applyOutputCap, pinServingProviders, refuseBackground, requestStreamUsage } from "./policy.ts";
import { clientResponseHeaders, upstreamHeaders, withoutHeaders } from "./headers.ts";
import { attemptCostUsd, attemptUsage, requestedServiceMode, responseReader, servedServiceMode } from "./meter.ts";
import { removeOutbound, requestFacts, requestFormFields } from "./request-fields.ts";
import { observeBody } from "./observe.ts";

/** How long a provider may take to send its response headers (v1's default), unless the operation declares its own. */
export const PROVIDER_TTFB_TIMEOUT_MS = 120_000;

/** How long an operation's provider may take to send its response headers (`responseDeadlineMs`). */
function responseDeadlineMs(operation: OperationDescription): number {
  return operation.responseDeadlineMs ?? PROVIDER_TTFB_TIMEOUT_MS;
}

const CLIENT_TRACE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

/** By description: a custom provider's is built per connection (`../providers/custom.ts`), and all share one type. */
const matchers = new WeakMap<ProviderDescription, ProviderMatcher>();

const ROUTES = new WeakMap<ConnectionRecord, UpstreamRoute>();

/** A loaded connection's route (`upstreamRoute`), worked out once per loaded record. */
function routeOf(description: ProviderDescription, connection: ConnectionRecord): UpstreamRoute {
  let route = ROUTES.get(connection);
  if (route === undefined) {
    route = upstreamRoute(description, connection);
    ROUTES.set(connection, route);
  }
  return route;
}

export function matcherFor(description: ProviderDescription): ProviderMatcher {
  let matcher = matchers.get(description);
  if (matcher === undefined) {
    matcher = new ProviderMatcher(description);
    matchers.set(description, matcher);
  }
  return matcher;
}

/** The answer to a call serving refuses (`resolveCall`). */
function callRefusal(call: CallRefusal, operation: OperationDescription): GatewayError {
  const { model } = call;
  if (call.reason === "not_served") return new GatewayError(403, "path_not_allowed", `${operation.name} is not served yet`);
  // A path naming a model outside its closed list was never declared.
  if (call.reason === "unpriced_path") return new GatewayError(403, "path_not_allowed", "Provider path is not allowed");
  if (call.reason === "model_not_allowed") {
    return new GatewayError(403, "model_not_allowed", "Model is not allowed", undefined, { data: { model } });
  }
  if (call.reason === "wrong_unit") {
    return new GatewayError(400, "pricing_not_configured", `Model ${model} has no price that ${operation.name} can bill`, undefined, {
      data: { model, operation: operation.name },
    });
  }
  return new GatewayError(400, "pricing_not_configured", `Model ${model} has no price`, undefined, { data: { model } });
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

export type ProxyContext = Context<{ Bindings: Env }>;

/** Who is calling, once checked, and what a refusal is recorded with. */
export interface Caller {
  readonly identity: GatewayIdentity;
  /** The header the caller's credential came in, never sent to a provider. */
  readonly credentialHeader: string;
  readonly appVersion: string | null;
  readonly clientTraceId: string | null;
  /** The request body, read once, 20 MiB at most. */
  readonly readBody: () => Promise<Uint8Array>;
  /** Set as the request is understood, for the rejection event of a refusal. */
  readonly facts: { operation: string | null; model: string | null };
}

/**
 * Checks who is calling, then runs `serve`. Shared by the proxy and presets:
 * the credential, the App Attest counter (used up first, never skipped), the
 * app version, the app key's last use, a blocked end user and the trace id.
 * From the moment the caller is known, every refusal is recorded as a
 * rejection event.
 */
export async function serveCaller(
  c: ProxyContext,
  input: {
    readonly app: AppRecord;
    readonly startedAt: number;
    /** The header of the provider the request names, where a client may send its key. */
    readonly providerAuthHeader?: string;
    /** The connection a rejection event names. */
    readonly providerSlug: string;
  },
  serve: (caller: Caller) => Promise<Response>,
): Promise<Response> {
  const { app, startedAt } = input;
  const readBody = bodyOnce(c.req.raw);
  const { identity, credential, assertionCounter } = await authenticateRequest({
    env: c.env,
    app,
    request: c.req.raw,
    body: readBody,
    ...(input.providerAuthHeader === undefined ? {} : { providerAuthHeader: input.providerAuthHeader }),
  });
  const appVersion = c.req.header("x-app-version") ?? null;
  const facts: Caller["facts"] = { operation: null, model: null };

  // From here on the caller is known, so a refusal is recorded as a rejection event.
  try {
    // A signed request is single use, whatever happens to it next: its
    // counter is used up right after the proof is checked, before anything
    // else can refuse it. Never skipped (the replay check's own deadline).
    if (assertionCounter !== null && identity.installId !== null) {
      try {
        await useAssertionCounter(c.env, app.id, identity.installId, assertionCounter);
      } catch (error) {
        // A replayed proof is a refusal to record, as v1; a limiter that did not answer is not.
        throw error instanceof GatewayError && error.code === "attest_failed" ? refusal(error, "blocked_replay", "install") : error;
      }
    }
    // After the counter: the header is not signed, so a request refused for
    // lacking it must not be sendable again with it added.
    if (identity.credentialType === "gateway_token" && appVersion === null) {
      throw new GatewayError(400, "invalid_request", "X-App-Version header is required");
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
    return await serve({ identity, credentialHeader: credential.headerName, appVersion, clientTraceId, readBody, facts });
  } catch (error) {
    const reason = refusalReason(error);
    if (REJECTION_REASONS.has(reason.reason)) {
      c.executionCtx.waitUntil(
        recordRejectionEvent(c.env, {
          identity,
          reason: reason.reason,
          scope: reason.scope,
          providerSlug: input.providerSlug,
          model: facts.model === null ? null : facts.model.slice(0, 200),
          operation: facts.operation,
          appVersion,
          latencyMs: Date.now() - startedAt,
        }),
      );
    }
    throw error;
  }
}

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

  return serveCaller(
    c,
    { app, startedAt, providerSlug: target.slug, ...(description === null ? {} : { providerAuthHeader: description.auth.header }) },
    async (caller) => {
      const { identity } = caller;
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

      const matcher = matcherFor(description);
      // A connection's listed paths are reached only by an app that enables
      // passthrough on this route (plan section 4.5).
      const passthrough = routing.operations.includes(PASSTHROUGH) ? compiledPassthrough(connection.passthrough ?? []) : [];
      // Refused paths are judged where the request really goes too: its base URL or Cloudflare.
      const match = matcher.match(c.req.method, target.path, { passthrough, route: routeOf(description, connection) });
      if (match.kind === "passthrough") {
        return await servePassthrough(c, caller, { app, connection, description, listed: match.listed, upstream: match.upstream, url, startedAt });
      }
      if (match.kind !== "operation") {
        throw new GatewayError(403, "path_not_allowed", "Provider path is not allowed");
      }
      const { operation } = match;
      caller.facts.operation = operation.name;
      if (!routing.operations.includes(operation.name)) {
        throw new GatewayError(403, "path_not_allowed", `This app does not allow ${operation.name}`);
      }
      // `resolveCall` refuses an operation not served yet; refused here too, with its answer, before the body is read.
      if (!servedNow(operation)) throw callRefusal({ kind: "refused", reason: "not_served", model: "" }, operation);

      const bytes = await caller.readBody();
      const contentType = c.req.header("content-type") ?? "";
      const parsed = await requestBody(bytes, contentType, operation, description);
      const body = parsed.kind === "json" ? parsed.body : parsed.kind === "form" ? formFields(parsed.fields) : {};
      if (parsed.kind === "json") refuseBackground(operation, body);
      const requested = requestModel(operation, body, match.parts, url.searchParams);
      caller.facts.model = requested;
      // The route a request takes to a price is resolved in one place, which
      // saving runs over every call a route allows (`resolveCall`).
      const call = resolveCall(routing, app.routing.model_rewrites, priceSources(connection), operation, requested);
      if (call.kind === "refused") throw callRefusal(call, operation);
      const { model, bill } = call;
      const price = bill.price;
      // Models the provider may serve the request with instead pass the same policy.
      const alternatives = judgedAlternatives(description, operation, body, {
        allowed: routing.models,
        sources: priceSources(connection),
        baseUrl: connection.baseUrl,
      });
      // A rewritten model is written where the request named it: the path,
      // or the body or form field.
      let upstream = match.upstream;
      let bodyModelChanged = false;
      const sentQuery = new URLSearchParams(sanitizedQuery(url));
      let queryModelChanged = false;
      if (model !== requested) {
        const location = operation.model;
        if (location.in === "path") {
          const rebuilt = matcher.upstreamFor(operation.name, { ...match.parts, [location.part]: model });
          if (rebuilt === null) throw new GatewayError(400, "invalid_request", "The rewritten model cannot be sent in the path");
          upstream = rebuilt;
        } else if (location.in === "body" || location.in === "form") {
          body[location.field] = model;
          bodyModelChanged = true;
        } else if (location.in === "query") {
          sentQuery.set(location.name, model);
          queryModelChanged = true;
        }
      }
      // Read, never judged: a service mode is never refused (`./meter.ts`).
      const mode = requestedServiceMode(description, operation, connection.baseUrl, body, model);
      // What the meter takes from the request, and the values its rates depend on.
      const fields = { body, query: url.searchParams };
      const facts = requestFacts(operation, fields, price?.price ?? null, caller.facts);
      // Webhook fields, and fetch fields the operation does not need, never reach the provider.
      const outbound = removeOutbound(operation, parsed.kind === "json" ? body : null, sentQuery);

      // The output cap refuses on its own, so it runs before admission: a request
      // it refuses must not spend a request limit or the plan allowance. Only a
      // JSON body has one; a form is an upload with no output to cap.
      const capped = parsed.kind === "json" && applyOutputCap(operation, body, routing.max_output_tokens);
      const metered = parsed.kind === "json" && requestStreamUsage(operation, body);
      const pinned = parsed.kind === "json" && pinServingProviders(description, connection.servingProviders, body);
      // A transcription is only sent in a format whose answer can be priced.
      const format = parsed.kind === "form" ? meteredTranscriptionFormat(operation, description, parsed.fields) : null;
      const location = operation.model;
      const formChanges: Record<string, string> = {};
      if (format !== null) formChanges.response_format = format;
      if (parsed.kind === "form" && bodyModelChanged && location.in !== "path" && location.in !== "fixed" && location.in !== "query") {
        formChanges[location.field] = model;
      }
      const formRemoved = parsed.kind === "form" ? outbound.formFields.filter((name) => parsed.fields.has(name)) : [];
      // A raw body (audio) is sent as the client's own bytes; nothing in it is read.

      // An untouched body is sent as the client's own bytes, with its own content
      // type. A changed form is sent as a new form, so fetch writes a fresh
      // boundary. Built before admission: a form that cannot be rebuilt is
      // refused before it spends anything.
      const sent: OutgoingBody =
        parsed.kind === "json"
          ? {
              bytes:
                capped || metered || pinned || bodyModelChanged || outbound.bodyChanged ? new TextEncoder().encode(JSON.stringify(body)) : bytes,
              contentType: "application/json",
            }
          : parsed.kind === "form" && (Object.keys(formChanges).length > 0 || formRemoved.length > 0)
            ? { form: await withFields(parsed.form ?? bytes, contentType, formChanges, formRemoved), contentType: null }
            : // A raw body the client named no type for is sent with none, never an empty one.
              { bytes, contentType: contentType === "" ? null : contentType };

      // The credentials are opened before admission: a request that cannot be sent must not spend anything.
      const credentials = await connectionCredentials(c.env, connection);

      // Admission comes last, once the request is known to be one that can be
      // served: the app's own limits, then the plan allowance.
      await admitRequest({
        env: c.env,
        app,
        identity,
        waitUntil: (promise) => c.executionCtx.waitUntil(promise),
        refuse: refusal,
      });

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
        reportsCost: bill.reportsCost,
        requestedMode: mode.mode,
        ...(mode.unknown !== undefined ? { requestedModeUnknown: mode.unknown } : {}),
        startedAt,
        appVersion: caller.appVersion,
        clientTraceId: caller.clientTraceId,
        ...(alternatives.size > 0 ? { alternatives } : {}),
        ...facts,
      };
      const kept = (outbound.query ?? (queryModelChanged ? sentQuery : null))?.toString();
      const query = kept === undefined ? sanitizedQuery(url) : kept === "" ? "" : `?${kept}`;
      return await sendAttempts(c, strippedHeaders(app, caller, description.auth.header), [
        {
          connection,
          description,
          operation,
          hostKey: upstream.host,
          path: upstream.path,
          query,
          credentials: () => Promise.resolve(credentials),
          body: () => sent,
          attempt,
        },
      ]);
    },
  );
}

/**
 * Sends a request to a passthrough path the connection lists (plan section
 * 4.5): the body as the client sent it, with its own content type, the
 * provider's key in its header, to the provider's host only. Auth, the app's
 * limits and the plan allowance apply as for any call. It is charged as one
 * `passthrough` call, at the path's flat price or `not_priced`
 * (`resolvePassthrough`).
 */
async function servePassthrough(
  c: ProxyContext,
  caller: Caller,
  input: {
    readonly app: AppRecord;
    readonly connection: ConnectionRecord;
    readonly description: ProviderDescription;
    readonly listed: PassthroughPath;
    readonly upstream: UpstreamTarget;
    readonly url: URL;
    readonly startedAt: number;
  },
): Promise<Response> {
  const { app, connection, description, url, startedAt } = input;
  caller.facts.operation = PASSTHROUGH;
  const call = resolvePassthrough(input.listed);
  const { operation, bill } = call;
  const bytes = await caller.readBody();
  const contentType = c.req.header("content-type") ?? "";
  // Never read: the body goes as the client's own bytes. One with no type is sent with none.
  const sent: OutgoingBody = { bytes, contentType: contentType === "" ? null : contentType };
  const facts = requestFacts(operation, { body: {}, query: url.searchParams }, bill.price?.price ?? null, caller.facts);
  // The credentials are opened before admission: a request that cannot be sent must not spend anything.
  const credentials = await connectionCredentials(c.env, connection);
  await admitRequest({
    env: c.env,
    app,
    identity: caller.identity,
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
    refuse: refusal,
    // A path with no price skips the spending limits, not the request limits or the plan allowance (plan section 4.5).
    ...(bill.notPriced === true ? { unpriced: true } : {}),
  });
  const attempt: CallAttempt = {
    requestId: timeOrderedId(startedAt),
    seq: 1,
    accountId: app.accountId,
    appId: app.id,
    identity: caller.identity,
    providerType: connection.type,
    connectionId: connection.id,
    providerSlug: connection.slug,
    operation: operation.name,
    model: call.model,
    price: bill.price,
    reportsCost: false,
    ...(bill.notPriced === true ? { notPriced: true as const } : {}),
    requestedMode: STANDARD_MODE,
    startedAt,
    appVersion: caller.appVersion,
    clientTraceId: caller.clientTraceId,
    ...facts,
  };
  return await sendAttempts(c, strippedHeaders(app, caller, description.auth.header), [
    {
      connection,
      description,
      operation,
      hostKey: input.upstream.host,
      path: input.upstream.path,
      query: sanitizedQuery(url),
      credentials: () => Promise.resolve(credentials),
      body: () => sent,
      attempt,
    },
  ]);
}

const REFUSALS = new WeakMap<object, { reason: string; scope: string | null }>();

/** Marks an error with a rejection reason other than its code. */
export function refusal(error: GatewayError, reason: string, scope: string | null): GatewayError {
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

export type ParsedBody =
  | { readonly kind: "json"; readonly body: Record<string, unknown> }
  /** Raw bytes, such as audio, for an operation that takes them (`rawBody`): never read. */
  | { readonly kind: "raw" }
  | {
      readonly kind: "form";
      readonly fields: ReadonlyMap<string, readonly FieldValue[]>;
      /** The form parsed whole, where the fast scanner could not read it. */
      readonly form?: FormData;
    };

/** What is sent upstream: the bytes with their content type, or a form fetch encodes itself. */
export type OutgoingBody =
  | { readonly bytes: Uint8Array; readonly contentType: string | null; readonly form?: undefined }
  | { readonly form: FormData; readonly contentType: null; readonly bytes?: undefined };

function isJson(contentType: string): boolean {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return type === "application/json" || type.endsWith("+json");
}

function isMultipart(contentType: string): boolean {
  return contentType.toLowerCase().startsWith("multipart/form-data");
}

/**
 * A request body, read by its content type: a multipart form, else JSON (v1).
 *
 * A form is read by a fast scanner first: only the text fields the gateway
 * reads (the model, a transcription's format, the service mode) are read from
 * the bytes it holds, and the upload is not copied (`../http/multipart.ts`).
 * A form the scanner cannot read is parsed whole by the platform's own parser
 * instead, as v1 did, at the cost of one copy, so the scanner never refuses
 * a form v1 served. Only a form the platform's parser also refuses is
 * refused. A form that names its model more than once is refused: pricing reads the
 * first, and a provider that read another would run a model nobody priced.
 * A transcription to a provider that judges its format must be a form, since
 * only a form names the format where it can be read.
 */
export async function requestBody(
  bytes: Uint8Array,
  contentType: string,
  operation: OperationDescription,
  description: ProviderDescription,
): Promise<ParsedBody> {
  if (isMultipart(contentType)) {
    const location = operation.model;
    // The path names the model and no format is judged: as v1, the form is
    // not read at all, so it is never refused for its shape. A service mode
    // it names is not read either, as in v1: the response says which served.
    // An operation that reads a form field (a price key, a request measure, an
    // outbound field to remove) always reads its form.
    if (location.in === "path" && operation.style !== "openai-transcription" && requestFormFields(operation).length === 0) {
      return { kind: "form", fields: new Map() };
    }
    const boundary = multipartBoundary(contentType);
    const modelField = location.in === "body" || location.in === "form" ? location.field : null;
    const wanted = new Set(["response_format", ...readingRules(description, operation).serviceModes.flatMap((field) => field.names), ...requestFormFields(operation)]);
    if (modelField !== null) wanted.add(modelField);
    let parsed: { fields: ReadonlyMap<string, readonly FieldValue[]>; form?: FormData };
    try {
      if (boundary === null) throw new MultipartError("The form names no boundary");
      parsed = { fields: scanMultipart(bytes, boundary, wanted) };
    } catch {
      const form = await parseForm(bytes, contentType);
      parsed = { fields: formValues(form, wanted), form };
    }
    if (modelField !== null && (parsed.fields.get(modelField)?.length ?? 0) > 1) {
      throw new GatewayError(400, "invalid_request", "The form names its model more than once");
    }
    return { kind: "form", ...parsed };
  }
  // An operation that takes raw bytes (audio) reads a body only when it says it is JSON.
  if (operation.rawBody === true && !isJson(contentType)) return { kind: "raw" };
  if (operation.style === "openai-transcription" && readingRules(description, operation).transcriptionFormats !== undefined) {
    throw new GatewayError(400, "invalid_request", "A transcription is sent as a multipart/form-data upload");
  }
  return { kind: "json", body: jsonBody(bytes) };
}

/** A form's text fields as a record, first value of each, for the model and service mode readers. Files are left out. */
export function formFields(fields: ReadonlyMap<string, readonly FieldValue[]>): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [name, values] of fields) {
    const first = values[0];
    if (typeof first === "string") record[name] = first;
  }
  return record;
}

/** A form parsed whole by the platform's parser, as v1 did. It copies the upload. */
export async function parseForm(bytes: Uint8Array, contentType: string): Promise<FormData> {
  try {
    return await new Request("https://local.invalid", {
      method: "POST",
      headers: { "content-type": contentType },
      body: bytes as Uint8Array<ArrayBuffer>,
    }).formData();
  } catch {
    throw new GatewayError(400, "invalid_request", "Request body must be a valid multipart form");
  }
}

/** The `wanted` fields of a parsed form, as the scanner gives them: a file, or a value too long to be a name, is null. */
function formValues(form: FormData, wanted: ReadonlySet<string>): Map<string, FieldValue[]> {
  const values = new Map<string, FieldValue[]>();
  for (const name of wanted) {
    const found = form.getAll(name).map((value) => (typeof value === "string" && new TextEncoder().encode(value).length <= MAX_VALUE_BYTES ? value : null));
    if (found.length > 0) values.set(name, found);
  }
  return values;
}

/**
 * The upload with some text fields set (`response_format`, a rewritten or a
 * preset's model), as v1 does: parsed whole, which copies it, only on this
 * path, where the body must change, unless the fallback parsed it already.
 * fetch writes a fresh boundary for it.
 */
export async function withFields(
  source: Uint8Array | FormData,
  contentType: string,
  fields: Readonly<Record<string, string>>,
  removed: readonly string[] = [],
): Promise<FormData> {
  const form = source instanceof FormData ? source : await parseForm(source, contentType);
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  for (const name of removed) form.delete(name);
  return form;
}

/**
 * The `response_format` a transcription must be sent with so its answer
 * carries what it is billed by (v1's `meteredTranscriptionFormat`): null where
 * the request's is fine as it is, else the format that extends it. A format
 * with no measure and no extension is refused, and so is a form naming two.
 */
export function meteredTranscriptionFormat(
  operation: OperationDescription,
  description: ProviderDescription,
  fields: ReadonlyMap<string, readonly FieldValue[]>,
): string | null {
  const formats = readingRules(description, operation).transcriptionFormats;
  if (operation.style !== "openai-transcription" || formats === undefined) return null;
  const requested = fields.get("response_format") ?? [];
  const named = requested[0];
  if (requested.length > 1 || named === null) throw unmeteredFormat(formats.metered);
  const format = named ?? formats.default;
  if (formats.metered.includes(format)) return null;
  const upgrade = formats.upgrades !== undefined && Object.hasOwn(formats.upgrades, format) ? formats.upgrades[format] : undefined;
  if (upgrade === undefined) throw unmeteredFormat(formats.metered);
  return upgrade;
}

function unmeteredFormat(metered: readonly string[]): GatewayError {
  return new GatewayError(
    400,
    "invalid_request",
    `This response_format answers without the usage or duration a transcription is billed by; use ${metered.join(" or ")}`,
  );
}

export function jsonBody(bytes: Uint8Array): Record<string, unknown> {
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

export function requestModel(
  operation: OperationDescription,
  body: Record<string, unknown>,
  parts: Parts,
  query: URLSearchParams = new URLSearchParams(),
): string {
  const location = operation.model;
  if (location.in === "fixed") return location.model;
  if (location.in === "path") {
    const value = Object.hasOwn(parts, location.part) ? parts[location.part] : undefined;
    if (value === undefined || value.trim() === "") throw new GatewayError(400, "invalid_request", "Request path must name a model");
    return value;
  }
  if (location.in === "query") {
    const named = query.getAll(location.name);
    if (named.length > 1) throw new GatewayError(400, "invalid_request", `The query names its model in ${location.name} more than once`);
    const value = named[0] ?? location.default;
    if (value === undefined || value.trim() === "") throw new GatewayError(400, "invalid_request", `The query must name a model in ${location.name}`);
    return value;
  }
  // A body field and a form field are read the same way: the request's
  // content type, not the operation, says which the body is.
  const value = (Object.hasOwn(body, location.field) ? body[location.field] : undefined) ?? location.default;
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
export function sanitizedQuery(url: URL): string {
  const copy = new URL(url);
  copy.searchParams.delete("key");
  copy.searchParams.delete("api_key");
  return copy.search;
}

/** Client headers that never reach a provider, even if allowlisted: the gateway's own credentials and end-user ids. */
/**
 * The client headers no attempt is sent with: every header the request could
 * authenticate with (`Authorization`, the first provider's key header, the
 * app's token header), not only the one it did, and the ones the gateway
 * read. A fallback on another host never gets a client's credential.
 */
export function strippedHeaders(app: AppRecord, caller: Caller, providerAuthHeader?: string): readonly string[] {
  return [
    "authorization",
    caller.credentialHeader,
    ...(providerAuthHeader === undefined ? [] : [providerAuthHeader.toLowerCase()]),
    ...clientAuth(app).consumedHeaders,
    DEFAULT_END_USER_HEADER,
  ];
}

/** One upstream attempt, ready to send: where to, with what body, and the charge it writes. */
export interface PreparedAttempt {
  readonly connection: ConnectionRecord;
  readonly description: ProviderDescription;
  readonly operation: OperationDescription;
  readonly hostKey: string;
  readonly path: string;
  readonly query: string;
  /**
   * Opens the connection's credentials. The first attempt's are opened before
   * admission, so a request whose key cannot be opened is refused before it
   * spends anything; a fallback's only when the chain reaches it.
   */
  readonly credentials: () => Promise<UpstreamCredentials>;
  /** Built only when this attempt is sent, so a long chain never holds every target's body at once. */
  readonly body: () => OutgoingBody;
  readonly attempt: CallAttempt;
  /** Headers set when the client sent none, such as the API version a preset's provider needs. */
  readonly defaultHeaders?: Readonly<Record<string, string>>;
}

/** A status a fallback moves on from: the provider is busy or broken (v1). Anything else is the answer. */
function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** How much of a failed attempt's body is read for its error code, and for how long at most (v1). */
const FAILED_BODY_MAX_BYTES = 8 * 1024;
const FAILED_BODY_MAX_MS = 2_000;

/**
 * The start of a failed attempt's body, for the error code its provider
 * names, with the rest cancelled. Read in the background, bounded in bytes
 * and time: the next attempt goes out at once.
 */
async function failedBodyHead(body: ReadableStream<Uint8Array>): Promise<string> {
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
    // Not awaited: a cancel that never settles must not hold back the attempt's charge.
    if (!finished) void reader.cancel().catch(() => undefined);
  }
  const kept = new Uint8Array(Math.min(bytes, FAILED_BODY_MAX_BYTES));
  let at = 0;
  for (const chunk of chunks) {
    if (at >= kept.length) break;
    const part = chunk.subarray(0, kept.length - at);
    kept.set(part, at);
    at += part.byteLength;
  }
  return new TextDecoder().decode(kept);
}

/** Whether the app went away, so no later attempt is worth sending. */
function clientGone(c: ProxyContext): boolean {
  return c.req.raw.signal?.aborted === true;
}

/**
 * Sends the attempts in order and answers with the first that is not moved
 * on from (D13, v1's fallback chains):
 *
 * - An attempt that gets no answer (it timed out, or the connection failed),
 *   or answers 429 or 5xx, is followed by the next one. The last attempt's
 *   answer is passed to the app as it is, provider errors included.
 * - Every attempt is one charge, with its own `seq`. A failed one costs
 *   nothing: its cost is empty, not $0.
 * - All attempts share one budget for the provider's first byte, the
 *   proxy's own 120 s, or the first operation's own (`responseDeadlineMs`):
 *   a fallback gets what is left of it.
 * - Every attempt sends the whole body again: it was read whole before the
 *   first one, and each attempt's own body is built only when it is sent.
 * - A fallback's key is opened only when the chain reaches it, within what
 *   is left of the budget. One that cannot be opened is logged and skipped;
 *   when nothing usable is left, the previous attempt's answer is passed to
 *   the app as it is.
 * - Nothing is sent after the app went away.
 */
export async function sendAttempts(
  c: ProxyContext,
  stripped: readonly string[],
  attempts: readonly [PreparedAttempt, ...PreparedAttempt[]],
): Promise<Response> {
  let deadline: number | undefined;
  /** A failed answer kept until another attempt is really sent, so it can be passed on if none is. */
  let previous: { prepared: PreparedAttempt; upstream: Response; latencyMs: number } | null = null;
  /** The error of an attempt that got no answer, for when nothing usable follows it. */
  let failure: GatewayError | null = null;
  const budgetExhausted = (index: number): GatewayError => {
    log("warn", "provider_ttfb_budget_exhausted", {
      app: attempts[0].attempt.appId,
      skipped: attempts.slice(index).map((next) => next.connection.slug),
    });
    return new GatewayError(504, "provider_error", "Provider did not respond in time");
  };
  for (const [index, prepared] of attempts.entries()) {
    const last = index === attempts.length - 1;
    const { connection, description, attempt } = prepared;
    // The budget is checked before anything is opened or built for a fallback.
    // With a failed answer held and no time left for another, that answer is
    // passed on as it is, never a gateway error.
    if (deadline !== undefined && deadline - Date.now() <= 0) {
      if (previous !== null) {
        budgetExhausted(index);
        return answer(c, previous.prepared, previous.upstream, previous.latencyMs);
      }
      throw budgetExhausted(index);
    }
    let credentials: UpstreamCredentials;
    try {
      credentials = await withinMs(prepared.credentials(), deadline === undefined ? responseDeadlineMs(prepared.operation) : deadline - Date.now());
    } catch (error) {
      // With nothing tried before it and nothing after it, its failure is the answer.
      if (last && previous === null && failure === null) throw error;
      log("warn", "preset_fallback_skipped", {
        app: attempt.appId,
        providerSlug: connection.slug,
        code: error instanceof GatewayError ? error.code : "key_timeout",
      });
      continue;
    }
    // Everything up to the fetch can still end the call. Until the fetch is
    // under way, a held failed answer is kept, and any exit returns it.
    let fetching: Promise<Response>;
    let controller: AbortController;
    let timer: ReturnType<typeof setTimeout>;
    let providerStart: number;
    try {
      const body = prepared.body();
      // The app's headers without the gateway's own credentials and end-user ids:
      // the only client headers anything below may forward, the provider's or Cloudflare's.
      const client = withoutHeaders(c.req.raw.headers, stripped);
      // A listed passthrough path also forwards the headers its provider declares for one.
      const headers = upstreamHeaders(client, isPassthrough(prepared.operation) ? (description.passthroughHeaders ?? []) : []);
      for (const [name, value] of Object.entries(prepared.defaultHeaders ?? {})) {
        if (!headers.has(name)) headers.set(name, value);
      }
      // A JSON body is sent as JSON whatever type the client named, as v1. An
      // untouched form keeps the client's type and boundary; a changed one gets
      // the type fetch writes for it.
      if (body.contentType === null) headers.delete("content-type");
      else headers.set("content-type", body.contentType);
      // Where it goes and what it carries: set last, so nothing a client sent can override it.
      const target = upstreamRequest(connection, description, {
        hostKey: prepared.hostKey,
        path: prepared.path.replace(/^\//u, ""),
        query: prepared.query,
        ...(prepared.operation.style !== undefined ? { style: prepared.operation.style } : {}),
        credentials,
        client,
        appId: attempt.appId,
        userId: attempt.identity.userId,
      });
      for (const [name, value] of Object.entries(target.headers)) headers.set(name, value);
      const url = target.url;

      // Checked just before each fetch: nothing is sent for an app that went
      // away. The app's own signal is never passed to the provider, so an
      // answer already on its way is read to the end and charged.
      if (clientGone(c)) {
        throw new GatewayError(502, "provider_error", "The app went away before the request was sent");
      }
      providerStart = Date.now();
      deadline ??= providerStart + responseDeadlineMs(prepared.operation);
      const remainingMs = deadline - providerStart;
      if (remainingMs <= 0) throw budgetExhausted(index);
      controller = new AbortController();
      const abort = controller;
      timer = setTimeout(() => abort.abort(), remainingMs);
      fetching = fetch(url, {
        method: c.req.method,
        headers,
        // A GET carries no body: fetch refuses one, even an empty one.
        body: c.req.method === "GET" ? null : (body.form ?? (body.bytes as Uint8Array<ArrayBuffer>)),
        // Never follow a redirect: it could take the key to another host.
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      if (previous !== null) return answer(c, previous.prepared, previous.upstream, previous.latencyMs);
      throw error;
    }
    // The fallback is under way: the failed answer before it is charged and let go.
    if (previous !== null) {
      retire(c, previous);
      previous = null;
    }
    let upstream: Response;
    try {
      upstream = await fetching;
    } catch (error) {
      const timedOut = controller.signal.aborted;
      log("warn", timedOut ? "provider_ttfb_timeout" : "provider_request_failed", {
        app: attempt.appId,
        providerSlug: connection.slug,
        operation: attempt.operation,
        ...(attempts.length > 1 ? { attempt: attempt.seq } : {}),
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
      failure = timedOut
        ? new GatewayError(504, "provider_error", "Provider did not respond in time")
        : new GatewayError(502, "provider_error", "Provider request failed");
      if (!last) continue;
      throw failure;
    } finally {
      clearTimeout(timer);
    }
    const latencyMs = Date.now() - providerStart;

    if (!last && retryableStatus(upstream.status)) {
      // Kept, not yet charged: if no later attempt can be sent, it is the answer.
      previous = { prepared, upstream, latencyMs };
      failure = null;
      continue;
    }
    return answer(c, prepared, upstream, latencyMs);
  }
  // Every later attempt was skipped: the last failed answer is passed on as it is.
  if (previous !== null) return answer(c, previous.prepared, previous.upstream, previous.latencyMs);
  throw failure ?? new GatewayError(502, "provider_error", "Provider request failed");
}

/** A promise that rejects once `ms` have passed without it settling. */
function withinMs<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GatewayError(504, "provider_error", "The provider key could not be opened in time")), Math.max(0, ms));
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * Charges a failed answer a fallback was sent after, at no cost, with the
 * error code its body names, read in the background and the rest cancelled.
 */
function retire(c: ProxyContext, failed: { prepared: PreparedAttempt; upstream: Response; latencyMs: number }): void {
  const { upstream, latencyMs } = failed;
  const head = upstream.body === null ? Promise.resolve("") : failedBodyHead(upstream.body);
  c.executionCtx.waitUntil(
    head.then((text) =>
      recordLedgerEntry(
        c.env,
        safeCharge(failed.prepared.attempt, {
          status: "provider_error",
          httpStatus: upstream.status,
          errorCode: providerErrorCode(text),
          usage: null,
          cut: false,
          latencyMs,
        }),
      ),
    ),
  );
}

/** Pipes an attempt's answer to the app, and writes its charge once the answer is read. */
function answer(c: ProxyContext, prepared: PreparedAttempt, upstream: Response, latencyMs: number): Response {
  const { description, operation, attempt } = prepared;
  const responseHeaders = clientResponseHeaders(upstream.headers, description.auth.header);
  const contentType = upstream.headers.get("content-type") ?? "";
  const ok = upstream.status >= 200 && upstream.status < 300;

  if (upstream.body === null) {
    record(c, attempt, {
      status: ok ? "ok" : "provider_error",
      httpStatus: upstream.status,
      errorCode: null,
      usage: ok ? attemptUsage(operation, { ...attempt, listedRate: (unit) => listedUnitRate(attempt.providerType, attempt.model, unit) }, null, upstream.headers) : null,
      providerCostUsd: ok ? attemptCostUsd(operation, null, upstream.headers) : null,
      cut: false,
      latencyMs,
    });
    return new Response(null, { status: upstream.status, headers: responseHeaders });
  }

  // The answer is read as it streams past, keeping only what the meter needs.
  const reader = ok
    ? responseReader(contentType, description, operation, { app: attempt.appId, providerSlug: attempt.providerSlug, model: attempt.model })
    : null;
  const { stream, observed } = observeBody(upstream.body, {
    ...(reader !== null ? { onChunk: (chunk: Uint8Array) => reader.push(chunk) } : {}),
    keepHead: !ok,
  });
  c.executionCtx.waitUntil(
    observed.then(
      (body) => {
        const reading = reader?.finish(upstream.headers, !body.clientAborted && !body.upstreamFailed) ?? null;
        const usage = ok ? attemptUsage(operation, { ...attempt, listedRate: (unit) => listedUnitRate(attempt.providerType, attempt.model, unit) }, reading?.usage ?? null, upstream.headers) : null;
        // A stream is whole once its style's closing event arrived, even if the
        // app went away right after. One that ended without it was cut short,
        // however it ended. A style with no closing event, and an answer that
        // is not a stream, are whole when they were read to the end.
        const closed = reading?.closed ?? null;
        const cut = closed === true ? false : closed === false || body.clientAborted || body.upstreamFailed;
        // Charged as the model that served it, when the request named another it could be served with:
        // its price, and the mode the request asked of its provider, which the served mode starts from.
        const charged = ok ? chargedAs(attempt, reading?.servedModel ?? null) : attempt;
        // A passthrough answer is not read, so it names no mode: it is billed as asked, at its flat price.
        const served: ReturnType<typeof servedServiceMode> = isPassthrough(operation)
          ? { mode: charged.requestedMode }
          : servedServiceMode(description, operation, charged.requestedMode, usage, upstream.headers, charged.model);
        const outcome: AttemptOutcome = ok
          ? {
              // A stream the provider broke, or ended early, is a failed attempt, not one the app left.
              status: !cut ? "ok" : body.clientAborted ? "client_aborted" : "network_error",
              httpStatus: upstream.status,
              errorCode: null,
              usage,
              providerCostUsd: attemptCostUsd(operation, reading, upstream.headers),
              servedMode: served.mode,
              ...(served.unknown !== undefined ? { servedModeUnknown: served.unknown } : {}),
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
        return recordLedgerEntry(c.env, safeCharge(charged, outcome));
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
 * is never lost or silently miscounted. The retry carries neither the price
 * nor the provider's own figure, so it never meets the same throwing report.
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
    return callCharge({ ...attempt, price: null }, { ...outcome, providerCostUsd: null });
  }
}

/** The identity of a request, for the type checker in tests. */
export type { GatewayIdentity };

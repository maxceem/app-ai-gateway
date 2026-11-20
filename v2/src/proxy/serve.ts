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
 *    app allows that connection, operation and model.
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
import { pricesOperation, reportsCost, resolvePrice } from "../pricing/prices.ts";
import {
  connectionDescription,
  connectionSecret,
  loadConnection,
  upstreamOrigin,
  type ConnectionRecord,
} from "../providers/connections.ts";
import { ProviderMatcher } from "../providers/matcher.ts";
import type { OperationDescription, ProviderDescription } from "../providers/operation.ts";
import type { Parts } from "../providers/path.ts";
import { callCharge, type AttemptOutcome, type CallAttempt } from "./call-charge.ts";
import { applyOutputCap, refuseBackground, requestStreamUsage } from "./policy.ts";
import { clientResponseHeaders, upstreamHeaders } from "./headers.ts";
import { readResponse, requestedServiceMode, servedServiceMode } from "./meter.ts";
import { observeBody, streamClosed } from "./observe.ts";

/** How long a provider may take to send its response headers (v1's default). */
export const PROVIDER_TTFB_TIMEOUT_MS = 120_000;

const CLIENT_TRACE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

const matchers = new Map<string, ProviderMatcher>();

export function matcherFor(description: ProviderDescription): ProviderMatcher {
  let matcher = matchers.get(description.type);
  if (matcher === undefined) {
    matcher = new ProviderMatcher(description);
    matchers.set(description.type, matcher);
  }
  return matcher;
}

/** Whether this build can serve an operation: a call measured from its response body. */
export function servedNow(operation: OperationDescription): boolean {
  return operation.lifecycle === "call" && operation.meter.kind === "response_json";
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

/** The model a request is sent and billed as: the app's rewrite of it, if any (v1). A fixed model is never rewritten. */
export function rewrittenModel(app: AppRecord, operation: OperationDescription, model: string): string {
  if (operation.model.in === "fixed") return model;
  const rewrites = app.routing.model_rewrites ?? {};
  return Object.hasOwn(rewrites, model) ? rewrites[model]! : model;
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
      const match = matcher.match(c.req.method, target.path);
      if (match.kind !== "operation") {
        throw new GatewayError(403, "path_not_allowed", "Provider path is not allowed");
      }
      const { operation } = match;
      caller.facts.operation = operation.name;
      if (!routing.operations.includes(operation.name)) {
        throw new GatewayError(403, "path_not_allowed", `This app does not allow ${operation.name}`);
      }
      if (!servedNow(operation)) {
        throw new GatewayError(403, "path_not_allowed", `${operation.name} is not served yet`);
      }

      const bytes = await caller.readBody();
      const contentType = c.req.header("content-type") ?? "";
      const parsed = await requestBody(bytes, contentType, operation, description);
      const body = parsed.kind === "json" ? parsed.body : formFields(parsed.fields);
      if (parsed.kind === "json") refuseBackground(operation, body);
      const requested = requestModel(operation, body, match.parts);
      caller.facts.model = requested;
      if (routing.models !== undefined && !routing.models.includes(requested)) {
        throw new GatewayError(403, "model_not_allowed", "Model is not allowed", undefined, { data: { model: requested } });
      }
      // The app's model list judges the model the request names; everything
      // after it, the price included, the model it is sent as.
      const model = rewrittenModel(app, operation, requested);
      const resolved = resolvePrice(connection.type, model, connection.rates);
      // A price in another unit (per minute, say) cannot bill this operation.
      const price = resolved !== null && pricesOperation(operation, resolved.price) ? resolved : null;
      if (price === null && !reportsCost(operation)) {
        // Never served: a model with no price is refused, unless the app lists
        // it by name (its price may have gone since: it is served, and priced
        // later). A model priced only in a unit this operation cannot bill (a
        // per-minute price on chat) was never served on it, so it is refused
        // even when listed: an app may list it for another of its operations.
        if (resolved !== null) {
          throw new GatewayError(400, "pricing_not_configured", `Model ${model} has no price that ${operation.name} can bill`, undefined, {
            data: { model, operation: operation.name },
          });
        }
        if (routing.models === undefined) {
          throw new GatewayError(400, "pricing_not_configured", `Model ${model} has no price`, undefined, { data: { model } });
        }
      }
      // A rewritten model is written where the request named it: the path,
      // or the body or form field.
      let upstream = match.upstream;
      let bodyModelChanged = false;
      if (model !== requested) {
        const location = operation.model;
        if (location.in === "path") {
          const rebuilt = matcher.upstreamFor(operation.name, { ...match.parts, [location.part]: model });
          if (rebuilt === null) throw new GatewayError(400, "invalid_request", "The rewritten model cannot be sent in the path");
          upstream = rebuilt;
        } else if (location.in === "body" || location.in === "form") {
          body[location.field] = model;
          bodyModelChanged = true;
        }
      }
      // Read, never judged: a service mode is never refused (`./meter.ts`).
      const mode = requestedServiceMode(description, connection.baseUrl, body);

      // The output cap refuses on its own, so it runs before admission: a request
      // it refuses must not spend a request limit or the plan allowance. Only a
      // JSON body has one; a form is an upload with no output to cap.
      const capped = parsed.kind === "json" && applyOutputCap(operation, body, routing.max_output_tokens);
      const metered = parsed.kind === "json" && requestStreamUsage(operation, body);
      // A transcription is only sent in a format whose answer can be priced.
      const format = parsed.kind === "form" ? meteredTranscriptionFormat(operation, description, parsed.fields) : null;
      const location = operation.model;
      const formChanges: Record<string, string> = {};
      if (format !== null) formChanges.response_format = format;
      if (parsed.kind === "form" && bodyModelChanged && location.in !== "path" && location.in !== "fixed" && location.in !== "query") {
        formChanges[location.field] = model;
      }

      // An untouched body is sent as the client's own bytes, with its own content
      // type. A changed form is sent as a new form, so fetch writes a fresh
      // boundary. Built before admission: a form that cannot be rebuilt is
      // refused before it spends anything.
      const sent: OutgoingBody =
        parsed.kind === "json"
          ? {
              bytes: capped || metered || bodyModelChanged ? new TextEncoder().encode(JSON.stringify(body)) : bytes,
              contentType: "application/json",
            }
          : Object.keys(formChanges).length > 0
            ? { form: await withFields(parsed.form ?? bytes, contentType, formChanges), contentType: null }
            : { bytes, contentType };

      // The key is opened before admission: a request that cannot be sent must not spend anything.
      const secret = await connectionSecret(c.env, connection);

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
        reportsCost: reportsCost(operation),
        requestedMode: mode.mode,
        ...(mode.unknown !== undefined ? { requestedModeUnknown: mode.unknown } : {}),
        startedAt,
        appVersion: caller.appVersion,
        clientTraceId: caller.clientTraceId,
      };
      return await sendAttempts(c, strippedHeaders(app, caller), [
        {
          connection,
          description,
          operation,
          hostKey: upstream.host,
          path: upstream.path,
          query: sanitizedQuery(url),
          secret: () => Promise.resolve(secret),
          body: () => sent,
          attempt,
        },
      ]);
    },
  );
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
  | {
      readonly kind: "form";
      readonly fields: ReadonlyMap<string, readonly FieldValue[]>;
      /** The form parsed whole, where the fast scanner could not read it. */
      readonly form?: FormData;
    };

/** What is sent upstream: the bytes with their content type, or a form fetch encodes itself. */
export type OutgoingBody =
  | { readonly bytes: Uint8Array; readonly contentType: string; readonly form?: undefined }
  | { readonly form: FormData; readonly contentType: null; readonly bytes?: undefined };

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
    if (location.in === "path" && operation.style !== "openai-transcription") {
      return { kind: "form", fields: new Map() };
    }
    const boundary = multipartBoundary(contentType);
    const modelField = location.in === "body" || location.in === "form" ? location.field : null;
    const wanted = new Set(["response_format", ...description.serviceModes.flatMap((field) => field.names)]);
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
  if (operation.style === "openai-transcription" && description.transcriptionFormats !== undefined) {
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
): Promise<FormData> {
  const form = source instanceof FormData ? source : await parseForm(source, contentType);
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
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
  const formats = description.transcriptionFormats;
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

export function requestModel(operation: OperationDescription, body: Record<string, unknown>, parts: Parts): string {
  const location = operation.model;
  if (location.in === "fixed") return location.model;
  if (location.in === "path") {
    const value = Object.hasOwn(parts, location.part) ? parts[location.part] : undefined;
    if (value === undefined || value.trim() === "") throw new GatewayError(400, "invalid_request", "Request path must name a model");
    return value;
  }
  if (location.in === "query") throw new GatewayError(500, "internal_error", "This operation's model location is not served yet");
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
export function strippedHeaders(app: AppRecord, caller: Caller): readonly string[] {
  return [caller.credentialHeader, ...clientAuth(app).consumedHeaders, DEFAULT_END_USER_HEADER];
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
   * Opens the connection's key. The first attempt's is opened before
   * admission, so a request whose key cannot be opened is refused before it
   * spends anything; a fallback's only when the chain reaches it.
   */
  readonly secret: () => Promise<string>;
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
 *   proxy's own 120 s: a fallback gets what is left of it.
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
    if (deadline !== undefined && deadline - Date.now() <= 0) {
      if (previous !== null) retire(c, previous);
      throw budgetExhausted(index);
    }
    let secret: string;
    try {
      secret = await withinMs(prepared.secret(), deadline === undefined ? PROVIDER_TTFB_TIMEOUT_MS : deadline - Date.now());
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
    // Only now is a fallback really sent: the failed answer before it is charged and let go.
    if (previous !== null) {
      retire(c, previous);
      previous = null;
    }
    const body = prepared.body();
    const headers = upstreamHeaders(c.req.raw.headers);
    for (const name of stripped) headers.delete(name);
    for (const [name, value] of Object.entries(prepared.defaultHeaders ?? {})) {
      if (!headers.has(name)) headers.set(name, value);
    }
    // A JSON body is sent as JSON whatever type the client named, as v1. An
    // untouched form keeps the client's type and boundary; a changed one gets
    // the type fetch writes for it.
    if (body.contentType === null) headers.delete("content-type");
    else headers.set("content-type", body.contentType);
    // A callback, so a key containing `$&` or `$1` is sent as it is.
    headers.set(description.auth.header, description.auth.format.replace("{key}", () => secret));
    const origin = upstreamOrigin(connection, description, prepared.hostKey);
    const url = `${origin}${prepared.path.replace(/^\//u, "")}${prepared.query}`;

    // Checked just before each fetch: nothing is sent for an app that went
    // away. The app's own signal is never passed to the provider, so an
    // answer already on its way is read to the end and charged.
    if (clientGone(c)) {
      throw new GatewayError(502, "provider_error", "The app went away before the request was sent");
    }
    const providerStart = Date.now();
    deadline ??= providerStart + PROVIDER_TTFB_TIMEOUT_MS;
    const remainingMs = deadline - providerStart;
    if (remainingMs <= 0) throw budgetExhausted(index);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);
    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: c.req.method,
        headers,
        body: body.form ?? (body.bytes as Uint8Array<ArrayBuffer>),
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
        const reading = ok ? readResponse(body, contentType, upstream.headers, description, operation) : null;
        const usage = reading?.usage ?? null;
        // A stream is whole once its style's closing event arrived, even if the
        // app went away right after. One that ended without it was cut short,
        // however it ended. A style with no closing event, and an answer that
        // is not a stream, are whole when they were read to the end.
        const closed =
          ok && operation.style !== undefined && contentType.toLowerCase().includes("text/event-stream")
            ? streamClosed(body, operation.style)
            : null;
        const cut = closed === true ? false : closed === false || body.clientAborted || body.upstreamFailed;
        const served = servedServiceMode(description, attempt.requestedMode, usage, upstream.headers);
        const outcome: AttemptOutcome = ok
          ? {
              // A stream the provider broke, or ended early, is a failed attempt, not one the app left.
              status: !cut ? "ok" : body.clientAborted ? "client_aborted" : "network_error",
              httpStatus: upstream.status,
              errorCode: null,
              usage,
              providerCostUsd: reading?.providerCostUsd ?? null,
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

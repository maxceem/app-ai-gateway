/**
 * Presets: `POST /v2/apps/{app}/presets/{slug}` (plan section 4.4, D13), v1's
 * custom endpoints.
 *
 * The app sends only its request's own content. The preset names the
 * provider connection, the operation, the model, fixed parameters and an
 * output cap, and a fallback chain of more connections and models to try.
 *
 * In order:
 *
 * 1. The caller is checked as on the proxy (`serveCaller`).
 * 2. The body is read once. A JSON body gets the preset's `params` merged in,
 *    winning over the app's values. A transcription is a multipart upload,
 *    and so may an image edit be; an upload is parsed whole once, and each
 *    attempt sets its own model in it. Every other API takes JSON only.
 * 3. Each target of the chain becomes an attempt. The first must work: a
 *    missing connection, an operation it cannot serve or a key that cannot
 *    be opened is refused, before anything is spent (a fallback's key is
 *    opened only when the chain reaches it); a
 *    model whose price has gone since the preset was saved is served and
 *    priced later. A fallback that cannot work is left out of the chain. A
 *    disabled first connection is a pause: the chain goes on to its
 *    fallbacks, and only with none left is it refused.
 * 4. The request is admitted once, for the whole chain.
 * 5. The attempts are sent in order (`sendAttempts`): a target that gets no
 *    answer, a 429 or a 5xx is followed by the next. Every attempt is one
 *    charge; a failed one costs nothing.
 *
 * A preset's models are its own: the app's model rewrites do not apply.
 * The client's query is never sent upstream, except Gemini's `alt=sse`,
 * which picks its streaming method (v1).
 */
import { assertAppActive, loadApp } from "../apps/app-records.ts";
import { PRESET_SLUG_PATTERN, type Preset, type PresetFallback } from "../contracts/app-config.ts";
import { GatewayError } from "../core/errors.ts";
import { timeOrderedId } from "../core/ids.ts";
import { log } from "../core/log.ts";
import { admitRequest } from "../limits/admission.ts";
import { billing, priceSources } from "../pricing/billability.ts";
import {
  connectionCredentials,
  connectionDescription,
  loadConnection,
  type ConnectionRecord,
  type UpstreamCredentials,
} from "../providers/connections.ts";
import type { ApiStyle, OperationDescription, ProviderDescription } from "../providers/operation.ts";
import { attemptCopy, declaredOperation, presetOperation, presetUpstream, streamingSibling } from "../providers/presets.ts";
import type { CallAttempt } from "./call-charge.ts";
import { judgedAlternatives } from "./alternatives.ts";
import { requestedServiceMode } from "./meter.ts";
import { applyOutputCap, pinServingProviders, refuseBackground, requestStreamUsage } from "./policy.ts";
import { priceKeyValues, removeOutbound, requestUsage } from "./request-fields.ts";
import {
  jsonBody,
  meteredTranscriptionFormat,
  parseForm,
  refusal,
  sendAttempts,
  serveCaller,
  strippedHeaders,
  type Caller,
  type OutgoingBody,
  type PreparedAttempt,
  type ProxyContext,
} from "./serve.ts";

/** Headers an API needs that a client calling a preset may not know to send (v1's `requiredHeaders`). */
const STYLE_HEADERS: Partial<Record<ApiStyle, Readonly<Record<string, string>>>> = {
  "anthropic-messages": { "anthropic-version": "2023-06-01" },
};

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Merges the preset's parameters over the app's body; the preset's values win, nested objects merged (v1). */
export function deepMerge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    // `__proto__` would set the prototype instead of storing a key.
    if (key === "__proto__") continue;
    const current = Object.hasOwn(result, key) ? result[key] : undefined;
    result[key] = plainObject(current) && plainObject(value) ? deepMerge(current, value) : value;
  }
  return result;
}

/** The request as read once: a JSON body with the preset's parameters in, or an upload. */
type PresetBody = { readonly kind: "json"; readonly body: Record<string, unknown> } | { readonly kind: "form"; readonly form: FormData };

/** Whether an operation's API takes an upload besides JSON: an image edit. Only these accept a form (transcription always takes one). */
function takesUpload(operation: OperationDescription): boolean {
  return operation.style === "openai-images" && operation.match.path.endsWith("images/edits");
}

async function presetBody(caller: Caller, contentType: string, preset: Preset, style: ApiStyle, operation: OperationDescription): Promise<PresetBody> {
  const bytes = await caller.readBody();
  if (style === "openai-transcription") {
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      throw new GatewayError(400, "invalid_request", "This preset takes a multipart/form-data upload");
    }
    // Parsed whole, as v1 does: each attempt sets its own model in it.
    const form = await parseForm(bytes, contentType);
    if (!form.has("file")) throw new GatewayError(400, "invalid_request", "A file field is required");
    return { kind: "form", form };
  }
  // An image edit may be an upload too, sent as a form, each attempt setting
  // its own model in it; `params` merge into JSON only. Any other API is
  // JSON, so its output cap and background checks always apply.
  if (takesUpload(operation) && contentType.toLowerCase().startsWith("multipart/form-data")) {
    return { kind: "form", form: await parseForm(bytes, contentType) };
  }
  return { kind: "json", body: deepMerge(jsonBody(bytes), preset.params ?? {}) };
}

/** A copy of an upload, so each attempt can set its own fields. Files are shared, not copied. */
function copyForm(form: FormData): FormData {
  const copy = new FormData();
  for (const [name, value] of form) copy.append(name, value);
  return copy;
}

/** A form's text fields for the readers, first value of each. */
function formText(form: FormData): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [name, value] of form) {
    if (typeof value === "string" && !Object.hasOwn(record, name)) record[name] = value;
  }
  return record;
}

/** Why a target cannot be an attempt. On the first target it is the answer; on a fallback, it is left out. */
class TargetProblem extends Error {
  constructor(readonly error: GatewayError) {
    super(error.message);
  }
}

interface TargetInput {
  readonly slug: string;
  readonly caller: Caller;
  readonly preset: Preset;
  readonly style: ApiStyle;
  readonly body: PresetBody;
  /** The caller asked for Gemini's stream with `?alt=sse`. */
  readonly streaming: boolean;
  readonly connection: ConnectionRecord;
  readonly description: ProviderDescription;
  readonly credentials: () => Promise<UpstreamCredentials>;
  readonly target: Pick<PresetFallback, "operation" | "model">;
  /** The chain's first target, which is served even when its price has gone since the preset was saved. */
  readonly primary: boolean;
  readonly requestId: string;
  readonly seq: number;
  readonly startedAt: number;
}

/** One target of the chain as an attempt ready to send, or a `TargetProblem`. */
function targetAttempt(input: TargetInput): PreparedAttempt {
  const { connection, description, target, preset, style } = input;
  const chosen = presetOperation(description, style, target.operation);
  if (chosen === null) {
    throw new TargetProblem(
      new GatewayError(502, "provider_unavailable", `Provider connection ${connection.slug} cannot serve this preset's ${style} requests`),
    );
  }
  const operation: OperationDescription = (input.streaming && streamingSibling(description, chosen)) || chosen;
  const model = target.model;
  const bill = billing(operation, priceSources(connection), model);
  const price = bill.price;
  // Saving checked every target's price. A first target whose price has gone
  // since is still served, and priced later (`unresolved`), as a listed model
  // on the proxy is. A fallback with none is left out.
  if (bill.problem !== null && !input.primary) {
    throw new TargetProblem(
      new GatewayError(400, "pricing_not_configured", `Model ${model} has no price that ${operation.name} can bill`, undefined, {
        data: { model, operation: operation.name },
      }),
    );
  }
  const upstream = presetUpstream(description, operation, model);
  if (upstream === null) {
    throw new TargetProblem(new GatewayError(400, "invalid_request", `Model ${model} cannot be sent in ${operation.name}'s path`));
  }
  const location = operation.model;
  let build: () => OutgoingBody;
  let fields: Record<string, unknown>;
  if (input.body.kind === "json") {
    const merged = input.body.body;
    const shaped = (): Record<string, unknown> => {
      const body = attemptCopy(merged);
      if (location.in === "body") body[location.field] = model;
      // The path names the model; the body names none, as v1.
      else delete body.model;
      // Webhook fields, and fetch fields the operation does not need, never reach the provider.
      removeOutbound(operation, body, new URLSearchParams());
      return body;
    };
    // Judged now, on a copy, so a refusal comes before admission. The body is built again when sent.
    const judged = shaped();
    refuseBackground(operation, judged);
    applyOutputCap(operation, judged, preset.max_output_tokens);
    // A preset fixes its model: another the provider could serve instead is
    // allowed only when it is that same model.
    judgedAlternatives(description, operation, judged, { allowed: [model], sources: priceSources(connection), baseUrl: connection.baseUrl });
    fields = judged;
    build = () => {
      const body = shaped();
      applyOutputCap(operation, body, preset.max_output_tokens);
      requestStreamUsage(operation, body);
      pinServingProviders(description, connection.servingProviders, body);
      return { bytes: new TextEncoder().encode(JSON.stringify(body)), contentType: "application/json" };
    };
  } else {
    const upload = input.body.form;
    const format = meteredTranscriptionFormat(
      operation,
      description,
      new Map([["response_format", upload.getAll("response_format").map((value) => (typeof value === "string" ? value : null))]]),
    );
    fields = { ...formText(upload), ...(location.in === "form" || location.in === "body" ? { [location.field]: model } : {}) };
    build = () => {
      const form = copyForm(upload);
      if (location.in === "form" || location.in === "body") form.set(location.field, model);
      if (format !== null) form.set("response_format", format);
      return { form, contentType: null };
    };
  }
  const mode = requestedServiceMode(description, connection.baseUrl, fields, model);
  // What the meter takes from the request, and the values its rates depend on, as on the proxy.
  const requestFields = { body: fields, query: new URLSearchParams() };
  const measured = requestUsage(operation, requestFields);
  const priceKeys = priceKeyValues(operation, requestFields);
  const attempt: CallAttempt = {
    requestId: input.requestId,
    seq: input.seq,
    accountId: connection.accountId,
    appId: input.caller.identity.appId,
    identity: input.caller.identity,
    providerType: connection.type,
    connectionId: connection.id,
    providerSlug: connection.slug,
    operation: operation.name,
    model,
    preset: input.slug,
    price,
    reportsCost: bill.reportsCost,
    requestedMode: mode.mode,
    ...(mode.unknown !== undefined ? { requestedModeUnknown: mode.unknown } : {}),
    startedAt: input.startedAt,
    appVersion: input.caller.appVersion,
    clientTraceId: input.caller.clientTraceId,
    ...(measured !== null ? { requestUsage: measured } : {}),
    ...(priceKeys !== undefined ? { priceKeys } : {}),
  };
  const defaultHeaders = operation.style === undefined ? undefined : STYLE_HEADERS[operation.style];
  return {
    connection,
    description,
    operation,
    hostKey: upstream.host,
    path: upstream.path,
    // Gemini's streaming method takes `alt=sse`, whenever the caller asked for it.
    query: input.streaming && operation.match.path.endsWith(":streamGenerateContent") ? "?alt=sse" : "",
    credentials: input.credentials,
    body: build,
    attempt,
    ...(defaultHeaders === undefined ? {} : { defaultHeaders }),
  };
}

export async function presetHandler(c: ProxyContext): Promise<Response> {
  const startedAt = Date.now();
  const appId = c.req.param("app");
  if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
  const slug = c.req.param("slug") ?? "";
  const app = await loadApp(c.env, appId);
  assertAppActive(app);
  // Only a preset the app has is looked up further, as on the proxy.
  const preset = PRESET_SLUG_PATTERN.test(slug) && Object.hasOwn(app.presets, slug) ? app.presets[slug] : undefined;
  const first = preset === undefined ? null : await loadConnection(c.env, app.accountId, preset.provider);
  const firstDescription = first === null ? null : connectionDescription(first);

  return serveCaller(
    c,
    {
      app,
      startedAt,
      providerSlug: preset?.provider ?? slug,
      ...(firstDescription === null ? {} : { providerAuthHeader: firstDescription.auth.header }),
    },
    async (caller) => {
      if (preset === undefined) throw new GatewayError(404, "preset_not_found", `This app has no preset ${slug}`);
      caller.facts.operation = preset.operation;
      caller.facts.model = preset.model;
      const declared = declaredOperation(preset.operation);
      const style = declared?.style;
      if (declared === null || style === undefined) {
        throw new GatewayError(502, "provider_unavailable", `The preset's operation ${preset.operation} is not served`);
      }
      const body = await presetBody(caller, c.req.header("content-type") ?? "", preset, style, declared);
      const streaming = style === "gemini-generate" && new URL(c.req.url).searchParams.get("alt") === "sse";
      const requestId = timeOrderedId(startedAt);

      const targets: (Pick<PresetFallback, "provider" | "operation" | "model">)[] = [
        { provider: preset.provider, operation: preset.operation, model: preset.model },
        ...(preset.fallback ?? []),
      ];
      const connections = new Map<string, ConnectionRecord | null>([[preset.provider, first]]);
      const attempts: PreparedAttempt[] = [];
      let paused: GatewayError | null = null;
      for (const [index, target] of targets.entries()) {
        const primary = index === 0;
        try {
          let connection = connections.get(target.provider);
          if (connection === undefined) {
            connection = await loadConnection(c.env, app.accountId, target.provider);
            connections.set(target.provider, connection);
          }
          const description = connection === null ? null : connectionDescription(connection);
          if (connection === null || description === null) {
            throw new TargetProblem(
              new GatewayError(502, "provider_not_configured", `No provider connection ${target.provider} is set up for this app`),
            );
          }
          if (connection.status === "disabled") {
            const error = new GatewayError(502, "provider_disabled", `Provider connection ${target.provider} is disabled`);
            // Disabling is a deliberate pause: the chain goes on to its fallbacks.
            if (primary) paused = error;
            continue;
          }
          // The first target's key is opened before admission, so one that
          // cannot be opened is refused before anything is spent, as v1. A
          // fallback's is opened only when the chain reaches it.
          const opened = primary ? await connectionCredentials(c.env, connection) : null;
          const open = connection;
          const credentials = opened !== null ? () => Promise.resolve(opened) : () => connectionCredentials(c.env, open);
          attempts.push(
            targetAttempt({
              slug,
              caller,
              preset,
              style,
              body,
              streaming,
              connection,
              description,
              credentials,
              target,
              primary,
              requestId,
              seq: index + 1,
              startedAt,
            }),
          );
        } catch (error) {
          const problem = error instanceof TargetProblem ? error.error : error;
          if (primary) throw problem;
          // A fallback is left out either because it cannot work (its
          // connection, operation or price: the save that wrote it checked
          // them), or because it refuses this request (a background option,
          // an output field over the cap, a transcription format). Logged
          // apart, so the monitor alerts on the first only.
          const refusedRequest = !(error instanceof TargetProblem) && problem instanceof GatewayError && problem.status < 500;
          log("warn", refusedRequest ? "preset_fallback_refused_request" : "preset_fallback_skipped", {
            app: app.id,
            preset: slug,
            providerSlug: target.provider,
            code: problem instanceof GatewayError ? problem.code : "internal_error",
          });
        }
      }
      const [head, ...rest] = attempts;
      if (head === undefined) {
        throw paused ?? new GatewayError(502, "provider_not_configured", "No provider connection of this preset can serve it");
      }

      await admitRequest({
        env: c.env,
        app,
        identity: caller.identity,
        waitUntil: (promise) => c.executionCtx.waitUntil(promise),
        refuse: refusal,
      });
      return await sendAttempts(c, strippedHeaders(app, caller), [head, ...rest]);
    },
  );
}


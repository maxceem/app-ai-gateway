import { publishesStylePaths, supportsEndpointStyle } from "../providers/capability-matrix";
import { GatewayError } from "../core/errors";
import { catalogKind, isBillable } from "../usage/pricing";
import {
  requireProvider,
  resolveProvider,
  type ResolvedProvider,
} from "../providers/provider-store";
import { clampStyleFor, PROTOCOLS } from "../providers/protocols";
import { providerDescriptor, type ProviderType } from "../shared/providers";
import { routeWireModel } from "../providers/route-adapters";
import { lookup } from "../shared/records";
import type { ExecutionAttempt } from "./plan";
import { refuseDetachedJob, sanitizedHeaders, unpricedMessage, type PreparedProxyRequest } from "./proxy-rules";
import {
  finishJsonBody,
  formWithModel,
  meteredTranscriptionFormat,
  unmeteredTranscriptionFormat,
  isMultipart,
  jsonObject,
  parseForm,
} from "../providers/request-body";
import type { AppRecord, EndpointTarget } from "../core/types";
import { API_STYLE_PATHS, type EndpointApiStyle, type ProviderRoute } from "../shared/capabilities";
import { endpointKind, type EndpointConfig } from "../shared/app-config";
import { servesKind } from "../shared/model-kinds";

/**
 * A custom endpoint is fully described by server configuration, so the gateway
 * builds the upstream request itself instead of forwarding a client-chosen
 * provider path. Everything that does not depend on the selected target is
 * prepared once; a fallback attempt only swaps provider, model, and URL.
 */
export interface PreparedEndpointRequest {
  slug: string;
  endpoint: EndpointConfig;
  targets: EndpointTarget[];
  headers: Headers;
  /** Present for a JSON style; the model is set per attempt. */
  json: Record<string, unknown> | null;
  /** Present for a multipart style; the model field is set per attempt. */
  form: FormData | null;
  /**
   * Whether the client asked for a stream the way an API that streams by URL
   * spells it (Gemini's `alt=sse`), which picks the streaming method upstream.
   * Always false for an API that streams by a body field instead.
   */
  urlStream: boolean;
}

/**
 * The path template a custom endpoint of this style posts to on one route: the
 * style's one path where the route publishes a layout of its own, and the
 * provider's own path from the descriptor that declares it everywhere else.
 * The key set of `endpointPaths` *is* the type's endpoint capability, and a
 * gateway only narrows it, so a missing path means the capability matrix
 * already refused this pairing: reaching here is a bug in this deployment, not
 * a caller's mistake.
 */
export function endpointProviderPath(
  style: EndpointApiStyle,
  provider: ProviderType,
  route: ProviderRoute = "direct",
): string {
  const path = publishesStylePaths(route, provider)
    ? API_STYLE_PATHS[style as keyof typeof API_STYLE_PATHS]
    : providerDescriptor(provider).endpointPaths?.[style];
  if (path === undefined) {
    throw new GatewayError(
      500,
      "internal_error",
      `Provider type ${provider} composes no ${style} endpoint on ${route}`,
    );
  }
  return path;
}

/**
 * Where one attempt posts: the route's path with the wire model in place of a
 * `{model}` segment, switched to the streaming method where the client asked
 * for a stream by URL, and the query that method takes. `modelInPath` says the
 * API names its model in the URL, as Gemini's methods do, and so takes none in
 * the body.
 */
function attemptTarget(
  prepared: PreparedEndpointRequest,
  resolved: ResolvedProvider,
  wireModel: string,
): { path: string; query: string; modelInPath: boolean } {
  const template = endpointProviderPath(prepared.endpoint.api_style, resolved.type, resolved.route.kind);
  const modelInPath = template.includes("{model}");
  const path = template.replace("{model}", encodeURIComponent(wireModel));
  const streaming = PROTOCOLS[prepared.endpoint.api_style].urlStreaming;
  if (!prepared.urlStream || !streaming) return { path, query: "", modelInPath };
  return { path: path.replace(streaming.from, streaming.to), query: `?${streaming.query}`, modelInPath };
}

/** Whether the client's own query asks for every parameter `query` names. */
function asksFor(request: Request, query: string): boolean {
  const asked = new URL(request.url).searchParams;
  return [...new URLSearchParams(query)].every(([name, value]) => asked.get(name) === value);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-merges server configuration over a client body. Server values win. */
export function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    // `__proto__` would be a prototype assignment rather than a stored key, and
    // `result["constructor"]` would read one from Object.prototype.
    if (key === "__proto__") continue;
    const current = lookup(result, key);
    result[key] = plainObject(current) && plainObject(value)
      ? deepMerge(current, value)
      : value;
  }
  return result;
}

export function endpointTargets(endpoint: EndpointConfig): EndpointTarget[] {
  return [
    { provider: endpoint.provider, model: endpoint.model },
    ...(endpoint.fallback ?? []),
  ];
}

/** Builds the concrete upstream request for one target in the fallback chain. */
export function endpointAttemptRequest(
  prepared: PreparedEndpointRequest,
  target: EndpointTarget,
  /** The row this attempt resolved to; its route owns the wire model. */
  resolved: ResolvedProvider,
): Pick<PreparedProxyRequest, "body" | "headers" | "query"> {
  const provider = resolved.type;
  const route = resolved.route;
  // The configured model is canonical, so it is what gets priced and recorded;
  // only the body the upstream reads carries the route's namespace.
  const wireModel = routeWireModel(route, provider, target.model);
  const { query, modelInPath } = attemptTarget(prepared, resolved, wireModel);
  let body: BodyInit;
  if (prepared.form) {
    const form = formWithModel(prepared.form, wireModel);
    // The plan already dropped a target no format could price this for.
    const format = meteredTranscriptionFormat(provider, form);
    if (format && format !== "refuse") form.set("response_format", format.send);
    body = form;
  } else {
    const json: Record<string, unknown> = { ...prepared.json };
    if (modelInPath) delete json.model;
    else json.model = wireModel;
    // The endpoint's own style is the contract, so it names the protocol
    // rather than anything sniffed off a path.
    const protocol = PROTOCOLS[prepared.endpoint.api_style];
    finishJsonBody(json, {
      provider,
      route,
      style: protocol.style,
      clamp: clampStyleFor(protocol, provider),
      cap: prepared.endpoint.max_output_tokens,
    });
    body = JSON.stringify(json);
  }
  return {
    body,
    headers: prepared.headers,
    // The endpoint URL is a gateway contract, not a provider path, so client
    // query parameters are never forwarded upstream; only a streaming method's
    // own query is, and only where the client asked for that stream.
    query,
  };
}

/**
 * The fallback chain as attempts, with every target that cannot serve this
 * endpoint dropped.
 *
 * Every target needs its own credential, because a fallback may point at a
 * different provider. The primary target must work; a fallback the
 * organization has not configured, cannot decrypt, or cannot price is simply
 * dropped from the chain rather than turned into a request that is certain to
 * fail. Resolution itself can throw — an unreadable secret, or a gateway that
 * was revoked out from under the row — and on a fallback that is still just a
 * reason to skip it.
 *
 * A *disabled* primary is the one exception: disabling is a deliberate pause,
 * so the chain falls through to its fallbacks exactly as an upstream failure
 * would. Only when no fallback survives does the pause itself get reported.
 */
export async function resolveEndpointAttempts(
  env: Env,
  app: AppRecord,
  endpoint: EndpointConfig,
  prepared: PreparedEndpointRequest,
): Promise<[ExecutionAttempt, ...ExecutionAttempt[]]> {
  const resolvedProviders = new Map<string, ResolvedProvider>();
  const usableTargets: typeof prepared.targets = [];
  let disabledPrimary: GatewayError | undefined;
  for (const [index, target] of prepared.targets.entries()) {
    const primary = index === 0;
    let entry = resolvedProviders.get(target.provider);
    if (!entry) {
      let found: ResolvedProvider | null;
      try {
        found = primary
          ? await requireProvider(env, app.organizationId, target.provider)
          : await resolveProvider(env, app.organizationId, target.provider);
      } catch (error) {
        if (primary) {
          if (error instanceof GatewayError && error.code === "provider_disabled") {
            disabledPrimary = error;
            continue;
          }
          throw error;
        }
        continue;
      }
      if (!found) continue;
      entry = found;
      resolvedProviders.set(target.provider, entry);
    }
    if (!supportsEndpointStyle(entry.route.kind, entry.type, endpoint.api_style)) {
      if (primary) {
        throw new GatewayError(
          502,
          "provider_unavailable",
          `Provider instance ${target.provider} does not support ${endpoint.api_style} endpoints`,
        );
      }
      continue;
    }
    // A model of another kind is configuration that drifted from the catalog;
    // the save that wrote it checked, so a fallback is simply dropped.
    const kind = endpointKind(endpoint);
    const modelKind = catalogKind(entry.type, target.model, entry.pricing);
    if (!servesKind(modelKind, kind)) {
      if (primary) {
        throw new GatewayError(
          502,
          "provider_unavailable",
          `Model ${target.model} is a ${modelKind} model, which a ${kind} endpoint cannot serve`,
        );
      }
      continue;
    }
    // A transcription this target would answer in plain text cannot be priced,
    // which is the same as no price at all.
    if (prepared.form && meteredTranscriptionFormat(entry.type, prepared.form) === "refuse") {
      if (primary) throw unmeteredTranscriptionFormat(entry.type);
      continue;
    }
    if (!isBillable(entry.type, entry.route.kind, endpoint.api_style, target.model, entry.pricing)) {
      if (primary) {
        throw new GatewayError(
          400,
          "pricing_not_configured",
          unpricedMessage(entry.type, target.model),
        );
      }
      continue;
    }
    usableTargets.push(target);
  }
  // A skipped disabled primary is the only way the chain can end up empty: on
  // every other primary failure the loop threw above. With nothing left to try,
  // the pause is the answer.
  if (usableTargets.length === 0 && disabledPrimary) throw disabledPrimary;

  const attempts = usableTargets.map((target) => {
    const resolved = resolvedProviders.get(target.provider);
    if (!resolved) throw new Error(`Resolved provider missing for ${target.provider}`);
    const buildRequest = () => endpointAttemptRequest(prepared, target, resolved);
    const wireModel = routeWireModel(resolved.route, resolved.type, target.model);
    return {
      resolved,
      providerPath: attemptTarget(prepared, resolved, wireModel).path,
      model: target.model,
      // The endpoint's own style settles the API, so the answer is read by the
      // reader for the contract this gateway composed rather than a guess.
      apiStyle: endpoint.api_style,
      buildRequest,
    } satisfies ExecutionAttempt;
  });
  const first = attempts[0];
  if (!first) throw disabledPrimary ?? new Error("Endpoint execution plan is empty");
  // Validate and materialize the primary before admission. Fallback builders
  // stay lazy so a multipart upload is copied only for targets actually tried.
  const primaryRequest = first.buildRequest();
  const primary: ExecutionAttempt = { ...first, buildRequest: () => primaryRequest };
  return [primary, ...attempts.slice(1)];
}

export async function prepareEndpointRequest(input: {
  request: Request;
  /** The body, read once by the caller; see `PrepareInput.body`. */
  body: () => Promise<Uint8Array<ArrayBuffer>>;
  app: AppRecord;
  slug: string;
  endpoint: EndpointConfig;
  tokenHeader: string;
}): Promise<PreparedEndpointRequest> {
  const bytes = await input.body();
  const headers = sanitizedHeaders(input.request, input.app, input.tokenHeader);
  const contentType = input.request.headers.get("content-type") ?? "";
  const protocol = PROTOCOLS[input.endpoint.api_style];
  for (const [name, value] of Object.entries(protocol.requiredHeaders ?? {})) {
    if (!headers.has(name)) headers.set(name, value);
  }
  const urlStream = protocol.urlStreaming !== undefined && asksFor(input.request, protocol.urlStreaming.query);

  if (protocol.body === "multipart") {
    if (!isMultipart(contentType)) {
      throw new GatewayError(
        400,
        "invalid_request",
        "This endpoint expects a multipart/form-data transcription request",
      );
    }
    const form = await parseForm(bytes, contentType);
    if (!form.has("file")) {
      throw new GatewayError(400, "invalid_request", "A file field is required");
    }
    // Dropped so fetch generates the boundary for the rebuilt form.
    headers.delete("content-type");
    return {
      slug: input.slug,
      endpoint: input.endpoint,
      targets: endpointTargets(input.endpoint),
      headers,
      json: null,
      form,
      urlStream,
    };
  }

  const merged = deepMerge(jsonObject(bytes), input.endpoint.params ?? {});
  refuseDetachedJob(merged);
  headers.set("content-type", "application/json");
  return {
    slug: input.slug,
    endpoint: input.endpoint,
    targets: endpointTargets(input.endpoint),
    headers,
    json: merged,
    form: null,
    urlStream,
  };
}

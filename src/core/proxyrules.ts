import type { GatewayRouteConfig, ProviderGatewayType, ProviderPricing } from "../db/schema";
import { apiStyleFromPath, outputClampStyle, type ApiStyle } from "./api-styles";
import {
  assertApiStyleSupported,
  routeWireModel,
  type ProviderRoute,
} from "./capabilities";
import { GatewayError } from "./errors";
import { GATEWAY_ADAPTERS, gatewayBodyMutation, gatewayUpstream } from "./gateways";
import type { ResolvedProvider } from "./provider-store";
import {
  PROVIDER_REGISTRY,
  PROVIDER_TYPES,
  providerAuthValue,
  providerRequestHeaders,
  reportsCost,
} from "./providers";
import { lookup } from "./records";
import { isBillable } from "./usage";
import type {
  AllowedPath,
  AllowedPathConfig,
  AppConfig,
  OutputClampStyle,
  ProviderType,
  ProviderProxyConfig,
} from "./types";

export const MAX_REQUEST_BYTES = 20 * 1024 * 1024;
const UNRESTRICTED_PROVIDER: ProviderProxyConfig = {
  allowed_paths: [],
  allowed_models: [],
};

export interface PreparedProxyRequest {
  provider: ProviderType;
  providerPath: string;
  /**
   * The canonical model: what was priced, what the allowlist judged, and what
   * the usage event records. The route may put a different string on the wire.
   */
  model: string;
  body: BodyInit | null;
  headers: Headers;
  query: string;
}

/**
 * Entering a price *is* the explicit allowance for a model, so the message has
 * to say exactly where to enter it.
 */
export function unpricedMessage(provider: ProviderType, model: string): string {
  return `Model ${model} has no pricing for ${provider} — add it under custom model pricing in the provider settings`;
}

export function sanitizedQuery(request: Request): string {
  const url = new URL(request.url);
  // Provider SDKs sometimes put their API key in the query string. The gateway
  // authenticates the client separately and must never forward a client key.
  url.searchParams.delete("key");
  url.searchParams.delete("api_key");
  return url.search;
}

export async function readBodyLimited(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared && Number.parseInt(declared, 10) > MAX_REQUEST_BYTES) {
    throw new GatewayError(413, "payload_too_large", "Request body exceeds 20 MB");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new GatewayError(413, "payload_too_large", "Request body exceeds 20 MB");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function pathPattern(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("{model}").map(escapeRegex).join("([^/]+)")}$`, "u");
}

interface MatchedPath {
  entry: AllowedPathConfig;
  modelFromPath?: string;
}

function normalizedPath(entry: AllowedPath): AllowedPathConfig {
  return typeof entry === "string" ? { path: entry } : entry;
}

function modelIsAllowed(allowedModels: string[], requestedModel: string): boolean {
  return allowedModels.length === 0 || allowedModels.includes(requestedModel);
}

function matchedPath(provider: ProviderType, path: string, allowed: AllowedPath[]): MatchedPath | null {
  if (allowed.length === 0) {
    if (provider === "gemini") {
      // Native Gemini generation requests carry the model in the URL rather
      // than the JSON body, so unrestricted paths still need a model capture.
      const nativeMatch = path.match(
        /^(v1(?:alpha|beta)?\/models\/)([^/]+)(:(?:stream)?generateContent)$/u,
      );
      if (nativeMatch?.[2]) {
        return {
          entry: { path: `${nativeMatch[1]}{model}${nativeMatch[3]}` },
          modelFromPath: decodeURIComponent(nativeMatch[2]),
        };
      }
    }
    return { entry: { path } };
  }
  for (const rawEntry of allowed) {
    const entry = normalizedPath(rawEntry);
    const match = path.match(pathPattern(entry.path));
    if (match) return { entry, ...(match[1] ? { modelFromPath: decodeURIComponent(match[1]) } : {}) };
  }
  return null;
}

export function jsonObject(bytes: Uint8Array): Record<string, unknown> {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not object");
    return value as Record<string, unknown>;
  } catch {
    throw new GatewayError(400, "invalid_request", "Request body must be a JSON object");
  }
}

function validateOutputCap(
  body: Record<string, unknown>,
  key: string,
  cap: number,
  field = key,
): boolean {
  if (!Object.hasOwn(body, key)) return false;
  if (typeof body[key] === "number" && body[key] > cap) {
    throw new GatewayError(
      403,
      "max_output_tokens_exceeded",
      `Request ${field} exceeds the configured max_output_tokens cap of ${cap}`,
    );
  }
  return true;
}

export function validateOrInjectOutputCap(
  style: OutputClampStyle,
  provider: ProviderType,
  body: Record<string, unknown>,
  cap: number | undefined,
): boolean {
  if (cap === undefined || style === "none") return false;
  if (style === "anthropic") {
    if (validateOutputCap(body, "max_tokens", cap)) return false;
    body.max_tokens = cap;
    return true;
  }
  if (style === "gemini_native") {
    const currentConfig = body.generationConfig;
    const generationConfig =
      typeof currentConfig === "object" && currentConfig !== null && !Array.isArray(currentConfig)
        ? (currentConfig as Record<string, unknown>)
        : {};
    if (
      validateOutputCap(
        generationConfig,
        "maxOutputTokens",
        cap,
        "generationConfig.maxOutputTokens",
      )
    ) {
      return false;
    }
    generationConfig.maxOutputTokens = cap;
    body.generationConfig = generationConfig;
    return true;
  }
  if (style === "chat_completions") {
    const hasMaxTokens = validateOutputCap(body, "max_tokens", cap);
    const hasMaxCompletionTokens = validateOutputCap(body, "max_completion_tokens", cap);
    if (hasMaxTokens || hasMaxCompletionTokens) return false;
    body[provider === "openai" ? "max_completion_tokens" : "max_tokens"] = cap;
    return true;
  }
  if (validateOutputCap(body, "max_output_tokens", cap)) return false;
  body.max_output_tokens = cap;
  return true;
}

/**
 * Asks a cost-reporting provider to report what a request cost, by setting the
 * documented opt-in in its own request shape. A same-protocol mutation of the
 * kind model rewrites and output caps already are, and it overrides a client's
 * `false`: the reported figure is what this route is billed on, so a client
 * must not be able to turn the meter off.
 *
 * Scoped to JSON chat-completions bodies, which is the only surface a
 * cost-reporting type is offered on. OpenRouter (the only such type today)
 * always includes `usage.cost` now and documents `usage.include` as a
 * deprecated no-op it still accepts, so this costs one ignored field and keeps
 * working if that ever stops being true.
 */
export function injectCostReport(
  provider: ProviderType,
  style: ApiStyle,
  body: Record<string, unknown>,
): boolean {
  if (!reportsCost(provider) || style !== "chat_completions") return false;
  const current = body.usage;
  const existing = typeof current === "object" && current !== null && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : null;
  if (existing?.include === true) return false;
  // Deep-set: whatever else the client put under `usage` is preserved.
  body.usage = { ...existing, include: true };
  return true;
}

/**
 * Every header the gateway itself owns, derived from both registries so the two
 * can never drift: each provider spec declares the header it authenticates
 * with and any it needs the upstream to read, each adapter declares the headers
 * its gateway reads. A client value in any of them is dropped before the
 * upstream request is built.
 */
export const RESERVED_UPSTREAM_HEADERS: readonly string[] = [
  ...new Set([
    ...PROVIDER_TYPES.flatMap((type) => [
      PROVIDER_REGISTRY[type].auth.header,
      ...Object.keys(providerRequestHeaders(type)),
    ]),
    ...Object.values(GATEWAY_ADAPTERS).flatMap((adapter) => adapter.reservedHeaders),
  ]),
];

/**
 * Strips everything the client must not influence. Provider authentication is
 * injected later by {@link providerUpstream}, once the organization's provider
 * row is resolved and the routing decision is known. Control headers inside a
 * gateway's namespace survive only if that adapter names them as client-usable;
 * {@link providerUpstream} drops even those unless the request really is routed
 * through it.
 */
export function sanitizedHeaders(
  request: Request,
  app: AppConfig,
  tokenHeader: string,
): Headers {
  const headers = new Headers(request.headers);
  const headerNames: string[] = [];
  headers.forEach((_value, name) => headerNames.push(name));
  for (const adapter of Object.values(GATEWAY_ADAPTERS)) {
    for (const name of headerNames) {
      if (name.startsWith(adapter.headerPrefix) && !adapter.clientHeaders.includes(name)) {
        headers.delete(name);
      }
    }
  }
  for (const name of [
    ...RESERVED_UPSTREAM_HEADERS,
    app.authentication.issuer?.token_header,
    tokenHeader,
    "x-end-user-id",
    "host",
    "content-length",
    "connection",
  ]) {
    if (name) headers.delete(name);
  }
  return headers;
}

export async function prepareProxyRequest(input: {
  request: Request;
  app: AppConfig;
  userId: string;
  provider: ProviderType;
  providerSlug: string;
  providerPath: string;
  /** How the resolved row reaches the provider; the matrix judges the pair. */
  route: ProviderRoute;
  /** The row's stored routing configuration, if its gateway takes one. */
  gatewayRoute?: GatewayRouteConfig | null;
  tokenHeader: string;
  /** The resolved row's per-model overrides; they win over the global catalog. */
  pricing: ProviderPricing | null;
}): Promise<PreparedProxyRequest> {
  const config = input.app.routing.providerMode === "all"
    ? UNRESTRICTED_PROVIDER
    : lookup(input.app.routing.providers, input.providerSlug);
  if (!config) throw new GatewayError(403, "path_not_allowed", "Provider is disabled for this app");
  const match = matchedPath(input.provider, input.providerPath, config.allowed_paths);
  if (!match) throw new GatewayError(403, "path_not_allowed", "Provider path is not allowed");
  const apiStyle = apiStyleFromPath(input.providerPath);
  assertApiStyleSupported(input.route, input.provider, apiStyle);

  const bytes = await readBodyLimited(input.request);
  const contentType = input.request.headers.get("content-type") ?? "";
  const isMultipart = contentType.toLowerCase().startsWith("multipart/form-data");
  const clampStyle = match.entry.clamp ?? outputClampStyle(apiStyle, input.provider);
  let requestedModel: string;
  let body: BodyInit;
  let bodyChanged = false;
  let providerPath = input.providerPath;
  const headers = sanitizedHeaders(input.request, input.app, input.tokenHeader);

  if (isMultipart) {
    let parsed: FormData | null = null;
    if (match.modelFromPath) {
      requestedModel = match.modelFromPath;
    } else {
      parsed = await new Request("https://local.invalid", {
        method: "POST",
        headers: { "content-type": contentType },
        body: Uint8Array.from(bytes).buffer,
      }).formData();
      const modelField = parsed.get("model");
      if (typeof modelField === "string" && modelField.length > 0) {
        requestedModel = modelField;
      } else if (match.entry.fixed_model) {
        requestedModel = match.entry.fixed_model;
      } else {
        throw new GatewayError(400, "invalid_request", "Request model could not be resolved");
      }
    }
    if (!modelIsAllowed(config.allowed_models, requestedModel)) {
      throw new GatewayError(403, "model_not_allowed", "Model is not allowed");
    }
    const actualModel = lookup(input.app.routing.modelRewrites, requestedModel) ?? requestedModel;
    if (!isBillable(input.provider, actualModel, input.pricing)) {
      throw new GatewayError(400, "pricing_not_configured", unpricedMessage(input.provider, actualModel));
    }
    const wireModel = routeWireModel(
      input.route,
      input.provider,
      actualModel,
      input.gatewayRoute,
    );
    if (match.modelFromPath && wireModel !== requestedModel) {
      providerPath = match.entry.path.replace("{model}", encodeURIComponent(wireModel));
      body = Uint8Array.from(bytes).buffer;
    } else if (!match.modelFromPath && !match.entry.fixed_model && wireModel !== requestedModel) {
      parsed!.set("model", wireModel);
      headers.delete("content-type");
      body = parsed!;
    } else {
      // Preserve the original multipart boundary and bytes when no rewrite is
      // needed. A fixed model is policy metadata and is never injected.
      body = Uint8Array.from(bytes).buffer;
    }
    return {
      provider: input.provider,
      providerPath,
      model: actualModel,
      body,
      headers,
      query: sanitizedQuery(input.request),
    };
  }

  const parsed = jsonObject(bytes);
  if (match.modelFromPath) {
    requestedModel = match.modelFromPath;
  } else if (typeof parsed.model === "string" && parsed.model.length > 0) {
    requestedModel = parsed.model;
  } else if (match.entry.fixed_model) {
    requestedModel = match.entry.fixed_model;
  } else {
    throw new GatewayError(400, "invalid_request", "Request model could not be resolved");
  }
  if (!modelIsAllowed(config.allowed_models, requestedModel)) {
    throw new GatewayError(403, "model_not_allowed", "Model is not allowed");
  }
  const actualModel = lookup(input.app.routing.modelRewrites, requestedModel) ?? requestedModel;
  if (!isBillable(input.provider, actualModel, input.pricing)) {
    throw new GatewayError(400, "pricing_not_configured", unpricedMessage(input.provider, actualModel));
  }
  // Everything above judged the canonical model; only the outbound request
  // speaks the route's own namespace, and only where the adapter declares one.
  const wireModel = routeWireModel(input.route, input.provider, actualModel, input.gatewayRoute);
  if (match.modelFromPath) {
    providerPath = wireModel === requestedModel
      ? input.providerPath
      : match.entry.path.replace("{model}", encodeURIComponent(wireModel));
  } else if (!match.entry.fixed_model) {
    if (wireModel !== requestedModel) {
      parsed.model = wireModel;
      bodyChanged = true;
    }
  }
  bodyChanged =
    validateOrInjectOutputCap(clampStyle, input.provider, parsed, config.max_output_tokens)
    || bodyChanged;
  bodyChanged = injectCostReport(input.provider, apiStyle, parsed) || bodyChanged;
  // The gateway's own routing directive, applied last so it wins over anything
  // a client put in the same field. Same-protocol: it steers the gateway, and
  // the provider behind it sees the payload it would have seen anyway.
  bodyChanged = gatewayBodyMutation({
    gatewayType: input.route === "direct" ? null : input.route,
    route: input.gatewayRoute ?? null,
    style: apiStyle,
    body: parsed,
  }) || bodyChanged;
  headers.set("content-type", "application/json");
  body = bodyChanged ? JSON.stringify(parsed) : new TextDecoder().decode(bytes);
  return {
    provider: input.provider,
    providerPath,
    model: actualModel,
    body,
    headers,
    query: sanitizedQuery(input.request),
  };
}

/**
 * A gateway's control headers mean something only to the gateway that reads
 * them, so every other namespace is dropped — and on a direct route, all of
 * them are: nothing in front of the provider understands any of it.
 */
function stripGatewayNamespaces(headers: Headers, routedThrough: ProviderGatewayType | null): void {
  const names: string[] = [];
  headers.forEach((_value, name) => names.push(name));
  for (const adapter of Object.values(GATEWAY_ADAPTERS)) {
    if (adapter.type === routedThrough) continue;
    for (const name of names) {
      if (name.startsWith(adapter.headerPrefix)) headers.delete(name);
    }
  }
}

/**
 * Builds the upstream URL and the final header set from the organization's
 * resolved provider row. Clients never supply a URL, so there is no SSRF
 * surface: both shapes are derived in code from the closed registries.
 *
 * - `gateway === null` — the provider's native API, path passed through
 *   verbatim, authenticated with the registry's own header.
 * - otherwise — the gateway adapter owns the URL and its own headers, and the
 *   provider key never travels because the gateway holds it.
 */
export function providerUpstream(input: {
  resolved: ResolvedProvider;
  prepared: PreparedProxyRequest;
  appId: string;
  userId: string;
}): { url: string; headers: Headers } {
  const { resolved, prepared } = input;
  const headers = new Headers(prepared.headers);

  if (resolved.gateway) {
    const upstream = gatewayUpstream({
      gateway: resolved.gateway,
      secret: resolved.secret,
      provider: prepared.provider,
      providerPath: prepared.providerPath,
      query: prepared.query,
      appId: input.appId,
      userId: input.userId,
    });
    stripGatewayNamespaces(headers, resolved.gateway.type);
    for (const [name, value] of Object.entries(upstream.headers)) headers.set(name, value);
    return { url: upstream.url, headers };
  }

  stripGatewayNamespaces(headers, null);
  const spec = PROVIDER_REGISTRY[prepared.provider];
  headers.set(spec.auth.header, providerAuthValue(prepared.provider, resolved.secret));
  // Set after sanitization, like the credential itself: these are the gateway's
  // own asks of the upstream, never a client's.
  for (const [name, value] of Object.entries(providerRequestHeaders(prepared.provider))) {
    headers.set(name, value);
  }
  return {
    url: `${spec.directBaseUrl}${prepared.providerPath}${prepared.query}`,
    headers,
  };
}

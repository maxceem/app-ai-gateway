import type { ProviderPricing } from "../db/schema";
import { GatewayError } from "./errors";
import type { ResolvedProvider } from "./provider-store";
import { PROVIDER_REGISTRY } from "./providers";
import { hasModelPrice } from "./usage";
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

function inferredClampStyle(provider: ProviderType, providerPath: string): OutputClampStyle {
  if (providerPath.endsWith("audio/transcriptions") || providerPath === "v1/stt") return "none";
  if (providerPath.includes("chat/completions")) return "chat_completions";
  if (providerPath.endsWith("responses")) return "responses";
  if (providerPath.includes("generateContent")) return "gemini_native";
  if (provider === "anthropic") return "anthropic";
  if (provider === "gemini") return "gemini_native";
  return "responses";
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
 * Client-controlled routing headers a Cloudflare AI Gateway understands. They
 * are forwarded only when the resolved provider actually routes through one.
 */
const CLIENT_AI_GATEWAY_HEADERS = new Set([
  "cf-aig-cache-ttl",
  "cf-aig-skip-cache",
  "cf-aig-max-attempts",
  "cf-aig-backoff",
  "cf-aig-retry-delay",
]);

/**
 * Strips everything the client must not influence. Provider authentication is
 * injected later by {@link providerUpstream}, once the organization's provider
 * row is resolved and the routing decision is known.
 */
export function sanitizedHeaders(
  request: Request,
  app: AppConfig,
  tokenHeader: string,
): Headers {
  const headers = new Headers(request.headers);
  const headerNames: string[] = [];
  headers.forEach((_value, name) => headerNames.push(name));
  for (const name of headerNames) {
    if (name.startsWith("cf-aig-") && !CLIENT_AI_GATEWAY_HEADERS.has(name)) headers.delete(name);
  }
  for (const name of [
    "authorization",
    "x-api-key",
    "x-goog-api-key",
    app.authentication.issuer?.token_header,
    tokenHeader,
    "x-end-user-id",
    "cf-aig-authorization",
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
  providerPath: string;
  tokenHeader: string;
  /** The resolved row's per-model overrides; they win over the global catalog. */
  pricing: ProviderPricing | null;
}): Promise<PreparedProxyRequest> {
  const config = input.app.routing.providerMode === "all"
    ? UNRESTRICTED_PROVIDER
    : input.app.routing.providers[input.provider];
  if (!config) throw new GatewayError(403, "path_not_allowed", "Provider is disabled for this app");
  const match = matchedPath(input.provider, input.providerPath, config.allowed_paths);
  if (!match) throw new GatewayError(403, "path_not_allowed", "Provider path is not allowed");

  const bytes = await readBodyLimited(input.request);
  const contentType = input.request.headers.get("content-type") ?? "";
  const isMultipart = contentType.toLowerCase().startsWith("multipart/form-data");
  const clampStyle = match.entry.clamp ?? inferredClampStyle(input.provider, input.providerPath);
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
    const actualModel = input.app.routing.modelRewrites[requestedModel] ?? requestedModel;
    if (!hasModelPrice(input.provider, actualModel, input.pricing)) {
      throw new GatewayError(400, "pricing_not_configured", unpricedMessage(input.provider, actualModel));
    }
    if (match.modelFromPath && actualModel !== requestedModel) {
      providerPath = match.entry.path.replace("{model}", encodeURIComponent(actualModel));
      body = Uint8Array.from(bytes).buffer;
    } else if (!match.modelFromPath && !match.entry.fixed_model && actualModel !== requestedModel) {
      parsed!.set("model", actualModel);
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
  const actualModel = input.app.routing.modelRewrites[requestedModel] ?? requestedModel;
  if (!hasModelPrice(input.provider, actualModel, input.pricing)) {
    throw new GatewayError(400, "pricing_not_configured", unpricedMessage(input.provider, actualModel));
  }
  if (match.modelFromPath) {
    providerPath = actualModel === requestedModel
      ? input.providerPath
      : match.entry.path.replace("{model}", encodeURIComponent(actualModel));
  } else if (!match.entry.fixed_model) {
    if (actualModel !== requestedModel) {
      parsed.model = actualModel;
      bodyChanged = true;
    }
  }
  bodyChanged =
    validateOrInjectOutputCap(clampStyle, input.provider, parsed, config.max_output_tokens)
    || bodyChanged;
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

export const CF_AI_GATEWAY_BASE_URL = "https://gateway.ai.cloudflare.com/v1";

/**
 * Builds the upstream URL and the final header set from the organization's
 * resolved provider row. Clients never supply a URL, so there is no SSRF
 * surface: both shapes are derived in code from the closed `gateway` set.
 *
 * - `gateway === null` — the provider's native API, path passed through
 *   verbatim, authenticated with the registry's own header.
 * - `gateway === "cf_aig"` — the organization's own Cloudflare AI Gateway,
 *   which injects the provider key from its own store, so only the gateway
 *   token travels and no provider-auth header is sent.
 */
export function providerUpstream(input: {
  resolved: ResolvedProvider;
  prepared: PreparedProxyRequest;
  appId: string;
  userId: string;
}): { url: string; headers: Headers } {
  const { resolved, prepared } = input;
  const spec = PROVIDER_REGISTRY[prepared.provider];
  const headers = new Headers(prepared.headers);

  if (resolved.gateway === "cf_aig") {
    const config = resolved.gatewayConfig;
    if (!config) {
      throw new GatewayError(
        502,
        "provider_unavailable",
        "Provider is routed through a Cloudflare AI Gateway with no stored configuration",
      );
    }
    headers.set("cf-aig-authorization", `Bearer ${resolved.secret}`);
    headers.set("cf-aig-metadata", JSON.stringify({ app_id: input.appId, user_id: input.userId }));
    const prefix = "stripPathPrefix" in spec.aig ? spec.aig.stripPathPrefix : undefined;
    const path = prefix && prepared.providerPath.startsWith(prefix)
      ? prepared.providerPath.slice(prefix.length)
      : prepared.providerPath;
    const base = [
      CF_AI_GATEWAY_BASE_URL,
      encodeURIComponent(config.accountId),
      encodeURIComponent(config.gatewayId),
      spec.aig.slug,
    ].join("/");
    return { url: `${base}/${path}${prepared.query}`, headers };
  }

  // Nothing in front of the provider understands cf-aig-*, so none of it goes out.
  const names: string[] = [];
  headers.forEach((_value, name) => names.push(name));
  for (const name of names) {
    if (name.startsWith("cf-aig-")) headers.delete(name);
  }
  headers.set(spec.auth.header, `${"scheme" in spec.auth ? spec.auth.scheme : ""}${resolved.secret}`);
  return {
    url: `${spec.directBaseUrl}${prepared.providerPath}${prepared.query}`,
    headers,
  };
}

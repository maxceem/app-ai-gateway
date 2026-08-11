import { GatewayError } from "./errors";
import { hasModelPrice } from "./usage";
import type {
  AllowedPath,
  AllowedPathConfig,
  AppConfig,
  OutputClampStyle,
  Provider,
  ProviderProxyConfig,
} from "./types";

export const MAX_REQUEST_BYTES = 20 * 1024 * 1024;
const UNRESTRICTED_PROVIDER: ProviderProxyConfig = {
  allowed_paths: [],
  allowed_models: [],
};

export interface PreparedProxyRequest {
  provider: Provider;
  providerPath: string;
  model: string;
  body: BodyInit | null;
  headers: Headers;
  query: string;
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

function matchedPath(provider: Provider, path: string, allowed: AllowedPath[]): MatchedPath | null {
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

function inferredClampStyle(provider: Provider, providerPath: string): OutputClampStyle {
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
  provider: Provider,
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

export function sanitizedHeaders(
  request: Request,
  app: AppConfig,
  tokenHeader: string,
  cfAigToken: string,
): Headers {
  const headers = new Headers(request.headers);
  const allowedAiGatewayHeaders = new Set([
    "cf-aig-cache-ttl",
    "cf-aig-skip-cache",
    "cf-aig-max-attempts",
    "cf-aig-backoff",
    "cf-aig-retry-delay",
  ]);
  const headerNames: string[] = [];
  headers.forEach((_value, name) => headerNames.push(name));
  for (const name of headerNames) {
    if (name.startsWith("cf-aig-") && !allowedAiGatewayHeaders.has(name)) headers.delete(name);
  }
  for (const name of [
    "authorization",
    "x-api-key",
    "x-goog-api-key",
    app.authentication.type === "apple_app_attest"
      ? app.authentication.issuer.token_header
      : undefined,
    tokenHeader,
    "x-end-user-id",
    "cf-aig-authorization",
    "host",
    "content-length",
    "connection",
  ]) {
    if (name) headers.delete(name);
  }
  // AI Gateway's Workers AI binding provides the account-aware URL, but an
  // authenticated gateway still requires its Run token on an ordinary fetch.
  // Always replace any client-supplied value with the server-owned secret.
  headers.set("cf-aig-authorization", `Bearer ${cfAigToken}`);
  return headers;
}

export async function prepareProxyRequest(input: {
  request: Request;
  app: AppConfig;
  userId: string;
  provider: Provider;
  providerPath: string;
  tokenHeader: string;
  cfAigToken: string;
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
  const headers = sanitizedHeaders(
    input.request,
    input.app,
    input.tokenHeader,
    input.cfAigToken,
  );
  headers.set(
    "cf-aig-metadata",
    JSON.stringify({ app_id: input.app.id, user_id: input.userId }),
  );

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
    if (!hasModelPrice(input.provider, actualModel)) {
      throw new GatewayError(
        400,
        "pricing_not_configured",
        `Model ${actualModel} does not have pricing configured for ${input.provider}`,
      );
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
  if (!hasModelPrice(input.provider, actualModel)) {
    throw new GatewayError(
      400,
      "pricing_not_configured",
      `Model ${actualModel} does not have pricing configured for ${input.provider}`,
    );
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

export async function providerGatewayUrl(
  env: Env & { CF_AIG_BASE_URL?: string },
  prepared: PreparedProxyRequest,
): Promise<string> {
  const slug: Record<Provider, string> = {
    openai: "openai",
    anthropic: "anthropic",
    xai: "grok",
    gemini: "google-ai-studio",
    perplexity: "perplexity-ai",
  };
  const path = prepared.provider === "openai"
    ? prepared.providerPath.replace(/^v1\//u, "")
    : prepared.providerPath;
  const configuredBase = env.CF_AIG_BASE_URL;
  const ai = env.AI;
  let base: string;
  if (configuredBase) {
    base = `${configuredBase.replace(/\/$/u, "")}/${slug[prepared.provider]}`;
  } else {
    if (!ai) throw new Error("The Workers AI binding is unavailable");
    base = (await ai.gateway(env.CF_AIG_GATEWAY_ID).getUrl(slug[prepared.provider]))
      .replace(/\/$/u, "");
  }
  return `${base}/${path}${prepared.query}`;
}

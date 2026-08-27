import { GatewayError } from "./errors";
import {
  jsonObject,
  readBodyLimited,
  sanitizedHeaders,
  validateOrInjectOutputCap,
  type PreparedProxyRequest,
} from "./proxyrules";
import type {
  AppConfig,
  EndpointApiStyle,
  EndpointConfig,
  EndpointProvider,
  EndpointTarget,
} from "./types";

/**
 * A named endpoint is fully described by server configuration, so the gateway
 * builds the upstream request itself instead of forwarding a client-chosen
 * provider path. Everything that does not depend on the selected target is
 * prepared once; a fallback attempt only swaps provider, model, and URL.
 */
export interface PreparedEndpointRequest {
  slug: string;
  endpoint: EndpointConfig;
  targets: EndpointTarget[];
  headers: Headers;
  /** Present for the responses style; the model is set per attempt. */
  json: Record<string, unknown> | null;
  /** Present for the transcription style; the model field is set per attempt. */
  form: FormData | null;
}

export function endpointProviderPath(
  style: EndpointApiStyle,
  provider: EndpointProvider,
): string {
  if (style === "transcription") {
    // Native provider paths: OpenAI transcribes at v1/audio/transcriptions,
    // xAI at v1/stt.
    return provider === "openai" ? "v1/audio/transcriptions" : "v1/stt";
  }
  return "v1/responses";
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
    const current = result[key];
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

function formWithModel(source: FormData, model: string): FormData {
  const form = new FormData();
  source.forEach((value, name) => {
    if (name !== "model") form.append(name, value as string | File);
  });
  form.set("model", model);
  return form;
}

/** Builds the concrete upstream request for one target in the fallback chain. */
export function endpointAttempt(
  prepared: PreparedEndpointRequest,
  target: EndpointTarget,
): PreparedProxyRequest {
  const providerPath = endpointProviderPath(prepared.endpoint.api_style, target.provider);
  const body: BodyInit = prepared.form
    ? formWithModel(prepared.form, target.model)
    : JSON.stringify({ ...prepared.json, model: target.model });
  return {
    provider: target.provider,
    providerPath,
    model: target.model,
    body,
    headers: prepared.headers,
    // The endpoint URL is a gateway contract, not a provider path, so client
    // query parameters are never forwarded upstream.
    query: "",
  };
}

export async function prepareEndpointRequest(input: {
  request: Request;
  app: AppConfig;
  slug: string;
  endpoint: EndpointConfig;
  tokenHeader: string;
}): Promise<PreparedEndpointRequest> {
  const bytes = await readBodyLimited(input.request);
  const headers = sanitizedHeaders(input.request, input.app, input.tokenHeader);
  const contentType = input.request.headers.get("content-type") ?? "";

  if (input.endpoint.api_style === "transcription") {
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      throw new GatewayError(
        400,
        "invalid_request",
        "This endpoint expects a multipart/form-data transcription request",
      );
    }
    const form = await new Request("https://local.invalid", {
      method: "POST",
      headers: { "content-type": contentType },
      body: Uint8Array.from(bytes).buffer,
    }).formData();
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
    };
  }

  const merged = deepMerge(jsonObject(bytes), input.endpoint.params ?? {});
  validateOrInjectOutputCap(
    "responses",
    input.endpoint.provider,
    merged,
    input.endpoint.max_output_tokens,
  );
  headers.set("content-type", "application/json");
  return {
    slug: input.slug,
    endpoint: input.endpoint,
    targets: endpointTargets(input.endpoint),
    headers,
    json: merged,
    form: null,
  };
}

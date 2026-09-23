import { supportsEndpointStyle } from "./capabilities";
import { GatewayError } from "./errors";
import { isBillable } from "./pricing";
import {
  requireProvider,
  resolveProvider,
  type ResolvedProvider,
} from "./provider-store";
import { providerDescriptor } from "./providers";
import { routeWireModel } from "./routes";
import { lookup } from "../shared/records";
import { ENDPOINT_STYLE_API } from "../shared/capabilities";
import type { ExecutionAttempt } from "../execution/plan";
import {
  jsonObject,
  readBodyLimited,
  sanitizedHeaders,
  unpricedMessage,
  validateOrInjectOutputCap,
  type PreparedProxyRequest,
} from "./proxyrules";
import type {
  AppRecord,
  EndpointApiStyle,
  EndpointConfig,
  EndpointTarget,
  ProviderType,
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

/**
 * The provider's own path a named endpoint of this style posts to, from the
 * descriptor that declares it. The key set of `endpointPaths` *is* the type's
 * endpoint capability, so a missing entry means the capability matrix already
 * refused this pairing: reaching here is a bug in this deployment, not a
 * caller's mistake.
 */
export function endpointProviderPath(
  style: EndpointApiStyle,
  provider: ProviderType,
): string {
  const path = providerDescriptor(provider).endpointPaths?.[style];
  if (path === undefined) {
    throw new GatewayError(
      500,
      "internal_error",
      `Provider type ${provider} composes no ${style} endpoint`,
    );
  }
  return path;
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

function formWithModel(source: FormData, model: string): FormData {
  const form = new FormData();
  source.forEach((value, name) => {
    if (name !== "model") form.append(name, value as string | File);
  });
  form.set("model", model);
  return form;
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
  let body: BodyInit;
  if (prepared.form) {
    body = formWithModel(prepared.form, wireModel);
  } else {
    const json = { ...prepared.json, model: wireModel };
    validateOrInjectOutputCap(
      "responses",
      provider,
      json,
      prepared.endpoint.max_output_tokens,
    );
    route.adapter.mutateBody?.({
      routeConfig: route.config,
      // A named endpoint of this style composes a Responses body, so the style
      // is the endpoint's contract rather than something sniffed off a path.
      style: "responses",
      body: json,
    });
    body = JSON.stringify(json);
  }
  return {
    body,
    headers: prepared.headers,
    // The endpoint URL is a gateway contract, not a provider path, so client
    // query parameters are never forwarded upstream.
    query: "",
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
    if (!isBillable(entry.type, target.model, entry.pricing)) {
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
    return {
      resolved,
      providerPath: endpointProviderPath(endpoint.api_style, resolved.type),
      model: target.model,
      // The endpoint's own style settles the API, so the answer is read by the
      // reader for the contract this gateway composed rather than a guess.
      apiStyle: ENDPOINT_STYLE_API[endpoint.api_style],
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
  app: AppRecord;
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
      // The exact-sized array `readBodyLimited` returns is the body; copying it
      // here copied the whole upload a second time.
      body: bytes,
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

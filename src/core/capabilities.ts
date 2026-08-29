import type { ProviderGatewayType } from "../db/schema";
import { API_STYLES, type ApiStyle } from "./api-styles";
import { GatewayError } from "./errors";
import {
  canonicalModel,
  GATEWAY_ADAPTERS,
  wireModel,
  type GatewayProviderRoute,
} from "./gateways";
import { PROVIDER_TYPES, type EndpointApiStyle, type ProviderType } from "./providers";

/**
 * Where a provider instance's traffic goes: straight to the provider's own API,
 * or through one of the organization's gateways.
 */
export type ProviderRoute = "direct" | ProviderGatewayType;

export interface RouteCapability {
  /** Client API styles this route forwards. */
  apiStyles: readonly ApiStyle[];
  /** Named-endpoint styles the gateway composes itself for this provider. */
  endpointStyles: readonly EndpointApiStyle[];
}

/**
 * What each provider type can do on its own API. The raw proxy is a
 * pass-through, so every style reaches every provider and the provider itself
 * answers for the paths it does not have; named endpoints are the narrow set,
 * because the gateway composes those request bodies rather than forwarding them.
 */
const PROVIDER_CAPABILITIES = {
  openai: { apiStyles: API_STYLES, endpointStyles: ["responses", "transcription"] },
  anthropic: { apiStyles: API_STYLES, endpointStyles: [] },
  xai: { apiStyles: API_STYLES, endpointStyles: ["responses", "transcription"] },
  gemini: { apiStyles: API_STYLES, endpointStyles: [] },
  perplexity: { apiStyles: API_STYLES, endpointStyles: [] },
  // The OpenAI-compatible batch. Named endpoints stay empty: the gateway would
  // have to compose those bodies itself, and nothing has been verified against
  // these providers' own request shapes, so only the pass-through is offered.
  deepseek: { apiStyles: API_STYLES, endpointStyles: [] },
  groq: { apiStyles: API_STYLES, endpointStyles: [] },
  mistral: { apiStyles: API_STYLES, endpointStyles: [] },
  together: { apiStyles: API_STYLES, endpointStyles: [] },
  fireworks: { apiStyles: API_STYLES, endpointStyles: [] },
  cerebras: { apiStyles: API_STYLES, endpointStyles: [] },
  moonshot: { apiStyles: API_STYLES, endpointStyles: [] },
  huggingface: { apiStyles: API_STYLES, endpointStyles: [] },
  baseten: { apiStyles: API_STYLES, endpointStyles: [] },
  bytedance: { apiStyles: API_STYLES, endpointStyles: [] },
} as const satisfies Record<ProviderType, RouteCapability>;

export type EndpointProvider = {
  [Type in ProviderType]: (typeof PROVIDER_CAPABILITIES)[Type]["endpointStyles"] extends readonly []
    ? never
    : Type;
}[ProviderType];

export const ENDPOINT_PROVIDER_TYPES = PROVIDER_TYPES.filter(
  (type): type is EndpointProvider => PROVIDER_CAPABILITIES[type].endpointStyles.length > 0,
) as [EndpointProvider, ...EndpointProvider[]];

/**
 * A gateway route only ever narrows what the provider already offers: an
 * adapter cannot invent an operation the provider does not have. `undefined`
 * means the adapter has no mapping for the provider type, which makes that
 * type direct-only.
 *
 * Exported so a hypothetical route can be checked before an adapter that
 * produces one exists.
 */
export function narrowedCapability(
  base: RouteCapability,
  route: GatewayProviderRoute | undefined,
): RouteCapability | null {
  if (!route) return null;
  const allowed = route.apiStyles;
  return {
    apiStyles: allowed ? base.apiStyles.filter((style) => allowed.includes(style)) : base.apiStyles,
    endpointStyles: base.endpointStyles,
  };
}

/** `null` when the route cannot serve the provider type at all. */
export function routeCapability(
  route: ProviderRoute,
  provider: ProviderType,
): RouteCapability | null {
  const base = PROVIDER_CAPABILITIES[provider];
  if (route === "direct") return base;
  return narrowedCapability(base, GATEWAY_ADAPTERS[route].routes[provider]);
}

function gatewayRoute(
  route: ProviderRoute,
  provider: ProviderType,
): GatewayProviderRoute | undefined {
  return route === "direct" ? undefined : GATEWAY_ADAPTERS[route].routes[provider];
}

/**
 * The canonical model ID as this route puts it on the wire. Model identity is
 * route-independent everywhere else — pricing, `allowed_models`, `fixed_model`
 * and recorded usage all speak the provider's own IDs — and the adapter owns
 * the translation, so one price row covers a model on every route.
 */
export function routeWireModel(
  route: ProviderRoute,
  provider: ProviderType,
  canonical: string,
): string {
  return wireModel(gatewayRoute(route, provider), canonical);
}

/** A model ID observed on the wire, back to canonical. Strips only this route's own prefix. */
export function routeCanonicalModel(
  route: ProviderRoute,
  provider: ProviderType,
  observed: string,
): string {
  return canonicalModel(gatewayRoute(route, provider), observed);
}

/**
 * Refuses a provider instance a gateway cannot carry at all, at the moment it is
 * configured rather than on its first request. Most provider types have no
 * mapping in any adapter — that is the direct-only default — so without this an
 * operator could store a row whose every request answers 403.
 */
export function assertRouteServesProvider(
  route: ProviderRoute,
  provider: ProviderType,
): void {
  if (routeCapability(route, provider) !== null) return;
  throw new GatewayError(
    400,
    "provider_not_supported_by_gateway",
    `${route} provider gateways do not serve ${provider} providers; connect this one with its own API key instead`,
  );
}

export function supportsApiStyle(
  route: ProviderRoute,
  provider: ProviderType,
  style: ApiStyle,
): boolean {
  return routeCapability(route, provider)?.apiStyles.includes(style) ?? false;
}

export function supportsEndpointStyle(
  route: ProviderRoute,
  provider: ProviderType,
  style: EndpointApiStyle,
): boolean {
  return routeCapability(route, provider)?.endpointStyles.includes(style) ?? false;
}

/** Provider types eligible for a named endpoint style on their own API. */
export function providersForEndpointStyle(style: EndpointApiStyle): EndpointProvider[] {
  return ENDPOINT_PROVIDER_TYPES.filter((type) =>
    PROVIDER_CAPABILITIES[type].endpointStyles.includes(style),
  );
}

/**
 * The server, not the client, decides whether a route can carry an operation.
 * Nothing expressible today is rejected here; the check exists so a gateway
 * that genuinely cannot serve a style fails at the edge instead of upstream.
 */
export function assertApiStyleSupported(
  route: ProviderRoute,
  provider: ProviderType,
  style: ApiStyle,
): void {
  if (supportsApiStyle(route, provider, style)) return;
  throw new GatewayError(
    403,
    "api_style_not_supported",
    route === "direct"
      ? `Provider type ${provider} does not support this API`
      : `Gateway ${route} does not support this API for ${provider} providers`,
  );
}

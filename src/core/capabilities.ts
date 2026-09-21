import type { ProviderRoute, RouteCapability } from "../shared/capabilities";
import type { ApiStyle } from "./api-styles";
import { GatewayError } from "./errors";
import { PROVIDER_TYPES, type EndpointApiStyle, type ProviderType } from "./providers";
import { ROUTE_ADAPTERS } from "./routes";

// The matrix's own shapes and the tables derived purely from them live with the
// data, so the console reads the same definitions the Worker enforces. What
// stays here is the resolved (route × provider type) matrix and the assertions
// that refuse a combination — everything that is keyed by a *route kind*, which
// is all a management caller ever holds.
export {
  narrowedCapability,
  type ProviderRoute,
  type RouteCapability,
} from "../shared/capabilities";
export {
  ENDPOINT_PROVIDER_TYPES,
  providersForEndpointStyle,
  type EndpointProvider,
} from "../shared/providers";

/**
 * The whole (route × provider type) matrix, resolved once at module load.
 *
 * It is static: every adapter is code, so every cell is knowable before the
 * first request and none of them can change afterwards. Computing a cell used to
 * mean filtering two style lists per capability check, and a proxied request
 * makes several. Maps rather than objects because the key is a provider type
 * read off a stored row, and a plain object answers for `constructor`.
 */
const ROUTE_CAPABILITIES: ReadonlyMap<
  ProviderRoute,
  ReadonlyMap<ProviderType, RouteCapability>
> = new Map(
  Object.values(ROUTE_ADAPTERS).map((adapter) => [
    adapter.kind,
    new Map(PROVIDER_TYPES.flatMap((provider) => {
      const capability = adapter.capability(provider);
      // Absent rather than null: a provider type a gateway has no mapping for
      // is simply not in that gateway's row.
      return capability === null ? [] : [[provider, capability] as const];
    })),
  ] as const),
);

/** `null` when the route cannot serve the provider type at all. */
export function routeCapability(
  route: ProviderRoute,
  provider: ProviderType,
): RouteCapability | null {
  return ROUTE_CAPABILITIES.get(route)?.get(provider) ?? null;
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

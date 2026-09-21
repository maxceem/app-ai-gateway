/**
 * Where a provider instance's traffic goes, as one interface with one registry.
 *
 * A direct call used to be the absence of a gateway, so every consumer wrote
 * the same `resolved.gateway ? … : …` fork and three encodings of "how is this
 * row routed" travelled side by side. `direct` is an adapter here, with the
 * same shape the gateways have: it owns its URL, its credential header, its
 * probe, and its answer to "may this provider serve this style". Nothing
 * outside {@link resolveProvider} joins a stored gateway type to an adapter,
 * and nothing anywhere branches on the absence of one.
 */

import type {
  GatewayRouteConfig,
  ProviderGatewayConfig,
} from "../db/schema";
import type {
  CredentialSource,
  GatewayProviderRoute,
  GatewayType,
  ProviderRoute,
  RouteCapability,
} from "../shared/capabilities";
import type { ApiStyle } from "./api-styles";
import { GatewayError } from "./errors";
import { cfAigAdapter, vercelAdapter } from "./gateways";
import {
  providerAuthValue,
  providerCapability,
  providerDescriptor,
  providerRequestHeaders,
  PROVIDER_TYPES,
  type ProviderType,
} from "./providers";

/** An upstream call the adapter owns end to end: URL plus its own headers. */
export interface RouteRequest {
  url: string;
  /** Set after client headers are sanitized, so a client can never supply them. */
  headers: Record<string, string>;
}

export interface RouteUpstreamInput {
  provider: ProviderType;
  providerPath: string;
  query: string;
  /** The provider key on a direct route, the gateway's own token on a gateway. */
  secret: string;
  /** The row's operator-supplied origin; only a direct route has one. */
  baseUrl: string | null;
  /** The gateway row's non-secret configuration; null on a direct route. */
  gatewayConfig: ProviderGatewayConfig | null;
  /** The provider row's own routing configuration; null on a direct route. */
  routeConfig: GatewayRouteConfig | null;
  appId: string;
  userId: string | null;
}

export interface RouteProbeInput {
  provider: ProviderType;
  secret: string;
  baseUrl: string | null;
  gatewayConfig: ProviderGatewayConfig | null;
}

/** Body the adapter may rewrite in place, and what it is allowed to know. */
export interface RouteBodyInput {
  /** The provider row's stored routing configuration, already validated. */
  routeConfig: GatewayRouteConfig | null;
  style: ApiStyle;
  /** Mutated in place; the caller re-serializes only if `true` comes back. */
  body: Record<string, unknown>;
}

export interface RouteAdapter {
  readonly kind: ProviderRoute;
  /**
   * Headers this route sets itself. A client value in any of them is stripped
   * on every route, so the sanitizer can never drift from the adapters.
   */
  readonly reservedHeaders: readonly string[];
  /**
   * Namespace this route reads its control headers from, or `null` where it has
   * none — a direct call is the provider's own API and reserves no namespace of
   * its own beyond the credential headers above.
   */
  readonly headerPrefix: string | null;
  /**
   * The only headers inside {@link headerPrefix} a client may set, and only on
   * a request that actually takes this route.
   */
  readonly clientHeaders: readonly string[];
  /**
   * Whose credential this route pays with, when the configuration settles it
   * for every request. `null` where it depends on the response, which is then
   * read per event rather than assumed here.
   */
  readonly credentialSource: CredentialSource | null;
  /**
   * What this route can carry for one provider type, or `null` where it cannot
   * carry that type at all. A gateway only ever narrows the provider's own
   * surface; it cannot invent an operation the provider does not have.
   */
  capability(provider: ProviderType): RouteCapability | null;
  /**
   * How this route reaches one provider type, where it names one. `undefined`
   * on a direct call, which speaks the provider's own URLs and model IDs.
   */
  providerRoute(provider: ProviderType): GatewayProviderRoute | undefined;
  upstream(input: RouteUpstreamInput): RouteRequest;
  /** `null` when this route has nothing cheap and authenticated to call. */
  probe(input: RouteProbeInput): RouteRequest | null;
  /**
   * A same-protocol rewrite this route's own configuration asks for — the kind
   * model rewrites and output caps already are, never a conversion between
   * provider API formats. Returns whether the body changed. Absent where a
   * route expresses nothing in the body, which is the default.
   */
  mutateBody?(input: RouteBodyInput): boolean;
  /**
   * Rejects a provider row's `gateway_route_json` this route cannot honour.
   * Called on every create and update, so a stored route configuration is
   * always one its adapter agreed to.
   */
  validateRouteConfig(config: GatewayRouteConfig | null): void;
}

/**
 * The provider's own API: path passed through verbatim, authenticated with the
 * descriptor's own header. The origin is the descriptor's `directBaseUrl`
 * unless the row carries an operator's own `baseUrl`, which replaces it and
 * nothing else — the client's path and query are appended exactly as they would
 * have been.
 */
export const DIRECT_ADAPTER: RouteAdapter = {
  kind: "direct",
  // Derived from the descriptors rather than listed: each one declares the
  // header it authenticates with and any it (or its cost-report integration)
  // needs the upstream to read, so the strip list cannot drift from them.
  reservedHeaders: [
    ...new Set(
      PROVIDER_TYPES.flatMap((type) => [
        providerDescriptor(type).auth.header,
        ...Object.keys(providerRequestHeaders(type)),
      ]),
    ),
  ],
  // A direct call is the provider's own API, and a provider's control headers
  // are the reserved ones above rather than a namespace this gateway owns.
  headerPrefix: null,
  clientHeaders: [],
  // A direct row pays with the organization's own provider key by construction.
  credentialSource: "direct",
  capability: providerCapability,
  providerRoute: () => undefined,
  upstream(input) {
    const descriptor = providerDescriptor(input.provider);
    return {
      url: `${input.baseUrl ?? descriptor.directBaseUrl}${input.providerPath}${input.query}`,
      headers: {
        [descriptor.auth.header]: providerAuthValue(input.provider, input.secret),
        // The gateway's own asks of the upstream, never a client's.
        ...providerRequestHeaders(input.provider),
      },
    };
  },
  probe(input) {
    const descriptor = providerDescriptor(input.provider);
    // A type with no probe path has no cheap authenticated call at all; see the
    // per-entry notes in `src/shared/providers.ts`.
    if (descriptor.probePath === undefined) return null;
    // The row's own origin, so a mistyped Azure or vLLM URL fails at
    // configuration time rather than on the app's first request.
    return {
      url: `${input.baseUrl ?? descriptor.directBaseUrl}${descriptor.probePath}`,
      headers: {
        [descriptor.auth.header]: providerAuthValue(input.provider, input.secret),
      },
    };
  },
  validateRouteConfig(config) {
    if (config !== null) {
      throw new GatewayError(
        400,
        "invalid_request",
        "Routing configuration only applies to a provider routed through a gateway",
      );
    }
  },
};

/** Closed registry: every route a row can take has exactly one adapter. */
export const ROUTE_ADAPTERS: Record<ProviderRoute, RouteAdapter> = {
  direct: DIRECT_ADAPTER,
  cf_aig: cfAigAdapter,
  vercel: vercelAdapter,
};

export function routeAdapter(kind: ProviderRoute): RouteAdapter {
  return ROUTE_ADAPTERS[kind];
}

/**
 * Gateway types this deployment can actually serve: the registry minus the
 * direct adapter, which is not a gateway anybody can store on a row.
 */
const GATEWAY_ADAPTER_KINDS: ReadonlySet<string> = new Set(
  Object.keys(ROUTE_ADAPTERS).filter((kind) => kind !== "direct"),
);

/**
 * Whether a gateway type stored in D1 has an adapter. The column is deliberately
 * unconstrained — the runtime registry is what decides — so a stored row is not
 * proof that this deployment can serve it.
 */
export function isGatewayType(name: string): name is GatewayType {
  return GATEWAY_ADAPTER_KINDS.has(name);
}

/**
 * The stored type of a gateway row, narrowed to one this deployment can serve,
 * or a 400 naming the type it cannot. Every admin path that reads a stored
 * `provider_gateway.type` needs exactly this check and the same message, so it
 * lives here with {@link isGatewayType} rather than being written out at each
 * call site — where the day one of them forgot, a row with no adapter would be
 * read as another gateway's configuration.
 */
export function requireGatewayAdapter(name: string): GatewayType {
  if (isGatewayType(name)) return name;
  throw new GatewayError(
    400,
    "invalid_request",
    `This deployment has no adapter for ${name} provider gateways`,
  );
}

/**
 * One provider instance's route, resolved once: which adapter carries it, the
 * gateway row behind it if any, and that row's own routing configuration.
 */
export interface ResolvedRoute {
  readonly kind: ProviderRoute;
  readonly adapter: RouteAdapter;
  /** The gateway row behind a routed instance; null on direct. */
  readonly gateway: { id: string; type: GatewayType; config: ProviderGatewayConfig } | null;
  /** The provider row's own routing configuration for its gateway; null on direct. */
  readonly config: GatewayRouteConfig | null;
}

/** Every direct row is routed identically, so one value answers for all of them. */
export const DIRECT_ROUTE: ResolvedRoute = {
  kind: "direct",
  adapter: DIRECT_ADAPTER,
  gateway: null,
  config: null,
};

/**
 * A routed instance, from the stored gateway row and the row's own routing
 * configuration. The only caller is `resolveProvider`, which has already
 * narrowed the stored type through {@link isGatewayType}.
 */
export function routeThroughGateway(
  gateway: { id: string; type: GatewayType; config: ProviderGatewayConfig },
  config: GatewayRouteConfig | null,
): ResolvedRoute {
  return { kind: gateway.type, adapter: routeAdapter(gateway.type), gateway, config };
}

/**
 * The namespace actually in force: the row's own override where it set one,
 * the adapter's per-provider default otherwise. A stored override reached
 * {@link RouteAdapter.validateRouteConfig} first, so it is one this route
 * agreed to; the default is what an unconfigured row gets.
 */
function routePrefix(route: ResolvedRoute, provider: ProviderType): string | undefined {
  return route.config?.modelPrefix ?? route.adapter.providerRoute(provider)?.modelPrefix;
}

/**
 * The canonical model ID as this route puts it on the wire. Model identity is
 * route-independent everywhere else — pricing, `allowed_models`, `fixed_model`
 * and recorded usage all speak the provider's own IDs — and the adapter owns
 * the translation, so one price row covers a model on every route.
 */
export function routeWireModel(
  route: ResolvedRoute,
  provider: ProviderType,
  canonical: string,
): string {
  const prefix = routePrefix(route, provider);
  return prefix ? `${prefix}${canonical}` : canonical;
}

/**
 * What this route put on the wire, back to the canonical model ID. Only the
 * route's *own* prefix comes off: canonical IDs may contain `/` themselves
 * (`fal-ai/fast-sdxl`, and every OpenRouter slug), so "everything before the
 * first slash" would silently rename them.
 */
export function routeCanonicalModel(
  route: ResolvedRoute,
  provider: ProviderType,
  observed: string,
): string {
  const prefix = routePrefix(route, provider);
  return prefix && observed.startsWith(prefix) ? observed.slice(prefix.length) : observed;
}

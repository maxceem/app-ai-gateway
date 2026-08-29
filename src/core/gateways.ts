import type {
  CfAigConfig,
  CredentialSource,
  GatewayRouteConfig,
  ProviderGatewayType,
  ProviderGatewayTypeName,
} from "../db/schema";
import type { ApiStyle } from "./api-styles";
import { GatewayError } from "./errors";
import type { ProviderType } from "./types";

/**
 * Non-secret configuration per gateway type. The key set *is*
 * {@link ProviderGatewayType}, so a new gateway type cannot be added without
 * giving it a config shape and an adapter.
 */
export interface GatewayConfigs {
  cf_aig: CfAigConfig;
}

/** A gateway connection as resolved from an organization's row. */
export type ResolvedGateway = {
  [Type in ProviderGatewayType]: { type: Type; config: GatewayConfigs[Type] };
}[ProviderGatewayType];

/**
 * How one gateway reaches one provider type. A provider type with no entry is
 * not served by that gateway at all — the safe default, so adding a provider
 * type never requires touching an adapter.
 */
export interface GatewayProviderRoute {
  /** Path segment naming the provider inside the gateway's URL space. */
  slug: string;
  /** Prefix the slug already implies, stripped from the client's path. */
  stripPathPrefix?: string;
  /**
   * When present, the only API styles this route forwards. Absent means the
   * gateway is transparent and the provider itself is the only judge.
   */
  apiStyles?: readonly ApiStyle[];
  /**
   * The gateway's namespace for this provider's models. Canonical model IDs —
   * the provider's own, which are what `prices.json`, `allowed_models` and the
   * recorded usage all use — get it prepended on the way out and stripped on
   * the way back. Absent means the gateway speaks the provider's IDs verbatim.
   */
  modelPrefix?: string;
}

/** Canonical model ID to what this route puts on the wire. */
export function wireModel(route: GatewayProviderRoute | undefined, canonical: string): string {
  return route?.modelPrefix ? `${route.modelPrefix}${canonical}` : canonical;
}

/**
 * What this route put on the wire, back to the canonical model ID. Only the
 * route's *own* prefix comes off: canonical IDs may contain `/` themselves
 * (`fal-ai/fast-sdxl`, and every OpenRouter slug), so "everything before the
 * first slash" would silently rename them.
 */
export function canonicalModel(route: GatewayProviderRoute | undefined, wire: string): string {
  const prefix = route?.modelPrefix;
  return prefix && wire.startsWith(prefix) ? wire.slice(prefix.length) : wire;
}

/** An upstream call the adapter owns end to end: URL plus its own headers. */
export interface GatewayRequest {
  url: string;
  /** Set after client headers are sanitized, so a client can never supply them. */
  headers: Record<string, string>;
}

export interface GatewayUpstreamInput<Type extends ProviderGatewayType> {
  config: GatewayConfigs[Type];
  /** The gateway's own token; the provider key never travels on this route. */
  secret: string;
  provider: ProviderType;
  providerPath: string;
  query: string;
  appId: string;
  userId: string;
}

export interface GatewayProbeInput<Type extends ProviderGatewayType> {
  config: GatewayConfigs[Type];
  secret: string;
  provider: ProviderType;
  /** The provider's own probe path, adapted by the same rules as live traffic. */
  path: string;
}

export interface GatewayAdapter<Type extends ProviderGatewayType> {
  readonly type: Type;
  /**
   * Headers the gateway itself sets. A client value in any of them is stripped
   * on every route, so the sanitizer can never drift from the adapter.
   */
  readonly reservedHeaders: readonly string[];
  /** Namespace the gateway reads its control headers from. */
  readonly headerPrefix: string;
  /**
   * The only headers inside {@link headerPrefix} a client may set, and only on
   * a request that actually routes through this gateway.
   */
  readonly clientHeaders: readonly string[];
  /**
   * Whose credential this gateway pays with, when the configuration settles it
   * for every request. `null` where it depends on the response, which is then
   * read per event rather than assumed here.
   */
  readonly credentialSource: CredentialSource | null;
  readonly routes: Partial<Record<ProviderType, GatewayProviderRoute>>;
  upstream(input: GatewayUpstreamInput<Type>): GatewayRequest;
  /** `null` when this gateway does not serve the provider type at all. */
  probe(input: GatewayProbeInput<Type>): GatewayRequest | null;
  /**
   * Rejects a provider row's `gateway_route_json` this gateway cannot honour.
   * Called on every create and update, so a stored route is always one its
   * adapter agreed to.
   */
  validateRoute(route: GatewayRouteConfig | null): void;
}

export const CF_AI_GATEWAY_BASE_URL = "https://gateway.ai.cloudflare.com/v1";

/**
 * Cloudflare's own provider slugs. `openai` is the only one whose slug already
 * implies the `v1/` prefix, so it is the only one that strips it.
 *
 * Only provider types verified against a live Cloudflare AI Gateway appear here.
 * Cloudflare lists more providers than this, but a slug taken from its docs is a
 * guess about a URL *and* about whether that gateway's BYOK store holds a key
 * for the type: getting either wrong turns every request into a 4xx nobody can
 * diagnose. A type with no entry is direct-only, which is the safe default and
 * costs nothing but a gateway option the console never offers.
 */
const CF_AIG_ROUTES: Partial<Record<ProviderType, GatewayProviderRoute>> = {
  openai: { slug: "openai", stripPathPrefix: "v1/" },
  anthropic: { slug: "anthropic" },
  xai: { slug: "grok" },
  gemini: { slug: "google-ai-studio" },
  perplexity: { slug: "perplexity-ai" },
};

/** The single place a Cloudflare AI Gateway URL is built: live traffic and
 *  credential probes join the same segments from the same route entry. */
function cfAigUrl(config: CfAigConfig, route: GatewayProviderRoute, path: string): string {
  const adapted = route.stripPathPrefix && path.startsWith(route.stripPathPrefix)
    ? path.slice(route.stripPathPrefix.length)
    : path;
  return [
    CF_AI_GATEWAY_BASE_URL,
    encodeURIComponent(config.accountId),
    encodeURIComponent(config.gatewayId),
    route.slug,
    adapted,
  ].join("/");
}

const cfAigAdapter: GatewayAdapter<"cf_aig"> = {
  type: "cf_aig",
  reservedHeaders: ["cf-aig-authorization", "cf-aig-metadata"],
  headerPrefix: "cf-aig-",
  clientHeaders: [
    "cf-aig-cache-ttl",
    "cf-aig-skip-cache",
    "cf-aig-max-attempts",
    "cf-aig-backoff",
    "cf-aig-retry-delay",
  ],
  // The organization stores its own provider keys in its own gateway's BYOK
  // store; there is no Cloudflare-supplied credential to fall back to. That is
  // configuration, not something read off a response.
  credentialSource: "byok",
  routes: CF_AIG_ROUTES,
  upstream(input) {
    const route = CF_AIG_ROUTES[input.provider];
    if (!route) throw unsupportedProvider("cf_aig", input.provider);
    return {
      // The gateway injects the provider key from its own store, so only the
      // gateway token travels and no provider-auth header is sent.
      url: `${cfAigUrl(input.config, route, input.providerPath)}${input.query}`,
      headers: {
        "cf-aig-authorization": `Bearer ${input.secret}`,
        "cf-aig-metadata": JSON.stringify({ app_id: input.appId, user_id: input.userId }),
      },
    };
  },
  probe(input) {
    const route = CF_AIG_ROUTES[input.provider];
    if (!route) return null;
    return {
      url: cfAigUrl(input.config, route, input.path),
      headers: { "cf-aig-authorization": `Bearer ${input.secret}` },
    };
  },
  validateRoute(route) {
    // Cloudflare's URL space is fully determined by the provider slug: there is
    // no namespace to map and no serving provider to pin. Accepting a route
    // config here would store one nothing reads.
    if (route !== null) {
      throw new GatewayError(
        400,
        "invalid_request",
        "Cloudflare AI Gateway takes no per-provider routing configuration",
      );
    }
  },
};

/** Closed registry: every gateway type has exactly one adapter. */
export const GATEWAY_ADAPTERS: { [Type in ProviderGatewayType]: GatewayAdapter<Type> } = {
  cf_aig: cfAigAdapter,
};

export function gatewayAdapter<Type extends ProviderGatewayType>(
  type: Type,
): GatewayAdapter<Type> {
  return GATEWAY_ADAPTERS[type];
}

/**
 * Whether a gateway type stored in D1 has an adapter. The CHECK constraint is
 * deliberately wider than the adapter registry — widening it is a table rebuild
 * — so a stored row is not proof that this deployment can serve it.
 */
export function isGatewayType(name: ProviderGatewayTypeName): name is ProviderGatewayType {
  return Object.hasOwn(GATEWAY_ADAPTERS, name);
}

/**
 * Whose credential a route pays with. A direct row pays with the organization's
 * own provider key by construction; a gateway answers for itself.
 */
export function credentialSource(
  gateway: { type: ProviderGatewayType } | null,
): CredentialSource | null {
  return gateway === null ? "direct" : gatewayAdapter(gateway.type).credentialSource;
}

/** Rejects a provider row's route config the owning adapter cannot honour. */
export function assertGatewayRoute(
  gatewayType: ProviderGatewayType | null,
  route: GatewayRouteConfig | null,
): void {
  if (gatewayType === null) {
    if (route !== null) {
      throw new GatewayError(
        400,
        "invalid_request",
        "Routing configuration only applies to a provider routed through a gateway",
      );
    }
    return;
  }
  gatewayAdapter(gatewayType).validateRoute(route);
}

function unsupportedProvider(type: ProviderGatewayType, provider: ProviderType): GatewayError {
  return new GatewayError(
    502,
    "provider_unavailable",
    `Gateway ${type} does not serve ${provider} providers`,
  );
}

/**
 * Dispatches to the adapter the resolved gateway names. The discriminant and
 * the config travel together, so this is the only place a gateway type is
 * matched to its adapter.
 */
export function gatewayUpstream(input: {
  gateway: ResolvedGateway;
  secret: string;
  provider: ProviderType;
  providerPath: string;
  query: string;
  appId: string;
  userId: string;
}): GatewayRequest {
  const { gateway, ...rest } = input;
  return gatewayAdapter(gateway.type).upstream({ ...rest, config: gateway.config });
}

export function gatewayProbe(input: {
  gateway: ResolvedGateway;
  secret: string;
  provider: ProviderType;
  path: string;
}): GatewayRequest | null {
  const { gateway, ...rest } = input;
  return gatewayAdapter(gateway.type).probe({ ...rest, config: gateway.config });
}

import type { CfAigConfig, ProviderGatewayType } from "../db/schema";
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
  readonly routes: Partial<Record<ProviderType, GatewayProviderRoute>>;
  upstream(input: GatewayUpstreamInput<Type>): GatewayRequest;
  /** `null` when this gateway does not serve the provider type at all. */
  probe(input: GatewayProbeInput<Type>): GatewayRequest | null;
}

export const CF_AI_GATEWAY_BASE_URL = "https://gateway.ai.cloudflare.com/v1";

/**
 * Cloudflare's own provider slugs. `openai` is the only one whose slug already
 * implies the `v1/` prefix, so it is the only one that strips it.
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

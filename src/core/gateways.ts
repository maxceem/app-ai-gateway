import type {
  CfAigConfig,
  CredentialSource,
  GatewayRouteConfig,
  ProviderGatewayConfig,
  ProviderGatewayType,
  ProviderGatewayTypeName,
  VercelConfig,
} from "../db/schema";
import {
  CF_AIG_ROUTES,
  VERCEL_API_STYLES,
  VERCEL_ROUTES,
  type GatewayProviderRoute,
} from "../shared/capabilities";
import type { ApiStyle } from "./api-styles";
import { GatewayError } from "./errors";
import { recordOr } from "./records";
import type { ProviderType } from "./types";

/**
 * Non-secret configuration per gateway type. The key set *is*
 * {@link ProviderGatewayType}, so a new gateway type cannot be added without
 * giving it a config shape and an adapter.
 */
export interface GatewayConfigs {
  cf_aig: CfAigConfig;
  vercel: VercelConfig;
}

/** A gateway connection as resolved from an organization's row. */
export type ResolvedGateway = {
  [Type in ProviderGatewayType]: { type: Type; config: GatewayConfigs[Type] };
}[ProviderGatewayType];

// The route tables are shared with the console, which describes a gateway-routed
// row from exactly the mapping the adapters below route with.
export { type GatewayProviderRoute } from "../shared/capabilities";

/**
 * The namespace actually in force: the row's own override where it set one,
 * the adapter's per-provider default otherwise. A stored override reached
 * {@link GatewayAdapter.validateRoute} first, so it is one this gateway agreed
 * to; the default is what an unconfigured row gets.
 */
export function routePrefix(
  route: GatewayProviderRoute | undefined,
  config: GatewayRouteConfig | null | undefined,
): string | undefined {
  return config?.modelPrefix ?? route?.modelPrefix;
}

/** Canonical model ID to what this route puts on the wire. */
export function wireModel(
  route: GatewayProviderRoute | undefined,
  canonical: string,
  config?: GatewayRouteConfig | null,
): string {
  const prefix = routePrefix(route, config);
  return prefix ? `${prefix}${canonical}` : canonical;
}

/**
 * What this route put on the wire, back to the canonical model ID. Only the
 * route's *own* prefix comes off: canonical IDs may contain `/` themselves
 * (`fal-ai/fast-sdxl`, and every OpenRouter slug), so "everything before the
 * first slash" would silently rename them.
 */
export function canonicalModel(
  route: GatewayProviderRoute | undefined,
  wire: string,
  config?: GatewayRouteConfig | null,
): string {
  const prefix = routePrefix(route, config);
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
  /**
   * The provider's own probe path, adapted by the same rules as live traffic,
   * or `null` where that provider has none. A gateway whose credential is its
   * own — not a per-provider key it holds — has a probe regardless and ignores
   * this; a gateway that forwards to the provider's key store does not.
   */
  path: string | null;
}

/** Body the adapter may rewrite in place, and what it is allowed to know. */
export interface GatewayBodyInput {
  /** The provider row's stored routing configuration, already validated. */
  route: GatewayRouteConfig | null;
  style: ApiStyle;
  /** Mutated in place; the caller re-serializes only if `true` comes back. */
  body: Record<string, unknown>;
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
  /** `null` when this gateway has nothing cheap and authenticated to call. */
  probe(input: GatewayProbeInput<Type>): GatewayRequest | null;
  /**
   * A same-protocol rewrite this gateway's routing configuration asks for —
   * the kind model rewrites and output caps already are, never a conversion
   * between provider API formats. Returns whether the body changed. Absent
   * where a gateway expresses nothing in the body, which is the default.
   */
  mutateBody?(input: GatewayBodyInput): boolean;
  /**
   * Rejects a provider row's `gateway_route_json` this gateway cannot honour.
   * Called on every create and update, so a stored route is always one its
   * adapter agreed to.
   */
  validateRoute(route: GatewayRouteConfig | null): void;
}

export const CF_AI_GATEWAY_BASE_URL = "https://gateway.ai.cloudflare.com/v1";

/** The single place a Cloudflare AI Gateway URL is built: live traffic and
 *  credential probes join the same segments from the same route entry. */
function cfAigUrl(
  config: CfAigConfig,
  route: GatewayProviderRoute & { slug: string },
  path: string,
): string {
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
    // Cloudflare holds the provider's own key and forwards to the provider's
    // own API, so the only thing worth calling is a path that provider has.
    if (!route || input.path === null) return null;
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

/**
 * One origin for every provider and every API. Vercel puts no account, team, or
 * provider segment in the URL: the token names the team and the model ID names
 * the provider, so a client path (`v1/chat/completions`, `v1/responses`,
 * `v1/messages`) is appended verbatim and nothing is stripped or inserted.
 *
 * Verified against Vercel's docs (August 2026): the Chat Completions and
 * Responses APIs document `https://ai-gateway.vercel.sh/v1` as their base URL
 * with `/chat/completions` and `/responses` under it, and the Anthropic
 * Messages API documents `https://ai-gateway.vercel.sh` with `POST /v1/messages`
 * — the same absolute paths either way.
 */
export const VERCEL_AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/";

/**
 * The cheapest authenticated call on the gateway itself: it answers 401 to a
 * token that is not a real key, which is the whole point of a probe. Vercel's
 * `v1/models` is public and answers 200 with no credential at all, so it would
 * report a garbage key as good the moment a caller forgot the header.
 */
const VERCEL_PROBE_PATH = "v1/credits";

/**
 * Vercel's own request-metadata headers. A client value in either would rewrite
 * the operator's Vercel-side spend attribution, so both are reserved and set
 * server-side, exactly like `cf-aig-metadata`.
 */
const VERCEL_REPORTING_USER = "ai-reporting-user";
const VERCEL_REPORTING_TAGS = "ai-reporting-tags";
/** Vercel rejects the whole request with a 400 when either exceeds its limit. */
const VERCEL_USER_MAX = 256;
const VERCEL_TAG_MAX = 64;

/**
 * Whether a value can be a header value at all. `Headers.set` throws a TypeError
 * on anything outside the ByteString range, so a user id carrying a non-Latin-1
 * character (`józsef@example.com`) or a control character would turn every one of
 * that user's requests into a 500 — the id comes from an issuer's JWT claim, so
 * this is entirely reachable and entirely the user's own data.
 *
 * Printable ASCII plus space, which is narrower than the RFC allows on purpose:
 * the field is spend attribution, and anything Vercel or an intermediary might
 * parse differently is not worth the risk of a header-splitting surprise.
 */
function headerSafe(value: string): boolean {
  return /^[\x20-\x7E]*$/u.test(value);
}

/**
 * Attribution Vercel will accept. Anything over its documented limit, or that
 * cannot legally be a header value, is dropped rather than truncated or
 * transliterated: a mangled id is a wrong id, and sending one would turn every
 * request into a 400 or attribute it to somebody else. Dropping costs a row in
 * Vercel's own spend report; this deployment records the real user id either
 * way, in the usage event.
 */
function vercelReportingHeaders(appId: string, userId: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (userId && userId.length <= VERCEL_USER_MAX && headerSafe(userId)) {
    headers[VERCEL_REPORTING_USER] = userId;
  }
  const tag = `app:${appId}`;
  if (appId && tag.length <= VERCEL_TAG_MAX && headerSafe(tag)) {
    headers[VERCEL_REPORTING_TAGS] = tag;
  }
  return headers;
}

const vercelAdapter: GatewayAdapter<"vercel"> = {
  type: "vercel",
  reservedHeaders: [
    // Vercel accepts the gateway key in either header and lets it win over any
    // OIDC token, so a client value in either would spend somebody else's
    // credit — or, worse, the operator's under a key they cannot see.
    "authorization",
    "x-api-key",
    VERCEL_REPORTING_USER,
    VERCEL_REPORTING_TAGS,
  ],
  headerPrefix: "ai-reporting-",
  // Nothing in that namespace is client-settable: it is Vercel's spend
  // attribution, and this gateway is the only thing that knows the real app and
  // user behind a request.
  clientHeaders: [],
  // Vercel documents BYOK as *preferred*, with a documented fallback to its own
  // system credentials when a stored key fails — so no per-request guarantee
  // exists at configuration time. Null means "read it per event or record
  // unknown", never a claim that the organization's own key paid.
  credentialSource: null,
  routes: VERCEL_ROUTES,
  upstream(input) {
    const route = VERCEL_ROUTES[input.provider];
    if (!route) throw unsupportedProvider("vercel", input.provider);
    return {
      // No provider segment and no prefix surgery: the client path is already
      // the absolute path Vercel documents.
      url: `${VERCEL_AI_GATEWAY_BASE_URL}${input.providerPath}${input.query}`,
      headers: {
        authorization: `Bearer ${input.secret}`,
        ...vercelReportingHeaders(input.appId, input.userId),
      },
    };
  },
  probe(input) {
    // Provider-independent on purpose, and the provider's own probe path is
    // ignored: the credential here is the Vercel key, one per gateway, and the
    // provider keys it may use live in Vercel's dashboard where this deployment
    // cannot see them. The credits call proves exactly what this row will
    // authenticate with.
    if (!VERCEL_ROUTES[input.provider]) return null;
    return {
      url: `${VERCEL_AI_GATEWAY_BASE_URL}${VERCEL_PROBE_PATH}`,
      headers: { authorization: `Bearer ${input.secret}` },
    };
  },
  mutateBody(input) {
    const only = input.route?.providerOnly;
    if (!only || only.length === 0) return false;
    if (!VERCEL_API_STYLES.includes(input.style)) return false;
    // `providerOptions.gateway.only` is documented identically on all three of
    // Vercel's request shapes, and it is a routing directive rather than a
    // model-protocol field: the payload the provider eventually sees is
    // unchanged. Server-set, so a client cannot widen the pin it was given.
    const options = recordOr(input.body.providerOptions);
    const gateway = recordOr(options.gateway);
    input.body.providerOptions = { ...options, gateway: { ...gateway, only: [...only] } };
    return true;
  },
  validateRoute(route) {
    if (route === null) return;
    if (route.modelPrefix !== undefined && !route.modelPrefix.endsWith("/")) {
      throw new GatewayError(
        400,
        "invalid_request",
        "Vercel model namespaces end with a slash, for example google/",
      );
    }
    // `providerOnly` is checked by the schema for shape and by Vercel for
    // membership: its provider slugs are a live catalog, and a list frozen here
    // would reject a provider Vercel added last week.
  },
};

/** Closed registry: every gateway type has exactly one adapter. */
export const GATEWAY_ADAPTERS: { [Type in ProviderGatewayType]: GatewayAdapter<Type> } = {
  cf_aig: cfAigAdapter,
  vercel: vercelAdapter,
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
 * The stored type of a gateway row, narrowed to one this deployment can serve,
 * or a 400 naming the type it cannot. Every admin path that reads a stored
 * `provider_gateway.type` needs exactly this check and the same message, so it
 * lives here with {@link isGatewayType} rather than being written out at each
 * call site — where the day one of them forgot, a row with no adapter would be
 * read as another gateway's configuration.
 */
export function requireGatewayAdapter(name: ProviderGatewayTypeName): ProviderGatewayType {
  if (isGatewayType(name)) return name;
  throw new GatewayError(
    400,
    "invalid_request",
    `This deployment has no adapter for ${name} provider gateways`,
  );
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
  path: string | null;
}): GatewayRequest | null {
  const { gateway, ...rest } = input;
  return gatewayAdapter(gateway.type).probe({ ...rest, config: gateway.config });
}

/**
 * The gateway's own same-protocol rewrite of an outbound body, if it has one.
 * Returns whether the body changed, so an untouched request keeps its original
 * bytes — the pass-through guarantee is that nothing is re-encoded for free.
 */
export function gatewayBodyMutation(input: {
  gatewayType: ProviderGatewayType | null;
  route: GatewayRouteConfig | null;
  style: ApiStyle;
  body: Record<string, unknown>;
}): boolean {
  if (input.gatewayType === null) return false;
  const adapter: GatewayAdapter<ProviderGatewayType> = gatewayAdapter(input.gatewayType);
  return adapter.mutateBody?.({ route: input.route, style: input.style, body: input.body }) ?? false;
}

/**
 * Joins a stored `type`/`config_json` pair into the discriminated union the
 * adapters take. The database keeps the two in separate columns and its CHECK is
 * wider than the adapter registry, so this is the one place they are matched up
 * — call it only behind {@link isGatewayType} or {@link requireGatewayAdapter}.
 *
 * One cast, and it is the honest one: nothing here validates the config against
 * the type. `config_json` is written only by the create route, which builds the
 * union field by field from a checked contract, so the pairing is guaranteed
 * upstream rather than here. The previous shape branched on `type` to pick which
 * unchecked cast to apply, which read like a discrimination and was not one.
 */
export function resolveGateway(
  type: ProviderGatewayType,
  config: ProviderGatewayConfig,
): ResolvedGateway {
  return { type, config } as ResolvedGateway;
}

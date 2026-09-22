import type {
  CfAigConfig,
  GatewayRouteConfig,
  ProviderGatewayConfig,
  VercelConfig,
} from "../db/schema";
import {
  CF_AIG_ROUTES,
  narrowedCapability,
  VERCEL_API_STYLES,
  VERCEL_ROUTES,
  type GatewayProviderRoute,
  type GatewayType,
  type RouteCapability,
} from "../shared/capabilities";
import { recordOr } from "../shared/records";
import { GatewayError } from "./errors";
import { providerCapability, providerDescriptor, type ProviderType } from "./providers";
import type { RouteAdapter } from "./routes";

// The route tables are shared with the console, which describes a gateway-routed
// row from exactly the mapping the adapters below route with.
export { type GatewayProviderRoute } from "../shared/capabilities";

/**
 * A gateway route only ever narrows what the provider already offers: an
 * adapter cannot invent an operation the provider does not have. Both adapters
 * answer {@link RouteAdapter.capability} this way, from their own route table.
 */
function gatewayCapability(
  routes: Partial<Record<ProviderType, GatewayProviderRoute>>,
  provider: ProviderType,
): RouteCapability | null {
  return narrowedCapability(providerCapability(provider), routes[provider]);
}

/**
 * The gateway row's stored configuration as the adapter's own shape.
 *
 * One cast, and it is the honest one: nothing here validates the config against
 * the type. `config_json` is written only by the create route, which builds the
 * union field by field from a checked contract, so the pairing is guaranteed
 * upstream rather than here. Every adapter reads its config through this one
 * helper, behind `isGatewayType` or `requireGatewayAdapter`: branching on
 * `type` to pick which unchecked cast to apply would read like a
 * discrimination without being one.
 */
function gatewayConfig<Config extends ProviderGatewayConfig>(
  config: ProviderGatewayConfig | null,
): Config {
  return (config ?? {}) as Config;
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

export const cfAigAdapter: RouteAdapter = {
  kind: "cf_aig",
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
  capability: (provider) => gatewayCapability(CF_AIG_ROUTES, provider),
  providerRoute: (provider) => CF_AIG_ROUTES[provider],
  upstream(input) {
    const route = CF_AIG_ROUTES[input.provider];
    if (!route) throw unsupportedProvider("cf_aig", input.provider);
    return {
      // The gateway injects the provider key from its own store, so only the
      // gateway token travels and no provider-auth header is sent.
      url: `${cfAigUrl(gatewayConfig<CfAigConfig>(input.gatewayConfig), route, input.providerPath)}${input.query}`,
      headers: {
        "cf-aig-authorization": `Bearer ${input.secret}`,
        // `user_id` is omitted rather than sent as null when the application
        // identifies no end users: the gateway's metadata is a record of who
        // made the call, and a null there reads as a lost value.
        "cf-aig-metadata": JSON.stringify({
          app_id: input.appId,
          ...(input.userId === null ? {} : { user_id: input.userId }),
        }),
      },
    };
  },
  probe(input) {
    const route = CF_AIG_ROUTES[input.provider];
    // Cloudflare holds the provider's own key and forwards to the provider's
    // own API, so the only thing worth calling is a path that provider has,
    // adapted by the same rules as live traffic. A provider with no cheap
    // authenticated call of its own leaves nothing to prove here.
    const path = providerDescriptor(input.provider).probePath;
    if (!route || path === undefined) return null;
    return {
      url: cfAigUrl(gatewayConfig<CfAigConfig>(input.gatewayConfig), route, path),
      headers: { "cf-aig-authorization": `Bearer ${input.secret}` },
    };
  },
  validateRouteConfig(config) {
    // Cloudflare's URL space is fully determined by the provider slug: there is
    // no namespace to map and no serving provider to pin. Accepting a route
    // config here would store one nothing reads.
    if (config !== null) {
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
function vercelReportingHeaders(appId: string, userId: string | null): Record<string, string> {
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

export const vercelAdapter: RouteAdapter = {
  kind: "vercel",
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
  capability: (provider) => gatewayCapability(VERCEL_ROUTES, provider),
  providerRoute: (provider) => VERCEL_ROUTES[provider],
  upstream(input) {
    const route = VERCEL_ROUTES[input.provider];
    if (!route) throw unsupportedProvider("vercel", input.provider);
    // Vercel's stored configuration is empty by design — the token names the
    // team — so the URL below needs nothing out of it.
    gatewayConfig<VercelConfig>(input.gatewayConfig);
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
    const only = input.routeConfig?.providerOnly;
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
  validateRouteConfig(config: GatewayRouteConfig | null) {
    if (config === null) return;
    if (config.modelPrefix !== undefined && !config.modelPrefix.endsWith("/")) {
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

function unsupportedProvider(type: GatewayType, provider: ProviderType): GatewayError {
  return new GatewayError(
    502,
    "provider_unavailable",
    `Gateway ${type} does not serve ${provider} providers`,
  );
}

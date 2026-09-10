/**
 * The capability matrix, as data. One source for the Worker and the console.
 *
 * This module imports nothing, on purpose. The console bundles it directly, so
 * a single import of `drizzle-orm`, the Worker's environment types, or anything
 * else from `src/core` would pull the server into a browser build. Everything
 * here is a plain table or a pure function over one; the behaviour that reads
 * these tables — adapters, validation, request construction — stays in
 * `src/core`, and the console has its own presentation layer over them.
 *
 * The console used to hand-mirror all of it: a second provider list, a second
 * cost-reporting list, a second copy of both gateways' route tables. Every one
 * of those was a table that could drift from the backend that enforces it, and
 * a console that offers a combination the server refuses is a bug report.
 */

export const PROVIDER_TYPES = [
  "openai",
  "anthropic",
  "xai",
  "gemini",
  "perplexity",
  "deepseek",
  "groq",
  "mistral",
  "together",
  "fireworks",
  "cerebras",
  "moonshot",
  "huggingface",
  "baseten",
  "bytedance",
  "openrouter",
] as const;

export type ProviderType = (typeof PROVIDER_TYPES)[number];

/**
 * The API contract a proxied request speaks. It names the *operation*, not the
 * provider serving it: `chat/completions` is the same request and response
 * shape whether OpenAI, Perplexity, or a gateway in front of them answers it.
 */
export const API_STYLES = [
  "responses",
  "chat_completions",
  "anthropic_messages",
  "gemini_native",
  "audio_transcription",
  /** A provider-native operation with no cross-provider contract of its own. */
  "other",
] as const;

export type ApiStyle = (typeof API_STYLES)[number];

/**
 * The path each cross-provider style is reached at *through a gateway that
 * publishes one URL space for every provider it serves*. Direct rows have no
 * entry here on purpose: each provider names its own prefix
 * (`chat/completions` on DeepSeek, `openai/v1/chat/completions` on Groq).
 *
 * `other` is absent because it names no contract and so has no canonical path.
 * A test pins every entry against `apiStyleFromPath`, so the table cannot come
 * to disagree with the classifier that judges real requests.
 */
export const API_STYLE_PATHS = {
  responses: "v1/responses",
  chat_completions: "v1/chat/completions",
  anthropic_messages: "v1/messages",
  gemini_native: "v1beta/models/{model}:generateContent",
  audio_transcription: "v1/audio/transcriptions",
} as const satisfies Partial<Record<ApiStyle, string>>;

export const ENDPOINT_API_STYLES = ["responses", "transcription"] as const;

export type EndpointApiStyle = (typeof ENDPOINT_API_STYLES)[number];

/**
 * The client API a named endpoint of each style composes, so endpoint
 * eligibility comes off the same matrix the proxy paths do rather than a second
 * list of its own.
 */
export const ENDPOINT_STYLE_API = {
  responses: "responses",
  transcription: "audio_transcription",
} as const satisfies Record<EndpointApiStyle, ApiStyle>;

/** The body field a request's output cap is clamped in. */
export const OUTPUT_CLAMP_STYLES = [
  "responses",
  "chat_completions",
  "gemini_native",
  "anthropic",
  "none",
] as const;

export type OutputClampStyle = (typeof OUTPUT_CLAMP_STYLES)[number];

/** Gateway types with an adapter, and so the only ones that can carry traffic. */
export const GATEWAY_TYPES = ["cf_aig", "vercel"] as const;

export type GatewayType = (typeof GATEWAY_TYPES)[number];

/** Where a provider instance's traffic goes: the provider's own API, or a gateway. */
export type ProviderRoute = "direct" | GatewayType;

export interface RouteCapability {
  /** Client API styles this route forwards. */
  apiStyles: readonly ApiStyle[];
  /** Named-endpoint styles composable for this provider on this route. */
  endpointStyles: readonly EndpointApiStyle[];
}

/**
 * What a provider type can do on its own API when nothing says otherwise. The
 * raw proxy is a pass-through, so every style reaches every provider and the
 * provider itself answers for the paths it does not have; named endpoints are
 * empty, because the gateway would have to compose those request bodies itself
 * and nothing has been verified against most providers' own request shapes.
 */
export const PASSTHROUGH_CAPABILITY: RouteCapability = {
  apiStyles: API_STYLES,
  endpointStyles: [],
};

/**
 * The provider types that depart from {@link PASSTHROUGH_CAPABILITY}, and only
 * those. Every entry is a decision with a reason attached; a type with no entry
 * inherits the default, which is what keeps adding a provider type a registry
 * change rather than a matrix change.
 */
export const PROVIDER_CAPABILITY_EXCEPTIONS = {
  // The two types whose Responses and transcription request shapes the gateway
  // composes itself for named endpoints.
  openai: { apiStyles: API_STYLES, endpointStyles: ["responses", "transcription"] },
  xai: { apiStyles: API_STYLES, endpointStyles: ["responses", "transcription"] },
  // The one narrowed API surface, and it is a metering constraint rather than a
  // missing one: OpenRouter also serves `/responses` and `/messages`, but only
  // its chat-completions response carries `usage.cost`, and its slugs have no
  // local price. Any other style would proxy traffic nothing could bill —
  // exactly the silent $0 the fail-closed gate exists to prevent — so it is
  // refused at the edge instead.
  openrouter: { apiStyles: ["chat_completions"], endpointStyles: [] },
} as const satisfies Partial<Record<ProviderType, RouteCapability>>;

export function providerCapability(provider: ProviderType): RouteCapability {
  const exceptions: Partial<Record<ProviderType, RouteCapability>> =
    PROVIDER_CAPABILITY_EXCEPTIONS;
  return exceptions[provider] ?? PASSTHROUGH_CAPABILITY;
}

/**
 * Provider types with a named-endpoint surface. Derived from the exception table
 * alone, which is sound by construction: the default carries no endpoint styles,
 * so a type that composes one has to say so there.
 */
export type EndpointProvider = {
  [Type in keyof typeof PROVIDER_CAPABILITY_EXCEPTIONS]:
    (typeof PROVIDER_CAPABILITY_EXCEPTIONS)[Type]["endpointStyles"] extends readonly []
      ? never
      : Type;
}[keyof typeof PROVIDER_CAPABILITY_EXCEPTIONS];

export const ENDPOINT_PROVIDER_TYPES = PROVIDER_TYPES.filter(
  (type): type is EndpointProvider => providerCapability(type).endpointStyles.length > 0,
) as [EndpointProvider, ...EndpointProvider[]];

/** Provider types eligible for a named endpoint style on their own API. */
export function providersForEndpointStyle(style: EndpointApiStyle): EndpointProvider[] {
  return ENDPOINT_PROVIDER_TYPES.filter((type) =>
    providerCapability(type).endpointStyles.includes(style),
  );
}

/**
 * How one gateway reaches one provider type. A provider type with no entry is
 * not served by that gateway at all — the safe default, so adding a provider
 * type never requires touching an adapter.
 */
export interface GatewayProviderRoute {
  /**
   * Path segment naming the provider inside the gateway's URL space. Absent
   * where the gateway has no per-provider URL space at all: Vercel names the
   * provider in the model ID and serves every one of them from the same paths.
   */
  slug?: string;
  /** Prefix the slug already implies, stripped from the client's path. */
  stripPathPrefix?: string;
  /**
   * When present, the only API styles this route forwards. Absent means the
   * gateway is transparent and the provider itself is the only judge.
   */
  apiStyles?: readonly ApiStyle[];
  /**
   * When present, the only named-endpoint styles this route composes. Absent
   * means the gateway carries whatever the provider's own API offers, which is
   * true of a transparent gateway and false of one that reimplements a subset.
   */
  endpointStyles?: readonly EndpointApiStyle[];
  /**
   * The gateway's namespace for this provider's models. Canonical model IDs —
   * the provider's own, which are what `prices.json`, `allowed_models` and the
   * recorded usage all use — get it prepended on the way out and stripped on
   * the way back. Absent means the gateway speaks the provider's IDs verbatim.
   */
  modelPrefix?: string;
}

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
 *
 * No `apiStyles`: Cloudflare forwards to each provider's own API under a
 * provider slug, so every API that provider has survives, native ones included.
 */
export const CF_AIG_ROUTES: Partial<
  Record<ProviderType, GatewayProviderRoute & { slug: string }>
> = {
  openai: { slug: "openai", stripPathPrefix: "v1/" },
  anthropic: { slug: "anthropic" },
  xai: { slug: "grok" },
  gemini: { slug: "google-ai-studio" },
  perplexity: { slug: "perplexity-ai" },
};

/**
 * The three client APIs Vercel documents in front of every model: OpenAI
 * Responses, OpenAI Chat Completions, and Anthropic Messages. Vercel translates
 * between them and the serving provider's own protocol; this gateway does not,
 * and forwards whichever one the client called unchanged.
 *
 * `gemini_native` is deliberately absent — Vercel publishes no
 * `generateContent` surface, so a Gemini row routed here is refused that API at
 * the edge instead of 404ing upstream. `audio_transcription` is absent for the
 * same reason, verified rather than assumed: `v1/audio/transcriptions` answers
 * `404 not_found_error` on this origin.
 */
export const VERCEL_API_STYLES: readonly ApiStyle[] = [
  "responses",
  "chat_completions",
  "anthropic_messages",
];

/**
 * Named endpoints this gateway can compose. `responses` only: `transcription`
 * would post to `v1/audio/transcriptions`, which Vercel does not serve.
 */
export const VERCEL_ENDPOINT_STYLES: readonly EndpointApiStyle[] = ["responses"];

/**
 * Every Vercel route is the same capability set behind a different namespace, so
 * the namespace is the only thing worth writing per provider type.
 */
function vercelRoute(modelPrefix: string): GatewayProviderRoute {
  return {
    modelPrefix,
    apiStyles: VERCEL_API_STYLES,
    endpointStyles: VERCEL_ENDPOINT_STYLES,
  };
}

/**
 * Vercel's model-ID namespace per provider type, and the *only* thing that maps
 * one of our provider types onto its catalog. Each entry was checked against the
 * live `https://ai-gateway.vercel.sh/v1/models` listing, not inferred from a
 * provider's name: the namespace is the model's *creator*, so it matches the
 * provider type only for types that serve their own models.
 *
 * `xai` is the trap the check exists for — Vercel lists Grok under
 * `spacexai/`, not `xai/`, so a guessed prefix would 404 every request.
 *
 * Absent, and why:
 * - `mistral` — Vercel's IDs are release-pinned (`mistral/mistral-large-3`)
 *   while Mistral's own API IDs are the `-latest` aliases, so canonical + prefix
 *   is not the wire ID and every request would miss.
 * - `bytedance` — same mismatch: Vercel serves `bytedance/seed-*` where ModelArk
 *   takes its own `seed-*-<date>` endpoint IDs.
 * - `groq`, `together`, `fireworks`, `cerebras`, `huggingface`, `baseten` —
 *   these are *hosts*, not model authors. Vercel has no namespace for them at
 *   all; it names them as serving providers instead (`providerOnly`). A row of
 *   one of these types stays direct-only.
 * - `openrouter` — an aggregator whose slugs are already its canonical models.
 */
export const VERCEL_ROUTES: Partial<Record<ProviderType, GatewayProviderRoute>> = {
  openai: vercelRoute("openai/"),
  anthropic: vercelRoute("anthropic/"),
  // Google AI Studio's models are Google's, and Vercel namespaces them by
  // author: `gemini-2.5-flash` goes out as `google/gemini-2.5-flash`.
  gemini: vercelRoute("google/"),
  xai: vercelRoute("spacexai/"),
  perplexity: vercelRoute("perplexity/"),
  deepseek: vercelRoute("deepseek/"),
  // Moonshot's own IDs are the Kimi ones, and Vercel publishes them verbatim
  // under the lab's name rather than the product's: `moonshotai/kimi-k3`.
  moonshot: vercelRoute("moonshotai/"),
};

/** Which provider types each gateway serves, and how. */
export const GATEWAY_ROUTES: Record<
  GatewayType,
  Partial<Record<ProviderType, GatewayProviderRoute>>
> = {
  cf_aig: CF_AIG_ROUTES,
  vercel: VERCEL_ROUTES,
};

/**
 * A gateway route only ever narrows what the provider already offers: an
 * adapter cannot invent an operation the provider does not have. `null` when the
 * adapter has no mapping for the provider type, which makes that type
 * direct-only on this gateway.
 */
export function narrowedCapability(
  base: RouteCapability,
  route: GatewayProviderRoute | undefined,
): RouteCapability | null {
  if (!route) return null;
  const allowed = route.apiStyles;
  const allowedEndpoints = route.endpointStyles;
  return {
    apiStyles: allowed ? base.apiStyles.filter((style) => allowed.includes(style)) : base.apiStyles,
    endpointStyles: allowedEndpoints
      ? base.endpointStyles.filter((style) => allowedEndpoints.includes(style))
      : base.endpointStyles,
  };
}

/**
 * Provider types whose own responses carry a per-request cost, so their models
 * proxy with no local price at all and the recorded cost is the upstream's own
 * figure. The Worker's registry is authoritative — the integration that parses
 * the report lives there, and a name here without one would bill nothing — so a
 * test pins this list to it.
 */
export const COST_REPORTING_PROVIDER_TYPES: readonly ProviderType[] = ["openrouter"];

export function reportsCost(type: string): boolean {
  return (COST_REPORTING_PROVIDER_TYPES as readonly string[]).includes(type);
}

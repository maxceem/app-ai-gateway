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
] as const;

// Flag-free on purpose: this source string is published verbatim as an
// OpenAPI `pattern`, where a trailing JS flag would make the regex invalid.
export const PROVIDER_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const ENDPOINT_API_STYLES = ["responses", "transcription"] as const;

export type EndpointApiStyle = (typeof ENDPOINT_API_STYLES)[number];

/**
 * How a provider authenticates a direct call. The header name and the scheme
 * prefix are free-form: providers name their key header whatever they like
 * (`x-api-key`, `x-goog-api-key`, `DeepL-Auth-Key`), and the sanitizer derives
 * its strip list from these declarations rather than repeating them.
 */
export interface ProviderAuth {
  /** Lower-case header name; header lookups are case-insensitive anyway. */
  header: string;
  /** Placed verbatim in front of the secret, trailing space included. */
  scheme?: string;
}

export interface ProviderSpec {
  directBaseUrl: string;
  auth: ProviderAuth;
  /**
   * Whether this provider reports what a request cost, per request, in its own
   * response. Absent means it does not, which is the fail-closed default: such
   * traffic is only billable when the canonical model has a local price.
   */
  reportsCost?: boolean;
  /**
   * Who makes the models this provider type serves, when one answer is right
   * for all of them. Absent for aggregators, which serve many authors' models
   * and resolve authorship per model instead.
   */
  modelAuthor?: string;
}

/**
 * Gateway routing is deliberately absent: which gateway reaches which provider
 * type is the gateway adapter's business (`src/core/gateways.ts`), so adding a
 * provider type never means editing an adapter.
 */
export const PROVIDER_REGISTRY = {
  openai: {
    directBaseUrl: "https://api.openai.com/",
    auth: { header: "authorization", scheme: "Bearer " },
    modelAuthor: "OpenAI",
  },
  anthropic: {
    directBaseUrl: "https://api.anthropic.com/",
    auth: { header: "x-api-key" },
    modelAuthor: "Anthropic",
  },
  xai: {
    directBaseUrl: "https://api.x.ai/",
    auth: { header: "authorization", scheme: "Bearer " },
    modelAuthor: "xAI",
  },
  gemini: {
    directBaseUrl: "https://generativelanguage.googleapis.com/",
    auth: { header: "x-goog-api-key" },
    modelAuthor: "Google",
  },
  perplexity: {
    directBaseUrl: "https://api.perplexity.ai/",
    auth: { header: "authorization", scheme: "Bearer " },
    modelAuthor: "Perplexity",
  },

  // OpenAI-compatible chat-completions services. `modelAuthor` is set only
  // where one answer is right for every model the type serves; the hosts below
  // that carry no author serve other labs' open-weight models, and authorship
  // comes from the catalog entry per model instead.

  deepseek: {
    // No `v1` segment: DeepSeek documents the bare origin as its OpenAI base
    // URL, and `https://api.deepseek.com/anthropic` for the Anthropic format.
    directBaseUrl: "https://api.deepseek.com/",
    auth: { header: "authorization", scheme: "Bearer " },
    modelAuthor: "DeepSeek",
  },
  groq: {
    // Groq's OpenAI-compatible surface lives under `openai/v1/`, so the client
    // path is `openai/v1/chat/completions` rather than `v1/chat/completions`.
    directBaseUrl: "https://api.groq.com/",
    auth: { header: "authorization", scheme: "Bearer " },
  },
  mistral: {
    directBaseUrl: "https://api.mistral.ai/",
    auth: { header: "authorization", scheme: "Bearer " },
    modelAuthor: "Mistral",
  },
  together: {
    // `api.together.ai`, not the `.xyz` host older SDKs default to: the current
    // OpenAI-compatibility guide names this one and warns against the other.
    directBaseUrl: "https://api.together.ai/",
    auth: { header: "authorization", scheme: "Bearer " },
  },
  fireworks: {
    // The inference plane is `/inference/v1`; `/v1` on the same host is the
    // control plane, so the client path is `inference/v1/chat/completions`.
    directBaseUrl: "https://api.fireworks.ai/",
    auth: { header: "authorization", scheme: "Bearer " },
  },
  cerebras: {
    directBaseUrl: "https://api.cerebras.ai/",
    auth: { header: "authorization", scheme: "Bearer " },
  },
  moonshot: {
    // The international host. `api.moonshot.cn` is the separate China platform
    // and is not reachable with a key issued for this one.
    directBaseUrl: "https://api.moonshot.ai/",
    auth: { header: "authorization", scheme: "Bearer " },
    modelAuthor: "Moonshot AI",
  },
  huggingface: {
    // The Inference Providers router: one OpenAI-compatible surface in front of
    // many upstreams, so it has no author of its own and no stable per-model
    // price — the router picks the upstream, and the same model ID costs an
    // order of magnitude more on some of them than others. It ships with no
    // catalog section for that reason; see `catalogPrice` in usage.ts.
    directBaseUrl: "https://router.huggingface.co/",
    auth: { header: "authorization", scheme: "Bearer " },
  },
  baseten: {
    // The Model APIs inference host. `api.baseten.co` is the management plane
    // for dedicated deployments and answers to different paths entirely.
    directBaseUrl: "https://inference.baseten.co/",
    auth: { header: "authorization", scheme: "Bearer " },
  },
  bytedance: {
    // BytePlus ModelArk, the international edition: `/api/v3` is its version
    // segment, so client paths carry no `v1`. `ark.cn-beijing.volces.com` is
    // the separate China platform, and `ark.eu-west.bytepluses.com` is a second
    // region — keys and catalogs are region-isolated, so reaching either needs
    // the per-row base URL override that Stage 6 introduces.
    directBaseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3/",
    auth: { header: "authorization", scheme: "Bearer " },
  },
} as const satisfies Record<ProviderType, ProviderSpec>;

/**
 * The registry entry widened to {@link ProviderSpec}. The registry itself is
 * `as const` so `auth.scheme` narrows per entry; reading an optional flag off
 * that literal type needs the declared shape back.
 */
function providerSpec(type: ProviderType): ProviderSpec {
  return PROVIDER_REGISTRY[type];
}

/** Whether this provider type's own responses carry a per-request cost. */
export function reportsCost(type: ProviderType): boolean {
  return providerSpec(type).reportsCost === true;
}

/** The author every model of this provider type has, when there is one. */
export function providerModelAuthor(type: ProviderType): string | null {
  return providerSpec(type).modelAuthor ?? null;
}

/** The credential header value a direct call to this provider carries. */
export function providerAuthValue(type: ProviderType, secret: string): string {
  const { auth } = PROVIDER_REGISTRY[type];
  return `${"scheme" in auth ? auth.scheme : ""}${secret}`;
}

export function isProviderType(value: unknown): value is ProviderType {
  return typeof value === "string" && Object.hasOwn(PROVIDER_REGISTRY, value);
}

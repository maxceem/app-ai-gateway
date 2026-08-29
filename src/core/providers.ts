export const PROVIDER_TYPES = [
  "openai",
  "anthropic",
  "xai",
  "gemini",
  "perplexity",
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
  },
  anthropic: {
    directBaseUrl: "https://api.anthropic.com/",
    auth: { header: "x-api-key" },
  },
  xai: {
    directBaseUrl: "https://api.x.ai/",
    auth: { header: "authorization", scheme: "Bearer " },
  },
  gemini: {
    directBaseUrl: "https://generativelanguage.googleapis.com/",
    auth: { header: "x-goog-api-key" },
  },
  perplexity: {
    directBaseUrl: "https://api.perplexity.ai/",
    auth: { header: "authorization", scheme: "Bearer " },
  },
} as const satisfies Record<ProviderType, ProviderSpec>;

/** The credential header value a direct call to this provider carries. */
export function providerAuthValue(type: ProviderType, secret: string): string {
  const { auth } = PROVIDER_REGISTRY[type];
  return `${"scheme" in auth ? auth.scheme : ""}${secret}`;
}

export function isProviderType(value: unknown): value is ProviderType {
  return typeof value === "string" && Object.hasOwn(PROVIDER_REGISTRY, value);
}

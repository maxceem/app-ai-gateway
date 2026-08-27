export const PROVIDER_TYPES = [
  "openai",
  "anthropic",
  "xai",
  "gemini",
  "perplexity",
] as const;

export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const ENDPOINT_API_STYLES = ["responses", "transcription"] as const;

export type EndpointApiStyle = (typeof ENDPOINT_API_STYLES)[number];

export interface ProviderSpec {
  directBaseUrl: string;
  auth: {
    header: "authorization" | "x-api-key" | "x-goog-api-key";
    scheme?: "Bearer ";
  };
  aig: {
    slug: string;
    stripPathPrefix?: string;
  };
  endpointStyles?: readonly EndpointApiStyle[];
}

export const PROVIDER_REGISTRY = {
  openai: {
    directBaseUrl: "https://api.openai.com/",
    auth: { header: "authorization", scheme: "Bearer " },
    aig: { slug: "openai", stripPathPrefix: "v1/" },
    endpointStyles: ["responses", "transcription"],
  },
  anthropic: {
    directBaseUrl: "https://api.anthropic.com/",
    auth: { header: "x-api-key" },
    aig: { slug: "anthropic" },
  },
  xai: {
    directBaseUrl: "https://api.x.ai/",
    auth: { header: "authorization", scheme: "Bearer " },
    aig: { slug: "grok" },
    endpointStyles: ["responses", "transcription"],
  },
  gemini: {
    directBaseUrl: "https://generativelanguage.googleapis.com/",
    auth: { header: "x-goog-api-key" },
    aig: { slug: "google-ai-studio" },
  },
  perplexity: {
    directBaseUrl: "https://api.perplexity.ai/",
    auth: { header: "authorization", scheme: "Bearer " },
    aig: { slug: "perplexity-ai" },
  },
} as const satisfies Record<ProviderType, ProviderSpec>;

export type EndpointProvider = {
  [Type in ProviderType]: (typeof PROVIDER_REGISTRY)[Type] extends {
    endpointStyles: readonly EndpointApiStyle[];
  }
    ? Type
    : never;
}[ProviderType];

export const ENDPOINT_PROVIDER_TYPES = PROVIDER_TYPES.filter(
  (type): type is EndpointProvider => "endpointStyles" in PROVIDER_REGISTRY[type],
) as [EndpointProvider, ...EndpointProvider[]];

export function isProviderType(value: unknown): value is ProviderType {
  return typeof value === "string" && Object.hasOwn(PROVIDER_REGISTRY, value);
}

export function providersForEndpointStyle(style: EndpointApiStyle): EndpointProvider[] {
  return ENDPOINT_PROVIDER_TYPES.filter((type) =>
    PROVIDER_REGISTRY[type].endpointStyles.includes(style),
  );
}

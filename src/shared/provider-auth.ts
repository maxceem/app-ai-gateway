import type { ProviderType } from "./capabilities.ts";

/** Lightweight credential metadata shared by the proxy and configuration parser. */
export interface ProviderAuth {
  header: string;
  scheme?: string;
}

export const PROVIDER_AUTH = {
  openai: { header: "authorization", scheme: "Bearer " },
  anthropic: { header: "x-api-key" },
  xai: { header: "authorization", scheme: "Bearer " },
  gemini: { header: "x-goog-api-key" },
  perplexity: { header: "authorization", scheme: "Bearer " },
  deepseek: { header: "authorization", scheme: "Bearer " },
  groq: { header: "authorization", scheme: "Bearer " },
  mistral: { header: "authorization", scheme: "Bearer " },
  together: { header: "authorization", scheme: "Bearer " },
  fireworks: { header: "authorization", scheme: "Bearer " },
  cerebras: { header: "authorization", scheme: "Bearer " },
  moonshot: { header: "authorization", scheme: "Bearer " },
  huggingface: { header: "authorization", scheme: "Bearer " },
  baseten: { header: "authorization", scheme: "Bearer " },
  bytedance: { header: "authorization", scheme: "Bearer " },
  openrouter: { header: "authorization", scheme: "Bearer " },
} as const satisfies Record<ProviderType, ProviderAuth>;

export const PROVIDER_CREDENTIAL_HEADERS = [
  ...new Set(Object.values(PROVIDER_AUTH).map((auth) => auth.header.toLowerCase())),
] as readonly string[];

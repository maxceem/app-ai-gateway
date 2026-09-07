import type { OutputClampStyle, ProviderType } from "./types";

// Shared with the console, which lists these styles in its capability panels.
export { API_STYLES, type ApiStyle } from "../shared/capabilities";

import type { ApiStyle } from "../shared/capabilities";

/**
 * Classifies the requested operation from the provider path alone. Provider
 * identity is deliberately not consulted: the same path is the same operation
 * on every route that offers it, which is what makes the capability matrix
 * expressible.
 */
export function apiStyleFromPath(providerPath: string): ApiStyle {
  if (providerPath.endsWith("audio/transcriptions") || providerPath === "v1/stt") {
    return "audio_transcription";
  }
  if (providerPath.includes("chat/completions")) return "chat_completions";
  if (providerPath.endsWith("responses")) return "responses";
  // Case-sensitive on purpose: `:streamGenerateContent` does not match here and
  // never has, so it resolves through the provider's own shape below. Widening
  // the test would change the clamped field for providers other than Gemini.
  if (providerPath.includes("generateContent")) return "gemini_native";
  if (providerPath.endsWith("messages")) return "anthropic_messages";
  return "other";
}

/**
 * The output cap each style clamps, where the style alone settles it.
 *
 * `anthropic_messages` and `other` are absent on purpose: the body they clamp
 * is the provider's own, so they fall through to {@link NATIVE_CLAMP_STYLE}.
 * That keeps a stray `…/messages` path on a non-Anthropic provider clamped
 * exactly as it was before this table existed.
 */
const STYLE_CLAMP_STYLE: Partial<Record<ApiStyle, OutputClampStyle>> = {
  audio_transcription: "none",
  chat_completions: "chat_completions",
  responses: "responses",
  gemini_native: "gemini_native",
};

/**
 * Each provider type's own request shape. The Stage 3 batch is
 * chat-completions-native — `max_tokens` is the cap in every one of their own
 * bodies — so a provider-native path with no cross-provider style still clamps
 * the field those providers actually read.
 */
const NATIVE_CLAMP_STYLE: Record<ProviderType, OutputClampStyle> = {
  openai: "responses",
  anthropic: "anthropic",
  xai: "responses",
  gemini: "gemini_native",
  perplexity: "responses",
  deepseek: "chat_completions",
  groq: "chat_completions",
  mistral: "chat_completions",
  together: "chat_completions",
  fireworks: "chat_completions",
  cerebras: "chat_completions",
  moonshot: "chat_completions",
  huggingface: "chat_completions",
  baseten: "chat_completions",
  bytedance: "chat_completions",
  openrouter: "chat_completions",
};

export function outputClampStyle(style: ApiStyle, provider: ProviderType): OutputClampStyle {
  return STYLE_CLAMP_STYLE[style] ?? NATIVE_CLAMP_STYLE[provider];
}

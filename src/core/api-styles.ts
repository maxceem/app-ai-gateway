import type { OutputClampStyle, ProviderType } from "./types";

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

/** Each provider type's own request shape. */
const NATIVE_CLAMP_STYLE: Record<ProviderType, OutputClampStyle> = {
  openai: "responses",
  anthropic: "anthropic",
  xai: "responses",
  gemini: "gemini_native",
  perplexity: "responses",
};

export function outputClampStyle(style: ApiStyle, provider: ProviderType): OutputClampStyle {
  return STYLE_CLAMP_STYLE[style] ?? NATIVE_CLAMP_STYLE[provider];
}

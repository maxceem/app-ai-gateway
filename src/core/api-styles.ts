import { providerDescriptor, type ProviderType } from "../shared/providers.ts";
import type { OutputClampStyle } from "./types.ts";

// Shared with the console, which lists these styles in its capability panels.
export { API_STYLES, type ApiStyle } from "../shared/capabilities.ts";

import type { ApiStyle } from "../shared/capabilities.ts";

/**
 * Exact path shapes that participate in the implicit inference policy.
 *
 * These match supported provider URL layouts, not arbitrary suffixes. The
 * classifier is also an authorization boundary when `allowed_paths` is empty,
 * so a control-plane path that happens to end in `messages` or `responses`
 * must remain `other`.
 */
const API_STYLE_PATH_MATCHERS = [
  {
    style: "audio_transcription",
    pattern: /^(?:(?:v1|openai\/v1)\/audio\/transcriptions|v1\/stt)$/u,
  },
  {
    style: "chat_completions",
    pattern: /^(?:chat|v1\/chat|openai\/v1\/chat|inference\/v1\/chat|v1beta\/openai\/chat)\/completions$/u,
  },
  { style: "responses", pattern: /^(?:v1|openai\/v1)\/responses$/u },
  {
    style: "gemini_native",
    pattern: /^v1(?:alpha|beta)?\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/u,
  },
  { style: "anthropic_messages", pattern: /^v1\/messages$/u },
] as const satisfies readonly { style: ApiStyle; pattern: RegExp }[];

/**
 * Classifies the requested operation from the provider path alone. Provider
 * identity is deliberately not consulted: the same path is the same operation
 * on every route that offers it, which is what makes the capability matrix
 * expressible.
 */
export function apiStyleFromPath(providerPath: string): ApiStyle {
  return API_STYLE_PATH_MATCHERS.find(({ pattern }) => pattern.test(providerPath))?.style ?? "other";
}

/**
 * The output cap each style clamps, where the style alone settles it.
 *
 * `anthropic_messages` and `other` are absent on purpose: the body they clamp
 * is the provider's own, so they fall through to the provider descriptor's
 * `nativeClampStyle`. That keeps a stray `…/messages` path on a non-Anthropic
 * provider clamped by that provider's own request shape.
 */
const STYLE_CLAMP_STYLE: Partial<Record<ApiStyle, OutputClampStyle>> = {
  audio_transcription: "none",
  chat_completions: "chat_completions",
  responses: "responses",
  gemini_native: "gemini_native",
};

export function outputClampStyle(style: ApiStyle, provider: ProviderType): OutputClampStyle {
  return STYLE_CLAMP_STYLE[style] ?? providerDescriptor(provider).nativeClampStyle;
}

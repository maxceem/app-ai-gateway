/**
 * What a v1 app reached on a connection when its policy listed no paths, or
 * when it allowed every connection (`mode: "all"`). Copied from v1, which is
 * frozen: `DEFAULT_PROXY_API_STYLES` and `VERCEL_API_STYLES` in
 * `src/shared/capabilities.ts`, and each type's `apiStyles` and
 * `inferencePaths` in `src/shared/providers.ts`.
 *
 * - The five default API styles, on every provider type that does not narrow
 *   them (only OpenRouter does), sent to the row's base URL.
 * - Each type's own inference paths (`{model}` is one path segment).
 * - Through Vercel AI Gateway, only the three styles Vercel serves, and no
 *   inference paths.
 *
 * Nothing else: live sessions (OpenAI's realtime), jobs and other provider
 * paths were reachable only when an app listed them.
 */
import type { ApiStyle } from "../../src/providers/operation.ts";

/** v1's default API styles, by v1's name. */
export const V1_DEFAULT_STYLES = ["responses", "chat_completions", "anthropic_messages", "gemini_native", "audio_transcription"] as const;
export type V1Style = (typeof V1_DEFAULT_STYLES)[number];

/** The same styles, as v2 names them. */
export const V2_STYLE_OF: Readonly<Record<V1Style, ApiStyle>> = {
  responses: "openai-responses",
  chat_completions: "openai-chat",
  anthropic_messages: "anthropic-messages",
  gemini_native: "gemini-generate",
  audio_transcription: "openai-transcription",
};

/** The default styles Vercel AI Gateway served in v1. */
export const V1_VERCEL_STYLES: readonly V1Style[] = ["responses", "chat_completions", "anthropic_messages"];

/** Per provider type: the styles it narrowed v1's defaults to (absent: all five), and its inference paths. */
export const V1_TYPE_DEFAULTS: Readonly<Record<string, { readonly styles?: readonly V1Style[]; readonly inference: readonly string[] }>> = {
  openai: { inference: ["v1/images/generations", "v1/images/edits", "v1/embeddings", "v1/audio/speech"] },
  anthropic: { inference: [] },
  xai: { inference: ["v1/images/generations", "v1/images/edits", "v1/embeddings", "v1/completions"] },
  gemini: { inference: ["v1beta/models/{model}:embedContent", "v1/models/{model}:embedContent"] },
  perplexity: { inference: ["v1/agent", "router/v1/chat/completions", "router/v1/responses", "router/v1/messages", "v1/embeddings", "v1/contextualizedembeddings"] },
  deepseek: { inference: ["responses", "beta/completions", "anthropic/v1/messages"] },
  groq: { inference: ["openai/v1/audio/speech"] },
  mistral: { inference: ["v1/embeddings", "v1/fim/completions", "v1/audio/speech"] },
  together: { inference: ["v1/completions", "v1/images/generations", "v1/audio/speech", "v1/embeddings"] },
  fireworks: { inference: ["inference/v1/completions", "inference/v1/messages", "inference/v1/responses", "inference/v1/embeddings"] },
  cerebras: { inference: ["v1/completions"] },
  moonshot: { inference: ["anthropic/v1/messages"] },
  huggingface: { inference: [] },
  baseten: { inference: [] },
  bytedance: { inference: ["responses", "images/generations", "embeddings/multimodal"] },
  openrouter: { styles: ["chat_completions"], inference: [] },
};

/** v1's output cap field per `clamp`, as v2's `OutputCap` values that write the same field family. */
export const V2_CAPS_OF_CLAMP: Readonly<Record<string, readonly string[]>> = {
  responses: ["responses"],
  chat_completions: ["chat", "chat-completion-tokens"],
  gemini_native: ["gemini"],
  anthropic: ["anthropic"],
  none: [],
};

/**
 * What a v1 app reached on a connection when its policy listed no paths, or
 * when it allowed every connection (`mode: "all"`). Copied from v1, which is
 * frozen (read out of v1 with its own code): `DEFAULT_PROXY_API_STYLES` and `VERCEL_API_STYLES` in
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

/** Where v1 sent a direct row with no base URL (each type's `directBaseUrl`). */
export const V1_DIRECT_BASE_URL: Readonly<Record<string, string>> = {
  openai: "https://api.openai.com/",
  anthropic: "https://api.anthropic.com/",
  xai: "https://api.x.ai/",
  gemini: "https://generativelanguage.googleapis.com/",
  perplexity: "https://api.perplexity.ai/",
  deepseek: "https://api.deepseek.com/",
  groq: "https://api.groq.com/",
  mistral: "https://api.mistral.ai/",
  together: "https://api.together.ai/",
  fireworks: "https://api.fireworks.ai/",
  cerebras: "https://api.cerebras.ai/",
  moonshot: "https://api.moonshot.ai/",
  huggingface: "https://router.huggingface.co/",
  baseten: "https://inference.baseten.co/",
  bytedance: "https://ark.ap-southeast.bytepluses.com/api/v3/",
  openrouter: "https://openrouter.ai/api/",
};

/** v1's Cloudflare AI Gateway routes (`CF_AIG_ROUTES`): the provider's name there, and a path prefix it already implies. */
export const V1_CLOUDFLARE_ROUTES: Readonly<Record<string, { readonly slug: string; readonly stripPathPrefix?: string }>> = {
  openai: { slug: "openai", stripPathPrefix: "v1/" },
  anthropic: { slug: "anthropic" },
  xai: { slug: "grok" },
  gemini: { slug: "google-ai-studio" },
  perplexity: { slug: "perplexity-ai" },
};

/** Where v1 sent Cloudflare AI Gateway traffic (`CF_AI_GATEWAY_BASE_URL`), and Vercel AI Gateway traffic. */
export const V1_CLOUDFLARE_BASE = "https://gateway.ai.cloudflare.com/v1";
export const V1_VERCEL_BASE = "https://ai-gateway.vercel.sh/";

/** The path a v1 endpoint (preset) posted to on a direct row, per type and endpoint style (`endpointProviderPath`). */
export const V1_ENDPOINT_PATHS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  openai: { responses: "v1/responses", audio_transcription: "v1/audio/transcriptions", image_generation: "v1/images/generations", embeddings: "v1/embeddings" },
  anthropic: { anthropic_messages: "v1/messages" },
  xai: { responses: "v1/responses", audio_transcription: "v1/stt", image_generation: "v1/images/generations" },
  gemini: { gemini_native: "v1beta/models/{model}:generateContent", gemini_embedding: "v1beta/models/{model}:embedContent" },
  perplexity: { chat_completions: "chat/completions" },
  deepseek: { chat_completions: "chat/completions" },
  groq: { chat_completions: "openai/v1/chat/completions", audio_transcription: "openai/v1/audio/transcriptions" },
  mistral: { chat_completions: "v1/chat/completions" },
  together: { chat_completions: "v1/chat/completions" },
  fireworks: { chat_completions: "inference/v1/chat/completions" },
  cerebras: { chat_completions: "v1/chat/completions" },
  moonshot: { chat_completions: "v1/chat/completions" },
  huggingface: { chat_completions: "v1/chat/completions" },
  baseten: { chat_completions: "v1/chat/completions" },
  bytedance: { chat_completions: "chat/completions", image_generation: "images/generations" },
  openrouter: { chat_completions: "v1/chat/completions" },
};

/** The path a v1 endpoint posted to through Vercel AI Gateway, which publishes one path per style (`API_STYLE_PATHS`). */
export const V1_STYLE_PATHS: Readonly<Record<string, string>> = {
  responses: "v1/responses",
  chat_completions: "v1/chat/completions",
  anthropic_messages: "v1/messages",
  gemini_native: "v1beta/models/{model}:generateContent",
  audio_transcription: "v1/audio/transcriptions",
};

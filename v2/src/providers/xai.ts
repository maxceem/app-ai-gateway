/**
 * xAI. Chat Completions, Responses and legacy completions report what xAI
 * actually billed (`usage.cost_in_usd_ticks`), which wins over our price. Its
 * Anthropic-compatible Messages API is not documented to report it, so it
 * bills on our price. Images and their edits report their cost as chat does;
 * embeddings answer in tokens, and transcription (`v1/stt`) with a duration.
 */
import { chat, completions, embeddings, images, messages, responses, transcription, withV1Paths } from "./llm.ts";
import { defineProvider, LIVE_TOKEN_WINDOW_SECONDS, liveTokenExpiry } from "./operation.ts";

export const xai = defineProvider({
  type: "xai",
  label: "xAI",
  hosts: { main: "api.x.ai" },
  otherHosts: ["us.api.x.ai"],
  auth: { header: "authorization", format: "Bearer {key}" },
  // Short-lived secrets for live sessions (plan D4). Its guide says
  // `expires_after` takes no `anchor`.
  suggestedPaths: [
    { method: "POST", path: "v1/realtime/client_secrets", liveToken: true, fields: [liveTokenExpiry("xAI", { in: "body", name: "expires_after", value: { seconds: LIVE_TOKEN_WINDOW_SECONDS } })] },
  ],
  probe: { path: "v1/models" },
  // Cloudflare names xAI `grok`.
  cloudflareGateway: { slug: "grok" },
  serviceModes: [{ names: ["service_tier"], axis: "tier", values: { default: "standard", priority: "priority" } }],
  // `us.api.x.ai` bills 10% over the global host, in the cost xAI reports.
  regionalOrigins: { "https://us.api.x.ai/": "us" },
  operations: withV1Paths(
    "xai",
    [
      chat("xai.chat", "v1/chat/completions", { providerCost: "xai" }),
      responses("xai.responses", "v1/responses", { providerCost: "xai" }),
      completions("xai.completions", "v1/completions", { providerCost: "xai" }),
      messages("xai.messages", "v1/messages"),
      // A form with only the audio is served, as v1: xAI transcribes it with grok-transcribe.
      transcription("xai.transcription", "v1/stt", { defaultModel: "grok-transcribe" }),
      // Its answers report only the cost, no usage.
      images("xai.images", "v1/images/generations", { providerCost: "xai", costOnly: true }),
      images("xai.images.edits", "v1/images/edits", { providerCost: "xai", costOnly: true, uploads: true }),
      embeddings("xai.embeddings", "v1/embeddings"),
    ],
    { chat: { providerCost: "xai" }, responses: { providerCost: "xai" } },
  ),
});

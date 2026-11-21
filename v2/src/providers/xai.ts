/**
 * xAI. Chat Completions, Responses and legacy completions report what xAI
 * actually billed (`usage.cost_in_usd_ticks`), which wins over our price. Its
 * Anthropic-compatible Messages API is not documented to report it, so it
 * bills on our price. Images and their edits report their cost as chat does;
 * embeddings answer in tokens, and transcription (`v1/stt`) with a duration.
 */
import { chat, completions, embeddings, images, messages, responses, transcription, withV1Paths } from "./llm.ts";
import { defineProvider } from "./operation.ts";

export const xai = defineProvider({
  type: "xai",
  label: "xAI",
  hosts: { main: "api.x.ai" },
  // `management-api.x.ai` is declared so a custom provider there gets the
  // refused paths below: every path on it manages the account.
  otherHosts: ["us.api.x.ai", "management-api.x.ai"],
  auth: { header: "authorization", format: "Bearer {key}" },
  // The key's own details. And the management host's account paths: API
  // keys, teams, models and ACLs, management keys (`auth/*`), audit logs
  // (`audit/*`) and billing (`v1/billing/*`). The inference host has none of
  // these, so refusing them there changes nothing.
  refused: ["v1/api-key/*", "auth/*", "audit/*", "v1/billing/*"],
  // Short-lived secrets for live sessions, reached only by a listed path that
  // opts in (plan D4). Its guide says `expires_after` takes no `anchor`.
  liveTokens: [{ path: "v1/realtime/client_secrets/*", forced: { method: "POST", fields: [{ names: ["expires_after"], value: { window: "expires_after" } }] } }],
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

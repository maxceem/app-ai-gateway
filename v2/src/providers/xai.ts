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
  auth: { header: "authorization", format: "Bearer {key}" },
  // Key management lives on a separate host the gateway never calls.
  refused: ["v1/api-key/*"],
  probe: { path: "v1/models" },
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
      transcription("xai.transcription", "v1/stt"),
      images("xai.images", "v1/images/generations", { providerCost: "xai" }),
      images("xai.images.edits", "v1/images/edits", { providerCost: "xai" }),
      embeddings("xai.embeddings", "v1/embeddings"),
    ],
    { chat: { providerCost: "xai" }, responses: { providerCost: "xai" } },
  ),
});

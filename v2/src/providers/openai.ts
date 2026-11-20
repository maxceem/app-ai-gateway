/**
 * OpenAI.
 *
 * Text through Chat Completions and Responses, and transcription, images,
 * embeddings and speech (step 3), and the realtime
 * WebSocket, one of the hardest shapes: a relayed session with its model in
 * the query, measured from the provider's usage events (step 9).
 */
import { chat, embeddings, images, responses, speech, transcription, withV1Paths } from "./llm.ts";
import { defineOperation, defineProvider } from "./operation.ts";

export const openai = defineProvider({
  type: "openai",
  label: "OpenAI",
  hosts: { main: "api.openai.com" },
  // Its data residency host for Europe.
  otherHosts: ["eu.api.openai.com"],
  auth: { header: "authorization", format: "Bearer {key}" },
  // The admin API (keys, projects, users, usage and costs) lives under
  // `v1/organization`. The others mint short-lived secrets for live sessions
  // and ChatKit: refused until a customer can opt in to them path by path,
  // with their expiry locked (plan D4).
  refused: [
    "v1/organization/*",
    "v1/realtime/client_secrets/*",
    "v1/realtime/sessions/*",
    "v1/realtime/transcription_sessions/*",
    "v1/chatkit/sessions/*",
  ],
  // Listing models is free and needs a valid key.
  probe: { path: "v1/models" },
  // Cloudflare's `openai` name already implies the `v1/` prefix.
  cloudflareGateway: { slug: "openai", stripPathPrefix: "v1/" },
  // `text`, `srt` and `vtt` answers carry no usage, so they are refused (v1).
  transcriptionFormats: { metered: ["json", "verbose_json", "diarized_json"], default: "json" },
  // `priority` is the name Fast mode had until July 2026, and is still
  // accepted for it. The response's `service_tier` is read with this table
  // too: fast traffic shed to `default` bills as standard. `auto` is the
  // project's default tier. `scale` draws on prepaid Scale Tier units, paid
  // for by contract, so it bills as standard.
  serviceModes: [
    {
      names: ["service_tier"],
      axis: "tier",
      values: {
        auto: "standard",
        default: "standard",
        flex: "flex",
        priority: "fast",
        fast: "fast",
        ultrafast: "ultrafast",
        scale: "standard",
      },
    },
  ],
  // No regional hosts: OpenAI's data residency hosts cost more only for some
  // models, and its pages give no release date for most, so requests through
  // them bill as through the global host (v1).
  operations: withV1Paths("openai", [
    // OpenAI's Chat Completions deprecated `max_tokens` for `max_completion_tokens`.
    chat("openai.chat", "v1/chat/completions", { cap: "chat-completion-tokens" }),
    responses("openai.responses", "v1/responses"),
    transcription("openai.transcription", "v1/audio/transcriptions"),
    // Images report token usage, with image tokens apart.
    images("openai.images", "v1/images/generations"),
    images("openai.images.edits", "v1/images/edits"),
    embeddings("openai.embeddings", "v1/embeddings"),
    speech("openai.speech", "v1/audio/speech"),
    defineOperation({
      name: "openai.realtime",
      match: { method: "GET", path: "v1/realtime" },
      lifecycle: "session",
      transport: "websocket",
      model: { in: "query", name: "model" },
      meter: { kind: "provider_event", adapter: "openai-realtime" },
      session: { slot: "conversational", mode: "relayed" },
    }),
  ], { chat: { cap: "chat-completion-tokens" } }),
});

/**
 * OpenAI.
 *
 * Text through Chat Completions and Responses, and transcription, images,
 * embeddings and speech (step 3), and the realtime
 * WebSocket, one of the hardest shapes: a relayed session with its model in
 * the query, measured from the provider's usage events (step 9).
 */
import { chat, embeddings, images, responses, speech, transcription, withV1Paths } from "./llm.ts";
import { defineOperation, defineProvider, LIVE_TOKEN_WINDOW_SECONDS, liveTokenExpiry } from "./operation.ts";

/** A client secret's expiry, counted from when it is created. */
const EXPIRES_AFTER = { anchor: "created_at", seconds: LIVE_TOKEN_WINDOW_SECONDS };

export const openai = defineProvider({
  type: "openai",
  modelAuthor: "OpenAI",
  label: "OpenAI",
  hosts: { main: "api.openai.com" },
  // Its data residency hosts (US, Europe, UK), and the others it serves under `api.openai.com` (v1).
  otherHosts: ["us.api.openai.com", "eu.api.openai.com", "gb.api.openai.com", "*.api.openai.com"],
  auth: { header: "authorization", format: "Bearer {key}" },
  // Short-lived secrets for live sessions and ChatKit (plan D4). A client
  // secret's expiry only limits when calls can start (T18). The older
  // Realtime sessions keep it inside `client_secret`, which OpenAI's SDK
  // names `expires_after` for sessions and `expires_at` for transcription
  // sessions, so the other spelling is removed.
  suggestedPaths: [
    { method: "POST", path: "v1/realtime/client_secrets", liveToken: true, fields: [liveTokenExpiry("OpenAI", { in: "body", name: "expires_after", value: EXPIRES_AFTER })] },
    {
      method: "POST",
      path: "v1/realtime/sessions",
      liveToken: true,
      fields: [liveTokenExpiry("OpenAI", { in: "body", name: "client_secret.expires_after", value: EXPIRES_AFTER, aliases: ["client_secret.expires_at"] })],
    },
    {
      method: "POST",
      path: "v1/realtime/transcription_sessions",
      liveToken: true,
      fields: [liveTokenExpiry("OpenAI", { in: "body", name: "client_secret.expires_at", value: EXPIRES_AFTER, aliases: ["client_secret.expires_after"] })],
    },
    { method: "POST", path: "v1/chatkit/sessions", liveToken: true, fields: [liveTokenExpiry("OpenAI", { in: "body", name: "expires_after", value: EXPIRES_AFTER })] },
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
    images("openai.images.edits", "v1/images/edits", { uploads: true }),
    embeddings("openai.embeddings", "v1/embeddings"),
    speech("openai.speech", "v1/audio/speech"),
    defineOperation({
      name: "openai.realtime",
      match: { method: "GET", path: "v1/realtime" },
      lifecycle: "session",
      transport: "websocket",
      model: { in: "query", name: "model" },
      // Only the Realtime models billed by tokens: an image or chat model's own price is not judged here
      // (Sol, #269), and the per-minute transcription and translation models are not this session's.
      modelKinds: ["realtime"],
      meter: { kind: "provider_event", adapter: "openai-realtime", tokensOnly: true },
      session: { slot: "conversational", mode: "relayed" },
    }),
  ], { chat: { cap: "chat-completion-tokens" } }),
});

/**
 * Gemini: its own `generateContent` and `embedContent`, with the model in the
 * path, and its OpenAI-compatible Chat Completions. `generateContent` also
 * carries image, speech and transcription models. Its Live API
 * (`BidiGenerateContent`, a WebSocket) is a relayed session, billed by the
 * tokens of each turn (T4, T19; step 9d).
 */
import { chat, DETACHED, withV1Paths } from "./llm.ts";
import { defineOperation, defineProvider, LIVE_TOKEN_WINDOW_SECONDS, liveTokenExpiry } from "./operation.ts";

/** `generateContent` and its streaming twin, under one API version. */
function generate(version: "v1" | "v1beta" | "v1alpha") {
  const common = {
    lifecycle: "call",
    transport: "stream",
    style: "gemini-generate",
    policy: { outputCap: "gemini" },
    background: DETACHED,
    meter: { kind: "response_json", style: "gemini-generate" },
  } as const;
  return [
    defineOperation({
      ...common,
      name: `gemini.generate.${version}`,
      match: { method: "POST", path: `${version}/models/{model}:generateContent` },
      model: { in: "path", part: "model" },
    }),
    defineOperation({
      ...common,
      name: `gemini.stream.${version}`,
      match: { method: "POST", path: `${version}/models/{model}:streamGenerateContent` },
      model: { in: "path", part: "model" },
    }),
  ];
}

/**
 * The Live API under one API version: a relayed session (plan step 9d). Its
 * model is in the client's first message, `setup.model`; the relay sets it to
 * the session's model (`relay/src/gemini.js`), so the app names it when it
 * asks for the session.
 */
function live(version: "v1beta" | "v1alpha") {
  return defineOperation({
    name: `gemini.live.${version}`,
    match: { method: "GET", path: `ws/google.ai.generativelanguage.${version}.GenerativeService.BidiGenerateContent` },
    lifecycle: "session",
    transport: "websocket",
    model: { in: "body", field: "model" },
    meter: { kind: "provider_event", adapter: "gemini-live" },
    session: { slot: "conversational", mode: "relayed" },
  });
}

/**
 * `embedContent` under one API version. `batchEmbedContents` is left out, as
 * in v1: each item may name a model the one in the path does not.
 */
function embed(version: "v1" | "v1beta") {
  return defineOperation({
    name: `gemini.embed.${version}`,
    match: { method: "POST", path: `${version}/models/{model}:embedContent` },
    lifecycle: "call",
    transport: "http",
    style: "gemini-embed",
    model: { in: "path", part: "model" },
    meter: { kind: "response_json", style: "gemini-embed" },
  });
}

export const gemini = defineProvider({
  type: "gemini",
  modelAuthor: "Google",
  label: "Gemini",
  hosts: { main: "generativelanguage.googleapis.com" },
  auth: { header: "x-goog-api-key", format: "{key}" },
  // Ephemeral tokens for the Live API (plan D4). `newSessionExpireTime` is
  // the window for starting a session; `expireTime` caps the session itself
  // and is left as sent. A token may start new sessions only within the
  // window, and only one: `uses: 0` would mean any number. Gemini's REST
  // surface reads both spellings of a field, so the other is removed.
  suggestedPaths: (["v1alpha", "v1beta"] as const).map((version) => ({
    method: "POST" as const,
    path: `${version}/auth_tokens`,
    liveToken: true as const,
    fields: [
      liveTokenExpiry("Gemini", {
        in: "body",
        name: "newSessionExpireTime",
        value: LIVE_TOKEN_WINDOW_SECONDS,
        as: "time_from_now",
        aliases: ["new_session_expire_time"],
      }),
      {
        in: "body" as const,
        name: "uses",
        value: 1,
        label: "Sessions per token",
        reason: "With 1, the token can start only one live session. 0 would let it start any number of them, outside the gateway's limits.",
      },
    ],
  })),
  probe: { path: "v1beta/models" },
  // The Files API's resumable uploads (`upload/v1beta/files`), once listed.
  passthroughHeaders: ["x-goog-upload-"],
  cloudflareGateway: { slug: "google-ai-studio" },
  // Gemini's REST surface accepts both spellings of a field.
  serviceModes: [
    { names: ["service_tier", "serviceTier"], axis: "tier", values: { standard: "standard", flex: "flex", priority: "priority" } },
  ],
  // The tier that served the request is in a response header, and in
  // `usageMetadata.serviceTier`: priority over its limit is served, and
  // billed, as standard.
  servedModes: [
    {
      names: ["header:x-gemini-service-tier", "serviceTier"],
      axis: "tier",
      values: { standard: "standard", flex: "flex", priority: "priority" },
    },
  ],
  operations: withV1Paths("gemini", [
    ...generate("v1beta"),
    ...generate("v1"),
    ...generate("v1alpha"),
    embed("v1beta"),
    embed("v1"),
    chat("gemini.chat", "v1beta/openai/chat/completions"),
    live("v1beta"),
    live("v1alpha"),
  ]),
});

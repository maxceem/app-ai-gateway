/**
 * Deepgram prerecorded speech to text (plan step 4).
 *
 * - `POST v1/listen` takes the audio as the raw request body, with its own
 *   content type, or JSON `{ "url": ... }` that Deepgram fetches. The audio
 *   is sent as the client's own bytes, never read or copied.
 * - The model and every option are query parameters (`model=nova-3`,
 *   `language=multi`). With no model, Deepgram uses `base-general`, which has
 *   no price here, so only a customer's own rate serves it.
 * - The answer names the audio's length and its channels
 *   (`metadata.duration`, `metadata.channels`). Deepgram bills per second,
 *   and multichannel audio by the total across channels.
 * - Nova-3 has two rates: monolingual, and multilingual (`language=multi`).
 *   The price key `language` picks it; every other language bills at the
 *   monolingual rate (`*` in the price file).
 * - Some options are billed on top at rates the gateway does not have yet,
 *   such as redaction or entity detection: a request naming one is served,
 *   billed at the model's rate as an estimate, and logged. Deepgram's own
 *   dollar figure per request (`GET v1/projects/{p}/requests/{id}`) is read
 *   later, with the relay (plan section 4.2, before step 10).
 * - Live streaming (`wss://.../v1/listen`) is a session, built with the relay.
 */
import { defineOperation, defineProvider } from "./operation.ts";

/** Options Deepgram bills on top of transcription (its pricing page's add-ons and Audio Intelligence). */
const BILLED_EXTRAS = [
  "redact",
  "detect_entities",
  "keyterm",
  "diarize",
  "diarize_model",
  "summarize",
  "topics",
  "custom_topic",
  "intents",
  "custom_intent",
  "sentiment",
] as const;

export const deepgram = defineProvider({
  type: "deepgram",
  label: "Deepgram",
  hosts: { main: "api.deepgram.com" },
  auth: { header: "authorization", format: "Token {key}" },
  // Deepgram has no service modes on this API.
  serviceModes: [],
  // First draft. Step 5 reviews the refused paths of every provider.
  refused: ["v1/projects/*", "v1/auth/*", "v1/keys/*"],
  // Lists the models; needs a valid key.
  probe: { path: "v1/models" },
  operations: [
    defineOperation({
      name: "deepgram.listen",
      match: { method: "POST", path: "v1/listen" },
      lifecycle: "call",
      transport: "http",
      model: { in: "query", name: "model", default: "base-general" },
      modelKinds: ["transcription"],
      rawBody: true,
      priceKeys: [{ name: "language", from: { in: "query", field: "language" }, default: "en" }],
      unpricedOptions: BILLED_EXTRAS.map((field) => ({ in: "query", field })),
      outbound: {
        webhooks: [
          { in: "query", field: "callback" },
          { in: "query", field: "callback_method" },
        ],
        // A JSON body names the audio Deepgram fetches.
        fetchKept: [{ in: "body", field: "url" }],
      },
      meter: { kind: "response_json", style: "deepgram-listen", units: ["audio_seconds"] },
    }),
  ],
});

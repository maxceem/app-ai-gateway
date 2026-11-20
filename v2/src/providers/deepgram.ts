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
 * - Some options are billed on top. Redaction, entity detection and keyterm
 *   prompting have a rate per minute: each is a price key, and our list adds
 *   its rate to the model's (`add` in the price file). Audio Intelligence
 *   (summaries, topics, intents, sentiment) is billed by tokens the answer
 *   does not report, and custom topics and intents have no published rate:
 *   a request naming one is served, billed at the model's rate as an
 *   estimate, and logged. So is a priced option on a customer's own rate
 *   without it. Deepgram's own dollar figure per request
 *   (`GET v1/projects/{p}/requests/{id}`) is read later, with the relay
 *   (plan section 4.2, before step 10).
 * - Diarization is included in the prerecorded rate.
 * - Live streaming (`wss://.../v1/listen`) is a session, built with the relay.
 */
import { defineOperation, defineProvider } from "./operation.ts";

/** Options Deepgram bills on top of transcription at a rate per minute (its pricing page's add-ons). */
const PER_MINUTE_EXTRAS = ["redact", "detect_entities", "keyterm"] as const;

/** Every option Deepgram bills on top of transcription (add-ons and Audio Intelligence). */
const BILLED_EXTRAS = [
  ...PER_MINUTE_EXTRAS,
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
      priceKeys: [
        { name: "language", from: { in: "query", field: "language" }, default: "en" },
        // Absent is `false`; any other value turns the option on.
        ...PER_MINUTE_EXTRAS.map((name) => ({ name, from: { in: "query", field: name }, default: "false" }) as const),
      ],
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

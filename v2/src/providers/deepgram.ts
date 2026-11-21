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
 *   monolingual rate (`*` in the price file). With `detect_language`,
 *   Deepgram picks the language (`results.channels[].detected_language`),
 *   and may serve an older model for it (`metadata.model_info`): the answer's
 *   language is billed, and an answer that does not name them is billed at
 *   the dearest language as an estimate, logged.
 * - Some options are billed on top. Redaction, entity detection and keyterm
 *   prompting have a rate per minute: each is a price key read as on or off,
 *   and our list adds its rate to the model's (`add` in the price file). Audio Intelligence
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

/**
 * Options Deepgram bills on top of transcription (its pricing page's add-ons
 * and Audio Intelligence), each read as the switch it is: a flag is off when
 * `false`; free text (key terms, custom topics) is on whenever it is there.
 */
const BILLED_EXTRAS = [
  { in: "query", field: "redact", kind: "flag" },
  { in: "query", field: "detect_entities", kind: "flag" },
  { in: "query", field: "keyterm", kind: "text" },
  { in: "query", field: "summarize", kind: "flag" },
  { in: "query", field: "topics", kind: "flag" },
  { in: "query", field: "custom_topic", kind: "text" },
  { in: "query", field: "intents", kind: "flag" },
  { in: "query", field: "custom_intent", kind: "text" },
  { in: "query", field: "sentiment", kind: "flag" },
] as const;

/** The add-ons with a rate per minute: each a price key, its rate in our list (`add`). */
const PER_MINUTE_EXTRAS = ["redact", "detect_entities", "keyterm"] as const;

/** Language detection: Deepgram picks the language, and may fall back to an older model for it. */
const DETECT_LANGUAGE = { in: "query", field: "detect_language" } as const;

/**
 * The priced models each model architecture Deepgram reports
 * (`metadata.model_info[].arch`) stands for. Any other, such as Nova-1's
 * `nova` or Nova-2's `nova-2`, is a fallback the gateway has no price for:
 * billed at the asked model's rate as an estimate, logged. A key may be the
 * reported `arch` or `name`: Whisper Large reports `arch: "whisper"` with
 * `name: "large-whisper"` (seen on a real call, T27), so its name stands for
 * `whisper-large` and other Whisper sizes stay unmatched.
 */
const SERVED_AS = { "nova-3": ["nova-3", "nova-3-general"], "large-whisper": ["whisper-large"] } as const;

export const deepgram = defineProvider({
  type: "deepgram",
  label: "Deepgram",
  hosts: { main: "api.deepgram.com" },
  // Its EU host.
  otherHosts: ["api.eu.deepgram.com"],
  auth: { header: "authorization", format: "Token {key}" },
  // Deepgram has no service modes on this API.
  serviceModes: [],
  // Lists the models; needs a valid key.
  probe: { path: "v1/models" },
  operations: [
    defineOperation({
      name: "deepgram.listen",
      match: { method: "POST", path: "v1/listen" },
      lifecycle: "call",
      transport: "http",
      model: { in: "query", name: "model", default: "base-general", answeredWhen: DETECT_LANGUAGE, servedAs: SERVED_AS },
      modelKinds: ["transcription"],
      rawBody: true,
      priceKeys: [
        { name: "language", from: { in: "query", field: "language" }, default: "en", answeredWhen: DETECT_LANGUAGE },
        ...PER_MINUTE_EXTRAS.map((name) => {
          const ref = BILLED_EXTRAS.find((extra) => extra.field === name)!;
          return { name, from: { in: ref.in, field: ref.field }, kind: ref.kind };
        }),
      ],
      unpricedOptions: BILLED_EXTRAS,
      outbound: {
        webhooks: [
          { in: "query", field: "callback" },
          { in: "query", field: "callback_method" },
        ],
        // A JSON body names the audio Deepgram fetches.
        fetchKept: [{ in: "body", field: "url" }],
      },
      // Billed once per channel only with `multichannel=true`; without it Deepgram mixes the channels down.
      // Deepgram answers when the transcript is done: it allows up to 10
      // minutes of processing for Nova, Base and Enhanced, and 20 for Whisper,
      // then answers 504 itself (docs: pre-recorded audio, Getting Started).
      responseDeadlineMs: 20 * 60 * 1000,
      meter: { kind: "response_json", style: "deepgram-listen", units: ["audio_seconds"], perChannelWhen: { in: "query", field: "multichannel" } },
    }),
  ],
});

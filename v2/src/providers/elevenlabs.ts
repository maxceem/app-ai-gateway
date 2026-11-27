/**
 * ElevenLabs text to speech and speech to text (plan step 4).
 *
 * - The voice is in the path, the model in the body's `model_id`.
 * - A text-to-speech answer is audio (or JSON with timestamps); it is never
 *   read. It is billed by the request's characters, exactly, at the model's
 *   published rate per million characters: ElevenLabs bills API usage in
 *   dollars per character, not in credits. The `character-cost` header, in
 *   credits, is recorded beside the characters as a cross-check (T27); it
 *   bills only a price that has a rate per credit and none per character.
 *   The list rate per credit, $0.0002, is the per-character price over what
 *   real calls reported: about 0.2 credits a character on Flash and 0.4 on
 *   Multilingual v2.
 * - Speech to text is a form upload. ElevenLabs also sends its own dollar
 *   figure for it, `fiat-cost-before-overages`, which is billed as it is
 *   (`provider_usd`, plan section 4.2). Without it, the audio's length in
 *   the answer (`audio_duration_secs`) is priced at the list rate per hour,
 *   or its credits at a customer's rate per credit.
 *
 * v1 never served ElevenLabs, so nothing here replaces anything v1 did.
 */
import { defineOperation, defineProvider, LIVE_TOKEN_WINDOW_SECONDS, liveTokenExpiry, type StoredAudio, type SuggestedField } from "./operation.ts";

/** ElevenLabs' default text-to-speech model, used when the request names none. */
const DEFAULT_TTS_MODEL = "eleven_multilingual_v2";

/**
 * Text to speech is billed per character of the request, in dollars:
 * ElevenLabs' pricing page bills API usage in US dollars, not credits, per
 * character. The `character-cost` header counts credits, which is not
 * documented and is not the billed amount: real calls gave 7 credits for 33
 * characters on Flash v2.5 and 13 for 33 on Multilingual v2 (T27). It is
 * recorded beside the characters as a cross-check, and still bills a price
 * that has only a rate per credit.
 */
const ttsMeter = {
  kind: "response_header",
  header: "character-cost",
  unit: "credits",
  estimate: { measure: "characters", field: "text", unit: "characters" },
  headerRole: "cross_check",
  // ElevenLabs documents that pronunciation dictionaries can change the billed
  // characters: an alias may expand the text. Then the characters are an
  // estimate, and the credits bill instead when they cost more.
  inDoubtWhen: { in: "body", field: "pronunciation_dictionary_locators", kind: "list" },
} as const;

/** A signed URL that starts only one conversation. */
const SINGLE_USE: SuggestedField = {
  in: "query" as const,
  name: "include_conversation_id",
  value: "true",
  label: "Single use",
  reason: "With true, the signed URL starts only one conversation. Without it, one URL can start several for about 15 minutes, outside the gateway's limits.",
};

const ttsModel = { in: "body", field: "model_id", default: DEFAULT_TTS_MODEL } as const;


/**
 * The recording in a timestamped answer (`audio_base64`): its type follows the
 * `output_format` the request named, MP3 when it named none, as ElevenLabs does.
 */
const TIMESTAMP_AUDIO: StoredAudio = {
  fields: ["audio_base64"],
  mime: "audio/mpeg",
  format: {
    query: "output_format",
    byPrefix: { mp3_: "audio/mpeg", pcm_: "audio/pcm", opus_: "audio/opus", ulaw_: "audio/basic", alaw_: "audio/x-alaw-basic", wav_: "audio/wav" },
  },
};

export const elevenlabs = defineProvider({
  type: "elevenlabs",
  modelAuthor: "ElevenLabs",
  label: "ElevenLabs",
  hosts: { main: "api.elevenlabs.io" },
  // Its US host and its data residency hosts.
  otherHosts: ["api.us.elevenlabs.io", "api.eu.residency.elevenlabs.io", "api.in.residency.elevenlabs.io", "api.sg.residency.elevenlabs.io"],
  auth: { header: "xi-api-key", format: "{key}" },
  // ElevenLabs has no service modes on these APIs.
  serviceModes: [],
  // Tokens and signed URLs for live sessions (plan D4). Only the Realtime
  // client secret takes an expiry; the others last as ElevenLabs sets them
  // (about 15 minutes, T13). A signed URL is single use only with
  // `include_conversation_id=true` (T13).
  suggestedPaths: [
    { method: "GET", path: "v1/convai/conversation/token", liveToken: true, fields: [] },
    { method: "GET", path: "v1/convai/conversation/get-signed-url", liveToken: true, fields: [SINGLE_USE] },
    { method: "GET", path: "v1/convai/conversation/get_signed_url", liveToken: true, fields: [SINGLE_USE] },
    {
      method: "POST",
      path: "v1/convai/realtime/client_secrets",
      liveToken: true,
      fields: [liveTokenExpiry("ElevenLabs", { in: "body", name: "expires_after", value: { anchor: "created_at", seconds: LIVE_TOKEN_WINDOW_SECONDS } })],
    },
    { method: "POST", path: "v1/single-use-token/realtime_scribe", liveToken: true, fields: [] },
    { method: "POST", path: "v1/single-use-token/tts_websocket", liveToken: true, fields: [] },
  ],
  // Lists the models; needs a valid key.
  probe: { path: "v1/models" },
  operations: [
    defineOperation({
      name: "elevenlabs.tts_stream_timestamps",
      match: { method: "POST", path: "v1/text-to-speech/{voice_id}/stream/with-timestamps" },
      lifecycle: "call",
      transport: "stream",
      model: ttsModel,
      modelKinds: ["speech"],
      // Its recording arrives in base64 inside JSON, beside the timestamps.
      storedAudio: TIMESTAMP_AUDIO,
      // A line of JSON at a time, even where it is sent as `application/json`.
      responseJsonLines: true,
      meter: ttsMeter,
    }),
    defineOperation({
      name: "elevenlabs.tts_stream",
      match: { method: "POST", path: "v1/text-to-speech/{voice_id}/stream" },
      lifecycle: "call",
      transport: "stream",
      model: ttsModel,
      modelKinds: ["speech"],
      // Its answer is the recording itself.
      rawAudioResponse: true,
      meter: ttsMeter,
    }),
    defineOperation({
      name: "elevenlabs.tts_timestamps",
      match: { method: "POST", path: "v1/text-to-speech/{voice_id}/with-timestamps" },
      lifecycle: "call",
      transport: "http",
      model: ttsModel,
      modelKinds: ["speech"],
      // Its recording arrives in base64 inside JSON, beside the timestamps.
      storedAudio: TIMESTAMP_AUDIO,
      meter: ttsMeter,
    }),
    defineOperation({
      name: "elevenlabs.tts",
      match: { method: "POST", path: "v1/text-to-speech/{voice_id}" },
      lifecycle: "call",
      transport: "binary",
      model: ttsModel,
      modelKinds: ["speech"],
      // Its answer is the recording itself.
      rawAudioResponse: true,
      meter: ttsMeter,
    }),
    // Streaming text to speech over WebSocket (10a): a relayed session on a streaming slot, billed on the
    // client's text, per character, at the model's rate, as a call is. The relay counts the text frames it
    // forwards (`relay/src/adapters.js`); the model (`model_id`) and the voice (the path) are in the address
    // the session is sealed for. Its connection time is never billed.
    defineOperation({
      name: "elevenlabs.tts_websocket",
      match: { method: "GET", path: "v1/text-to-speech/{voice_id}/stream-input" },
      lifecycle: "session",
      transport: "websocket",
      model: { in: "query", name: "model_id", default: DEFAULT_TTS_MODEL },
      modelKinds: ["speech"],
      // A credential in its query (`authorization`, `single_use_token`) is never sent: `CREDENTIAL_FIELD` in `../relay/start-session.ts`.
      meter: { kind: "provider_event", adapter: "elevenlabs-tts", units: ["characters"] },
      // ElevenLabs refuses a model its stream doesn't serve (`eleven_v3`, `eleven_v4`), and the app gets its error as it is.
      session: { slot: "streaming", mode: "relayed", queryOptions: true },
    }),
    defineOperation({
      name: "elevenlabs.stt",
      match: { method: "POST", path: "v1/speech-to-text" },
      lifecycle: "call",
      transport: "upload",
      audioFormFields: ["file"],
      model: { in: "body", field: "model_id" },
      modelKinds: ["transcription"],
      outbound: {
        // A webhook answers later, outside the gateway: the request is kept synchronous.
        webhooks: [
          { in: "form", field: "webhook" },
          { in: "form", field: "webhook_id" },
          { in: "form", field: "webhook_metadata" },
        ],
        // The audio to transcribe, when it is not uploaded: the operation needs it.
        fetchKept: [{ in: "form", field: "cloud_storage_url" }],
        // A single-use token a client could send: the gateway's key is the only credential.
        credentials: [{ in: "query", field: "token" }],
      },
      meter: {
        kind: "response_header",
        header: "character-cost",
        unit: "credits",
        providerCost: { header: "fiat-cost-before-overages", currency: { header: "fiat-currency", value: "usd" } },
        // The answer names the audio's length, which the list price bills by the hour.
        body: { style: "elevenlabs-transcription", units: ["audio_seconds"] },
      },
    }),
  ],
});

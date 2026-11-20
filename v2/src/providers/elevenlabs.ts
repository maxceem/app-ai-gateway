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
import { defineOperation, defineProvider } from "./operation.ts";

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

const ttsModel = { in: "body", field: "model_id", default: DEFAULT_TTS_MODEL } as const;

/** Methods that create, change or delete. */
const MUTATING = ["POST", "PUT", "PATCH", "DELETE"] as const;

export const elevenlabs = defineProvider({
  type: "elevenlabs",
  label: "ElevenLabs",
  hosts: { main: "api.elevenlabs.io" },
  auth: { header: "xi-api-key", format: "{key}" },
  // ElevenLabs has no service modes on these APIs.
  serviceModes: [],
  // The account, its workspace, keys and history, and every account
  // resource a key could create, change or delete: voices (cloning, voice
  // design, the voice library), agents and their tools, knowledge base,
  // phone numbers and settings, pronunciation dictionaries, Studio and Audio
  // Native projects, and dubbing resources (the provider research's "never
  // expose" list, and ElevenLabs' API reference). Reading them, and making
  // speech or previews that are not saved, stays allowed. Tokens and signed
  // URLs for live sessions are refused until a customer can opt in to them
  // path by path (plan D4).
  refused: [
    "v1/user/*",
    "v1/workspace/*",
    "v1/service-accounts/*",
    "v1/api-keys/*",
    "v1/history/*",
    "v1/usage/*",
    "v1/voices/add/*",
    "v1/voices/{voice_id}/edit",
    { path: "v1/voices/*", methods: MUTATING },
    { path: "v1/voice-collections/*", methods: MUTATING },
    "v1/text-to-voice/create-voice-from-preview",
    { path: "v1/text-to-voice", methods: MUTATING },
    // The legacy voice generation saves a voice only here; `generate-voice` makes an unsaved preview.
    "v1/voice-generation/create-voice",
    { path: "v1/convai/agents/*", methods: MUTATING },
    { path: "v1/convai/tools/*", methods: MUTATING },
    { path: "v1/convai/knowledge-base/*", methods: MUTATING },
    { path: "v1/convai/phone-numbers/*", methods: MUTATING },
    { path: "v1/convai/mcp-servers/*", methods: MUTATING },
    { path: "v1/convai/settings/*", methods: MUTATING },
    { path: "v1/convai/dashboard/*", methods: MUTATING },
    { path: "v1/pronunciation-dictionaries/*", methods: MUTATING },
    { path: "v1/studio/*", methods: MUTATING },
    { path: "v1/projects/*", methods: MUTATING },
    { path: "v1/audio-native/*", methods: MUTATING },
    { path: "v1/dubbing/resource/*", methods: MUTATING },
    { path: "v1/dubbing/{dubbing_id}", methods: ["DELETE"] },
    "v1/convai/secrets/*",
    "v1/convai/conversation/token/*",
    "v1/convai/conversation/get-signed-url/*",
    "v1/convai/conversation/get_signed_url/*",
    "v1/single-use-token/*",
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
      meter: ttsMeter,
    }),
    defineOperation({
      name: "elevenlabs.tts_stream",
      match: { method: "POST", path: "v1/text-to-speech/{voice_id}/stream" },
      lifecycle: "call",
      transport: "stream",
      model: ttsModel,
      modelKinds: ["speech"],
      meter: ttsMeter,
    }),
    defineOperation({
      name: "elevenlabs.tts_timestamps",
      match: { method: "POST", path: "v1/text-to-speech/{voice_id}/with-timestamps" },
      lifecycle: "call",
      transport: "http",
      model: ttsModel,
      modelKinds: ["speech"],
      meter: ttsMeter,
    }),
    defineOperation({
      name: "elevenlabs.tts",
      match: { method: "POST", path: "v1/text-to-speech/{voice_id}" },
      lifecycle: "call",
      transport: "binary",
      model: ttsModel,
      modelKinds: ["speech"],
      meter: ttsMeter,
    }),
    defineOperation({
      name: "elevenlabs.stt",
      match: { method: "POST", path: "v1/speech-to-text" },
      lifecycle: "call",
      transport: "upload",
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

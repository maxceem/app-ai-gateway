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

export const elevenlabs = defineProvider({
  type: "elevenlabs",
  label: "ElevenLabs",
  hosts: { main: "api.elevenlabs.io" },
  // Its US host and its data residency hosts.
  otherHosts: ["api.us.elevenlabs.io", "api.eu.residency.elevenlabs.io", "api.in.residency.elevenlabs.io", "api.sg.residency.elevenlabs.io"],
  auth: { header: "xi-api-key", format: "{key}" },
  // ElevenLabs has no service modes on these APIs.
  serviceModes: [],
  // A closed set, not every resource a key could change (plan section 4.5:
  // admin and key-creation paths; the provider research's "never expose"
  // list). Anything else a customer lists is their own trust choice.
  // `test/elevenlabs-refused.test.ts` checks every operation of ElevenLabs'
  // API against this set, both ways.
  refused: [
    // The account and its admin: user, workspaces and their team, service
    // accounts and their API keys, usage, and billing actions.
    "v1/user/*",
    "v1/workspace/*",
    "v1/workspaces/*",
    "v1/service-accounts/*",
    "v1/usage/*",
    "v1/reception/reseller/workspaces/*",
    "v1/reception/team/*",
    "v1/reception/reseller/billing/*",
    { path: "v1/productions/orders/{order_id}/submit", methods: ["POST"] },
    // Account-wide history, which holds every app's generations.
    "v1/history/*",
    "v1/audio-isolation/history/*",
    // Stored credentials.
    "v1/convai/secrets/*",
    { path: "v1/convai/environment-variables/*", methods: ["POST", "PUT", "PATCH", "DELETE"] },
    // Deleting an environment removes its values from every environment variable.
    { path: "v1/convai/environments/{environment}", methods: ["DELETE"] },
    // From the research: deleting a voice (not a collection, a voice's place
    // in one, or a sample), and creating, changing or deleting agents and
    // their settings (not queries under an agent, such as `rag-query`).
    { path: "v1/voices/{voice_id}", methods: ["DELETE"] },
    "v1/convai/agents/create",
    { path: "v1/convai/agents/{agent_id}/duplicate", methods: ["POST"] },
    { path: "v1/convai/agents/{agent_id}", methods: ["PUT", "PATCH", "DELETE"] },
    { path: "v1/convai/agents/{agent_id}/avatar", methods: ["POST"] },
    { path: "v1/convai/agents/{agent_id}/hold-audio", methods: ["POST", "DELETE"] },
    { path: "v1/reception/customer-facing-agents/{agent_id}", methods: ["PATCH"] },
  ],
  // Tokens and signed URLs for live sessions, reached only by a listed path
  // that opts in (plan D4). Only the Realtime client secret takes an expiry;
  // the others last as ElevenLabs sets them (about 15 minutes, T13).
  // An agent's link answers with a conversation token. Agent reads may hold
  // a `shareable_token` too; they stay allowed, since passthrough never
  // changes a body and the customer turns sharing on themselves.
  liveTokens: [
    { path: "v1/convai/conversation/token/*" },
    { path: "v1/convai/conversation/get-signed-url/*" },
    { path: "v1/convai/conversation/get_signed_url/*" },
    { path: "v1/convai/realtime/client_secrets/*", expiry: { method: "POST", field: "expires_after", as: "expires_after", anchor: true } },
    { path: "v1/single-use-token/*" },
    { path: "v1/convai/agents/{agent_id}/link", methods: ["GET"] },
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

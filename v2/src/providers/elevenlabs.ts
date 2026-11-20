/**
 * ElevenLabs text to speech and speech to text (plan step 4).
 *
 * - The voice is in the path, the model in the body's `model_id`.
 * - A text-to-speech answer is audio (or JSON with timestamps); it is never
 *   read. The billed amount is the `character-cost` response header, in
 *   credits, on every answer, `/stream` included (T2). Before the answer, and
 *   when the header is missing, the request's characters give the estimate:
 *   ElevenLabs charges characters × the model's `character_cost_multiplier`
 *   (1, or 0.5 for the flash and turbo models), within 1 credit (T2).
 * - Credits are priced at the model's list rate or the customer's own rate per
 *   credit; characters at its rate per million characters. A model's price
 *   states both, so the estimate and the header bill alike.
 * - Speech to text is a form upload. ElevenLabs also sends its own dollar
 *   figure for it, `fiat-cost-before-overages`, which is billed as it is
 *   (`provider_usd`, plan section 4.2). Without it, its credits are priced at
 *   the model's rate per credit, as text to speech's are.
 *
 * v1 never served ElevenLabs, so nothing here replaces anything v1 did.
 */
import { defineOperation, defineProvider } from "./operation.ts";

/** ElevenLabs' default text-to-speech model, used when the request names none. */
const DEFAULT_TTS_MODEL = "eleven_multilingual_v2";

/** Credits are measured exactly by `character-cost` (plan T2). Characters give the estimate before the answer. */
const ttsMeter = {
  kind: "response_header",
  header: "character-cost",
  unit: "credits",
  estimate: { measure: "characters", field: "text", unit: "characters" },
} as const;

const ttsModel = { in: "body", field: "model_id", default: DEFAULT_TTS_MODEL } as const;

export const elevenlabs = defineProvider({
  type: "elevenlabs",
  label: "ElevenLabs",
  hosts: { main: "api.elevenlabs.io" },
  auth: { header: "xi-api-key", format: "{key}" },
  // ElevenLabs has no service modes on these APIs.
  serviceModes: [],
  // First draft. Step 5 reviews the refused paths of every provider.
  refused: [
    "v1/user/*",
    "v1/workspace/*",
    "v1/service-accounts/*",
    "v1/history/*",
    "v1/usage/*",
    "v1/voices/add",
    "v1/voices/{voice_id}/edit",
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
      meter: ttsMeter,
    }),
    defineOperation({
      name: "elevenlabs.tts_stream",
      match: { method: "POST", path: "v1/text-to-speech/{voice_id}/stream" },
      lifecycle: "call",
      transport: "stream",
      model: ttsModel,
      meter: ttsMeter,
    }),
    defineOperation({
      name: "elevenlabs.tts_timestamps",
      match: { method: "POST", path: "v1/text-to-speech/{voice_id}/with-timestamps" },
      lifecycle: "call",
      transport: "http",
      model: ttsModel,
      meter: ttsMeter,
    }),
    defineOperation({
      name: "elevenlabs.tts",
      match: { method: "POST", path: "v1/text-to-speech/{voice_id}" },
      lifecycle: "call",
      transport: "binary",
      model: ttsModel,
      meter: ttsMeter,
    }),
    defineOperation({
      name: "elevenlabs.stt",
      match: { method: "POST", path: "v1/speech-to-text" },
      lifecycle: "call",
      transport: "upload",
      model: { in: "body", field: "model_id" },
      outbound: {
        // A webhook answers later, outside the gateway: the request is kept synchronous.
        webhooks: [
          { in: "form", field: "webhook" },
          { in: "form", field: "webhook_id" },
          { in: "form", field: "webhook_metadata" },
        ],
        // The audio to transcribe, when it is not uploaded: the operation needs it.
        fetchKept: [{ in: "form", field: "cloud_storage_url" }],
      },
      meter: {
        kind: "response_header",
        header: "character-cost",
        unit: "credits",
        providerCost: { header: "fiat-cost-before-overages", currency: { header: "fiat-currency", value: "usd" } },
      },
    }),
  ],
});

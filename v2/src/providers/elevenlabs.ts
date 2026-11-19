/**
 * ElevenLabs.
 *
 * Step 1a declares only text-to-speech, as one of the hardest shapes: the
 * voice is in the path, the answer is audio, and the billed amount is a
 * response header in credits. Step 4 completes and tests it against the real
 * API.
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

export const elevenlabs = defineProvider({
  type: "elevenlabs",
  hosts: { main: "api.elevenlabs.io" },
  auth: { header: "xi-api-key", format: "{key}" },
  // First draft. Step 4 reviews it with the full operation list.
  refused: [
    "v1/user/*",
    "v1/workspace/*",
    "v1/service-accounts/*",
    "v1/history/*",
    "v1/usage/*",
    "v1/voices/add",
    "v1/voices/{voice_id}/edit",
  ],
  operations: [
    defineOperation({
      name: "elevenlabs.tts_stream",
      match: { method: "POST", path: "v1/text-to-speech/{voice_id}/stream" },
      lifecycle: "call",
      transport: "stream",
      model: { in: "body", field: "model_id", default: DEFAULT_TTS_MODEL },
      meter: ttsMeter,
    }),
    defineOperation({
      name: "elevenlabs.tts",
      match: { method: "POST", path: "v1/text-to-speech/{voice_id}" },
      lifecycle: "call",
      transport: "binary",
      model: { in: "body", field: "model_id", default: DEFAULT_TTS_MODEL },
      meter: ttsMeter,
    }),
  ],
});

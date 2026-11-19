/** Every built-in provider description, by type. */
import { elevenlabs } from "./elevenlabs.ts";
import { fal } from "./fal.ts";
import { openai } from "./openai.ts";
import type { ProviderDescription } from "./operation.ts";

export const BUILT_IN_PROVIDERS: Readonly<Record<string, ProviderDescription>> = {
  [elevenlabs.type]: elevenlabs,
  [fal.type]: fal,
  [openai.type]: openai,
};

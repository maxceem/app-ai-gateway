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

/** The built-in description of a provider type, or null. Only the listed types: never an inherited property. */
export function builtInProvider(type: string): ProviderDescription | null {
  return Object.hasOwn(BUILT_IN_PROVIDERS, type) ? BUILT_IN_PROVIDERS[type]! : null;
}

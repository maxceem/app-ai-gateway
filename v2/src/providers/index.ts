/** Every built-in provider description, by type. */
import { anthropic } from "./anthropic.ts";
import {
  baseten,
  bytedance,
  cerebras,
  deepseek,
  fireworks,
  groq,
  huggingface,
  mistral,
  moonshot,
  perplexity,
  together,
} from "./compatible.ts";
import { elevenlabs } from "./elevenlabs.ts";
import { fal } from "./fal.ts";
import { gemini } from "./gemini.ts";
import { openai } from "./openai.ts";
import { openrouter } from "./openrouter.ts";
import { vercel } from "./vercel.ts";
import type { ProviderDescription } from "./operation.ts";
import { xai } from "./xai.ts";

const ALL: readonly ProviderDescription[] = [
  openai,
  anthropic,
  xai,
  gemini,
  perplexity,
  deepseek,
  groq,
  mistral,
  together,
  fireworks,
  cerebras,
  moonshot,
  huggingface,
  baseten,
  bytedance,
  openrouter,
  vercel,
  elevenlabs,
  fal,
];

export const BUILT_IN_PROVIDERS: Readonly<Record<string, ProviderDescription>> = Object.fromEntries(
  ALL.map((provider) => [provider.type, provider]),
);

/** The built-in description of a provider type, or null. Only the listed types: never an inherited property. */
export function builtInProvider(type: string): ProviderDescription | null {
  return Object.hasOwn(BUILT_IN_PROVIDERS, type) ? BUILT_IN_PROVIDERS[type]! : null;
}

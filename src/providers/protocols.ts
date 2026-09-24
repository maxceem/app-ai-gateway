/**
 * What the Worker does with a wire protocol: the output cap each clamp style
 * enforces. The protocols themselves — their paths, clamp styles, body kinds
 * and usage formats — and the classifier that picks one from a path are data
 * the console shares, in `src/shared/protocols.ts`, and are re-exported here
 * for the Worker modules that read them beside the behaviour.
 */

import type { OutputClampStyle } from "../shared/capabilities.ts";
import type { Protocol } from "../shared/protocols.ts";
import { providerDescriptor, type ProviderType } from "../shared/providers.ts";
import { GatewayError } from "../core/errors.ts";

export {
  classifyPath,
  PROTOCOLS,
  type ClassifiedPath,
  type Protocol,
  type UsageFormat,
} from "../shared/protocols.ts";

/** The clamp style actually in force for a protocol on one provider type. */
export function clampStyleFor(protocol: Protocol, provider: ProviderType): OutputClampStyle {
  return protocol.clamp === "native" ? providerDescriptor(provider).nativeClampStyle : protocol.clamp;
}

function capExceeded(field: string, cap: number): GatewayError {
  return new GatewayError(
    403,
    "max_output_tokens_exceeded",
    `Request ${field} exceeds the configured max_output_tokens cap of ${cap}`,
  );
}

/**
 * Whether `body` already names `key`, refusing a numeric value above the cap.
 * A present field is the client's own choice and is judged, never overwritten.
 */
function judged(body: Record<string, unknown>, key: string, cap: number, field = key): boolean {
  if (!Object.hasOwn(body, key)) return false;
  if (typeof body[key] === "number" && body[key] > cap) throw capExceeded(field, cap);
  return true;
}

/** Judges the one field, or writes the cap into it where the client named none. */
function capField(key: string) {
  return (body: Record<string, unknown>, cap: number): boolean => {
    if (judged(body, key, cap)) return false;
    body[key] = cap;
    return true;
  };
}

/**
 * How each clamp style enforces a cap on a body it may mutate. Each returns
 * whether it changed the body, so an untouched request is forwarded as sent.
 */
const OUTPUT_CAPS: Record<
  OutputClampStyle,
  (body: Record<string, unknown>, cap: number, provider: ProviderType) => boolean
> = {
  none: () => false,
  responses: capField("max_output_tokens"),
  anthropic: capField("max_tokens"),
  chat_completions: (body, cap, provider) => {
    // Both spellings are judged: a client may send either, and neither may
    // exceed the cap.
    const named = [judged(body, "max_tokens", cap), judged(body, "max_completion_tokens", cap)];
    if (named.some(Boolean)) return false;
    // `max_tokens` unless this type's own chat-completions surface reads
    // something else, which OpenAI's does.
    body[providerDescriptor(provider).chatCompletionsCapField ?? "max_tokens"] = cap;
    return true;
  },
  gemini_native: (body, cap) => {
    const current = body.generationConfig;
    const generationConfig =
      typeof current === "object" && current !== null && !Array.isArray(current)
        ? (current as Record<string, unknown>)
        : {};
    if (judged(generationConfig, "maxOutputTokens", cap, "generationConfig.maxOutputTokens")) {
      return false;
    }
    generationConfig.maxOutputTokens = cap;
    body.generationConfig = generationConfig;
    return true;
  },
};

/** Enforces an output cap in the field `style` names; returns whether the body changed. */
export function clampOutput(
  style: OutputClampStyle,
  provider: ProviderType,
  body: Record<string, unknown>,
  cap: number | undefined,
): boolean {
  return cap === undefined ? false : OUTPUT_CAPS[style](body, cap, provider);
}

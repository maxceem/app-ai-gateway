/**
 * The wire protocols the gateway reads and writes, one object each.
 *
 * Everything the Worker knows about an API style — the provider paths it is
 * reached at, whether one of them names the model, which body field caps the
 * output, which usage format its answers report — is one entry in
 * {@link PROTOCOLS}. The proxy classifies a request by its path, a named
 * endpoint names its style outright, and both then read the same entry.
 *
 * The vocabulary itself (`API_STYLES`, the clamp styles) is shared with the
 * console in `src/shared/capabilities.ts`; the behaviour lives here because
 * nothing in a browser build clamps a body or reads a usage object.
 */

import {
  API_STYLES,
  type ApiStyle,
  type OutputClampStyle,
} from "../shared/capabilities.ts";
import { providerDescriptor, type ProviderType } from "../shared/providers.ts";
import { GatewayError } from "./errors.ts";

export { API_STYLES, type ApiStyle };

/** The usage object an answer carries, which picks the reader in `./usage-readers.ts`. */
export type UsageFormat = "openai" | "anthropic" | "gemini" | "audio" | "unknown";

export interface Protocol {
  readonly style: ApiStyle;
  /**
   * The exact provider path shapes this protocol is reached at, or `null` for
   * `other`, which is whatever no pattern matches. A named `model` group marks
   * the one protocol that carries the model in the URL rather than the body.
   *
   * These match supported provider URL layouts, not arbitrary suffixes. The
   * classifier is also an authorization boundary when `allowed_paths` is
   * empty, so a control-plane path that happens to end in `messages` or
   * `responses` must remain `other`.
   */
  readonly path: RegExp | null;
  /**
   * The body field an output cap is clamped in, or `native` where the body is
   * the provider's own and its descriptor's `nativeClampStyle` decides — which
   * keeps a stray `…/messages` path on a non-Anthropic provider clamped by that
   * provider's own request shape.
   */
  readonly clamp: OutputClampStyle | "native";
  /** What its answers report usage in. `unknown` sniffs, because nothing else says. */
  readonly usage: UsageFormat;
}

export const PROTOCOLS: Record<ApiStyle, Protocol> = {
  audio_transcription: {
    style: "audio_transcription",
    path: /^(?:(?:v1|openai\/v1)\/audio\/transcriptions|v1\/stt)$/u,
    clamp: "none",
    usage: "audio",
  },
  chat_completions: {
    style: "chat_completions",
    path: /^(?:chat|v1\/chat|openai\/v1\/chat|inference\/v1\/chat|v1beta\/openai\/chat)\/completions$/u,
    clamp: "chat_completions",
    usage: "openai",
  },
  responses: {
    style: "responses",
    path: /^(?:v1|openai\/v1)\/responses$/u,
    clamp: "responses",
    usage: "openai",
  },
  gemini_native: {
    style: "gemini_native",
    path: /^v1(?:alpha|beta)?\/models\/(?<model>[^/]+):(?:generateContent|streamGenerateContent)$/du,
    clamp: "gemini_native",
    usage: "gemini",
  },
  anthropic_messages: {
    style: "anthropic_messages",
    path: /^v1\/messages$/u,
    clamp: "native",
    usage: "anthropic",
  },
  other: {
    style: "other",
    path: null,
    clamp: "native",
    usage: "unknown",
  },
};

const CLASSIFIED: readonly (Protocol & { path: RegExp })[] = Object.values(PROTOCOLS).filter(
  (protocol): protocol is Protocol & { path: RegExp } => protocol.path !== null,
);

/** A provider path as the protocol it speaks, and the model it names if it names one. */
export interface ClassifiedPath {
  protocol: Protocol;
  /**
   * Present only where the path carries the model, with `template` naming its
   * place. `value` is still percent-encoded: decoding is the caller's, after it
   * has decided the path is allowed at all.
   */
  model?: { value: string; template: string };
}

/**
 * Classifies the requested operation from the provider path alone. Provider
 * identity is deliberately not consulted: the same path is the same operation
 * on every route that offers it, which is what makes the capability matrix
 * expressible.
 */
export function classifyPath(providerPath: string): ClassifiedPath {
  for (const protocol of CLASSIFIED) {
    const match = protocol.path.exec(providerPath);
    if (!match) continue;
    const span = match.indices?.groups?.model;
    const value = match.groups?.model;
    if (span === undefined || value === undefined) return { protocol };
    return {
      protocol,
      model: {
        value,
        template: `${providerPath.slice(0, span[0])}{model}${providerPath.slice(span[1])}`,
      },
    };
  }
  return { protocol: PROTOCOLS.other };
}

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

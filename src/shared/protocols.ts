/**
 * The wire protocols the gateway reads and writes, one object each, as data.
 *
 * Everything known about an API style — the provider paths it is reached at,
 * whether one of them names the model, which body field caps the output, what
 * body it takes, which usage format its answers report — is one entry in
 * {@link PROTOCOLS}. The proxy classifies a request by its path, a named
 * endpoint names its style outright, and both then read the same entry.
 *
 * Shared with the console, which classifies an example path with the same
 * classifier the proxy judges real requests by; it imports nothing but the
 * vocabulary in `./capabilities.ts`, for the reason that module gives. The
 * behaviour that reads the table — clamping a body, reading a usage object —
 * lives in `src/providers/protocols.ts` and `src/usage`, because nothing in a
 * browser build does either.
 */

import type { ApiStyle, OutputClampStyle } from "./capabilities.ts";

/** The usage object an answer carries, which picks the reader in `src/usage/usage-readers.ts`. */
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
  /**
   * The request body it takes: JSON, or a multipart form carrying a file. A
   * custom endpoint reads its client's body as this, and `other` is JSON because
   * that is what a provider-native operation is assumed to send.
   */
  readonly body: "json" | "multipart";
}

export const PROTOCOLS: Record<ApiStyle, Protocol> = {
  audio_transcription: {
    style: "audio_transcription",
    // A translation is a transcription into English: the same multipart
    // request, and the same answer.
    path: /^(?:(?:v1|openai\/v1)\/audio\/(?:transcriptions|translations)|v1\/stt)$/u,
    clamp: "none",
    usage: "audio",
    body: "multipart",
  },
  chat_completions: {
    style: "chat_completions",
    path: /^(?:chat|v1\/chat|openai\/v1\/chat|inference\/v1\/chat|v1beta\/openai\/chat)\/completions$/u,
    clamp: "chat_completions",
    usage: "openai",
    body: "json",
  },
  responses: {
    style: "responses",
    path: /^(?:v1|openai\/v1)\/responses$/u,
    clamp: "responses",
    usage: "openai",
    body: "json",
  },
  gemini_native: {
    style: "gemini_native",
    path: /^v1(?:alpha|beta)?\/models\/(?<model>[^/]+):(?:generateContent|streamGenerateContent)$/du,
    clamp: "gemini_native",
    usage: "gemini",
    body: "json",
  },
  anthropic_messages: {
    style: "anthropic_messages",
    path: /^v1\/messages$/u,
    clamp: "native",
    usage: "anthropic",
    body: "json",
  },
  other: {
    style: "other",
    path: null,
    clamp: "native",
    usage: "unknown",
    body: "json",
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

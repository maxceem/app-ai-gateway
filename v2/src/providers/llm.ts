/**
 * The text operations today's LLM providers share (plan step 3), one builder
 * per API style. A provider description lists the ones it serves, at its own
 * paths.
 *
 * Every one of them is a call with a JSON body, whose model is the body's
 * `model`, measured by its style's usage reader, and refuses a request that
 * asks the provider to run it in the background (v1's `refuseDetachedJob`):
 * such an answer is an acknowledgement with no usage, and the result and its
 * cost arrive only on a later poll the gateway does not serve.
 */
import type { BackgroundOption, OperationDescription, OutputCap, ProviderCostReport } from "./operation.ts";
import { defineOperation } from "./operation.ts";

/**
 * OpenAI's, Gemini's and Perplexity's `background: true`, and xAI's
 * `deferred: true`. Only a literal `true` counts: OpenAI's image `background`
 * is a string naming the image's transparency.
 */
export const DETACHED: readonly BackgroundOption[] = [
  { field: { in: "body", field: "background" }, action: "refuse" },
  { field: { in: "body", field: "deferred" }, action: "refuse" },
];

interface TextOptions {
  /** Where the output cap goes. Each style has its usual field; a provider may name another. */
  readonly cap?: OutputCap;
  /** The provider's own cost report, read from the same answer. */
  readonly providerCost?: ProviderCostReport;
}

function meter(style: OperationDescription["style"] & string, options: TextOptions) {
  return {
    kind: "response_json",
    style,
    ...(options.providerCost !== undefined ? { providerCost: options.providerCost } : {}),
  } as const;
}

/** Chat Completions. A stream is asked to end with its usage. */
export function chat(name: string, path: string, options: TextOptions = {}): OperationDescription {
  return defineOperation({
    name,
    match: { method: "POST", path },
    lifecycle: "call",
    transport: "stream",
    style: "openai-chat",
    model: { in: "body", field: "model" },
    policy: { lockable: ["model"], outputCap: options.cap ?? "chat", streamUsage: true },
    background: DETACHED,
    meter: meter("openai-chat", options),
  });
}

/** Legacy and fill-in-the-middle completions: usage in the Chat Completions shape, capped in `max_tokens`. */
export function completions(name: string, path: string, options: TextOptions = {}): OperationDescription {
  return defineOperation({
    name,
    match: { method: "POST", path },
    lifecycle: "call",
    transport: "stream",
    style: "openai-completions",
    model: { in: "body", field: "model" },
    policy: { lockable: ["model"], outputCap: options.cap ?? "chat" },
    background: DETACHED,
    meter: meter("openai-completions", options),
  });
}

/** The Responses API, and the APIs shaped like it. */
export function responses(name: string, path: string, options: TextOptions = {}): OperationDescription {
  return defineOperation({
    name,
    match: { method: "POST", path },
    lifecycle: "call",
    transport: "stream",
    style: "openai-responses",
    model: { in: "body", field: "model" },
    policy: { lockable: ["model"], outputCap: options.cap ?? "responses" },
    background: DETACHED,
    meter: meter("openai-responses", options),
  });
}

/** The Messages API, on Anthropic and the services that offer it. */
export function messages(name: string, path: string, options: TextOptions = {}): OperationDescription {
  return defineOperation({
    name,
    match: { method: "POST", path },
    lifecycle: "call",
    transport: "stream",
    style: "anthropic-messages",
    model: { in: "body", field: "model" },
    policy: { lockable: ["model"], outputCap: options.cap ?? "anthropic" },
    background: DETACHED,
    meter: meter("anthropic-messages", options),
  });
}

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

/**
 * The text paths v1 served on every provider by their path alone, when an
 * app listed no paths (v1's `defaultPath`): Chat Completions, Responses and
 * Messages at each layout v1 recognised. Gemini's own paths are declared by
 * Gemini only: no other provider has them, so they never worked elsewhere.
 */
const V1_TEXT_PATHS: readonly (readonly [suffix: string, path: string, style: "chat" | "responses" | "messages"])[] = [
  ["chat", "v1/chat/completions", "chat"],
  ["chat", "chat/completions", "chat"],
  ["chat.openai", "openai/v1/chat/completions", "chat"],
  ["chat.inference", "inference/v1/chat/completions", "chat"],
  ["chat.gemini-openai", "v1beta/openai/chat/completions", "chat"],
  ["responses", "v1/responses", "responses"],
  ["responses.openai", "openai/v1/responses", "responses"],
  ["messages", "v1/messages", "messages"],
];

const BUILDERS = { chat, responses, messages } as const;

/**
 * A provider's operations, plus every text path v1 served for it that it does
 * not declare already, so nothing v1 served is refused. `styles` narrows them
 * (OpenRouter served Chat Completions only); `options` gives each style's
 * output cap and cost report, as the provider's own operations have them.
 *
 * An added operation is named `<type>.<suffix>`. When that name is taken, it
 * gets `.v1` for a path under `v1/`, else `.bare`.
 */
export function withV1Paths(
  type: string,
  operations: readonly OperationDescription[],
  options: {
    readonly styles?: readonly ("chat" | "responses" | "messages")[];
    readonly chat?: TextOptions;
    readonly responses?: TextOptions;
    readonly messages?: TextOptions;
  } = {},
): OperationDescription[] {
  const all = [...operations];
  const names = new Set(all.map((operation) => operation.name));
  const paths = new Set(all.map((operation) => operation.match.path));
  for (const [suffix, path, style] of V1_TEXT_PATHS) {
    if (paths.has(path) || (options.styles !== undefined && !options.styles.includes(style))) continue;
    let name = `${type}.${suffix}`;
    if (names.has(name)) name = `${name}.${path.startsWith("v1/") ? "v1" : "bare"}`;
    names.add(name);
    paths.add(path);
    all.push(BUILDERS[style](name, path, options[style]));
  }
  return all;
}

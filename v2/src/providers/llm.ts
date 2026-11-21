/**
 * The operations today's LLM providers share (plan step 3), one builder per
 * API style. A provider description lists the ones it serves, at its own
 * paths.
 *
 * Every one of them is a call whose model is the request's `model` field (a
 * JSON body's, or a multipart form's), measured by its style's usage reader.
 * A JSON request that asks the provider to run it in the background is
 * refused (v1's `refuseDetachedJob`): such an answer is an acknowledgement
 * with no usage, and the result and its cost arrive only on a later poll the
 * gateway does not serve.
 */
import type { BackgroundOption, OperationDescription, OutputCap, ProviderCostReport, UsageHeader } from "./operation.ts";
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
  /** Its answers may report only that cost, with no usage (`costOnly`). */
  readonly costOnly?: true;
  /** Token counts its answers report in headers (`usageHeaders`). */
  readonly usageHeaders?: readonly UsageHeader[];
  /** Its request may also be an upload (`uploads`), as an image edit is. */
  readonly uploads?: true;
}

function meter(style: OperationDescription["style"] & string, options: TextOptions) {
  return {
    kind: "response_json",
    style,
    ...(options.providerCost !== undefined ? { providerCost: options.providerCost } : {}),
    ...(options.costOnly !== undefined ? { costOnly: options.costOnly } : {}),
    ...(options.usageHeaders !== undefined ? { usageHeaders: options.usageHeaders } : {}),
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
 * Speech to text (v1's `audio_transcription`). The request is usually a
 * multipart upload with the model in a form field, and a JSON body is read
 * too. `defaultModel` is the model a request that names none is billed as,
 * where the provider runs one by default; its form is sent unchanged. Its `response_format` is judged where the provider declares
 * `transcriptionFormats`, so the answer carries what it is billed by.
 */
export function transcription(name: string, path: string, options: { readonly defaultModel?: string } = {}): OperationDescription {
  return defineOperation({
    name,
    match: { method: "POST", path },
    lifecycle: "call",
    transport: "upload",
    style: "openai-transcription",
    model: { in: "form", field: "model", ...(options.defaultModel !== undefined ? { default: options.defaultModel } : {}) },
    audioFormFields: ["file"],
    meter: { kind: "response_json", style: "openai-transcription", units: ["audio_seconds"] },
  });
}

/**
 * Image generation or edits. No output cap: an image has no output tokens to
 * bound, and a provider would refuse the field. An edit is a multipart upload.
 */
export function images(name: string, path: string, options: TextOptions = {}): OperationDescription {
  return defineOperation({
    name,
    match: { method: "POST", path },
    lifecycle: "call",
    transport: "http",
    style: "openai-images",
    model: { in: "body", field: "model" },
    background: DETACHED,
    ...(options.uploads !== undefined ? { uploads: options.uploads } : {}),
    meter: { ...meter("openai-images", options), units: ["images"] },
    // What an image's price varies by on the providers' own lists: its size and quality.
    priceKeys: [
      { name: "size", from: { in: "body", field: "size" } },
      { name: "quality", from: { in: "body", field: "quality" } },
    ],
  });
}

/** Embeddings, in the OpenAI shape. Billed on their input tokens. */
export function embeddings(name: string, path: string): OperationDescription {
  return defineOperation({
    name,
    match: { method: "POST", path },
    lifecycle: "call",
    transport: "http",
    style: "openai-embeddings",
    model: { in: "body", field: "model" },
    background: DETACHED,
    meter: { kind: "response_json", style: "openai-embeddings" },
  });
}

/**
 * Text to speech. The answer is audio, or a stream of events ending with its
 * usage. Audio alone reports no usage: it is billed from the request's
 * characters for a model priced per character (`per_million_characters`, a
 * customer's own rate say), and otherwise its cost stays unknown and is
 * logged, as in v1. Usage in the answer, where it has some, always wins.
 */
export function speech(name: string, path: string): OperationDescription {
  return defineOperation({
    name,
    match: { method: "POST", path },
    lifecycle: "call",
    transport: "binary",
    style: "openai-speech",
    model: { in: "body", field: "model" },
    background: DETACHED,
    meter: { kind: "response_json", style: "openai-speech", requestMeasure: { measure: "characters", field: "input", unit: "characters" } },
  });
}

type V1Style = "chat" | "responses" | "messages" | "transcription";

/**
 * The paths v1 served on every provider by their path alone, when an app
 * listed no paths (v1's `defaultPath`): Chat Completions, Responses, Messages
 * and transcription, at each layout v1 recognised. Gemini's own paths are
 * declared by Gemini only: no other provider has them, so they never worked
 * elsewhere.
 */
const V1_DEFAULT_PATHS: readonly (readonly [suffix: string, path: string, style: V1Style])[] = [
  ["chat", "v1/chat/completions", "chat"],
  ["chat", "chat/completions", "chat"],
  ["chat.openai", "openai/v1/chat/completions", "chat"],
  ["chat.inference", "inference/v1/chat/completions", "chat"],
  ["chat.gemini-openai", "v1beta/openai/chat/completions", "chat"],
  ["responses", "v1/responses", "responses"],
  ["responses.openai", "openai/v1/responses", "responses"],
  ["messages", "v1/messages", "messages"],
  ["transcription", "v1/audio/transcriptions", "transcription"],
  ["transcription.openai", "openai/v1/audio/transcriptions", "transcription"],
  ["transcription.stt", "v1/stt", "transcription"],
];

const BUILDERS: Readonly<Record<V1Style, (name: string, path: string, options?: TextOptions) => OperationDescription>> = {
  chat,
  responses,
  messages,
  transcription: (name, path) => transcription(name, path),
};

/**
 * A provider's operations, plus every path v1 served for it by its shape that
 * it does not declare already, so nothing v1 served is refused. `styles`
 * narrows them (OpenRouter served Chat Completions only); `options` gives each
 * text style's output cap and cost report, as the provider's own operations
 * have them.
 *
 * An added operation is named `<type>.<suffix>`. When that name is taken, it
 * gets `.v1` for a path under `v1/`, else `.bare`.
 */
export function withV1Paths(
  type: string,
  operations: readonly OperationDescription[],
  options: {
    readonly styles?: readonly V1Style[];
    readonly chat?: TextOptions;
    readonly responses?: TextOptions;
    readonly messages?: TextOptions;
  } = {},
): OperationDescription[] {
  const all = [...operations];
  const names = new Set(all.map((operation) => operation.name));
  const paths = new Set(all.map((operation) => operation.match.path));
  for (const [suffix, path, style] of V1_DEFAULT_PATHS) {
    if (paths.has(path) || (options.styles !== undefined && !options.styles.includes(style))) continue;
    let name = `${type}.${suffix}`;
    if (names.has(name)) name = `${name}.${path.startsWith("v1/") ? "v1" : "bare"}`;
    names.add(name);
    paths.add(path);
    all.push(BUILDERS[style](name, path, style === "transcription" ? undefined : options[style]));
  }
  return all;
}

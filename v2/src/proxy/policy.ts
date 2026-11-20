/**
 * An operation's request policy (plan section 4.1), ported from v1's
 * output caps and body rules.
 *
 * - Background work: a request that asks the provider to run it in the
 *   background is refused. Its answer has no usage, and its result and cost
 *   arrive on a later poll the gateway does not serve.
 * - The output cap: a request that asks for more than the app's
 *   `max_output_tokens` is refused; one that asks for none gets the cap
 *   written into the field its API reads.
 * - Usage in a stream: `stream_options.include_usage` is added to a Chat
 *   Completions request that streams. OpenAI refuses `stream_options` on a
 *   request that does not stream.
 *
 * The last two change the body in place and say whether they changed it.
 */
import { GatewayError } from "../core/errors.ts";
import type { OperationDescription, OutputCap } from "../providers/operation.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The value at a dot path of the body, or undefined. */
function fieldAt(body: Record<string, unknown>, path: string): unknown {
  let value: unknown = body;
  for (const key of path.split(".")) {
    const record = asRecord(value);
    if (record === null || !Object.hasOwn(record, key)) return undefined;
    value = record[key];
  }
  return value;
}

/** Refuses a request whose background option is set to a literal `true`. */
export function refuseBackground(operation: OperationDescription, body: Record<string, unknown>): void {
  for (const option of operation.background ?? []) {
    if (option.field.in !== "body" || fieldAt(body, option.field.field) !== true) continue;
    throw new GatewayError(
      400,
      "invalid_request",
      "Background and deferred requests are not supported: their result and cost arrive on a later poll the gateway cannot serve",
    );
  }
}

function capExceeded(field: string, cap: number): GatewayError {
  return new GatewayError(403, "max_output_tokens_exceeded", `Request ${field} exceeds the configured max_output_tokens cap of ${cap}`);
}

/**
 * Whether `record` names `key`, refusing a number above the cap. `null` asks
 * for no limit, so it counts as absent: the cap is written instead.
 */
function named(record: Record<string, unknown>, key: string, cap: number, field = key): boolean {
  if (!Object.hasOwn(record, key) || record[key] === null) return false;
  const value = record[key];
  if (typeof value === "number" && value > cap) throw capExceeded(field, cap);
  return true;
}

/** Judges the fields, or writes the cap into the first where the client named none. */
function capFields(record: Record<string, unknown>, cap: number, judged: readonly string[], written: string, prefix = ""): boolean {
  const any = judged.map((key) => named(record, key, cap, `${prefix}${key}`)).some(Boolean);
  if (any) return false;
  record[written] = cap;
  return true;
}

const OUTPUT_CAPS: Readonly<Record<OutputCap, (body: Record<string, unknown>, cap: number) => boolean>> = {
  chat: (body, cap) => capFields(body, cap, ["max_tokens", "max_completion_tokens"], "max_tokens"),
  "chat-completion-tokens": (body, cap) => capFields(body, cap, ["max_tokens", "max_completion_tokens"], "max_completion_tokens"),
  responses: (body, cap) => capFields(body, cap, ["max_output_tokens"], "max_output_tokens"),
  anthropic: (body, cap) => capFields(body, cap, ["max_tokens"], "max_tokens"),
  gemini: (body, cap) => {
    const config = asRecord(body.generationConfig) ?? {};
    const changed = capFields(config, cap, ["maxOutputTokens"], "maxOutputTokens", "generationConfig.");
    if (changed) body.generationConfig = config;
    return changed;
  },
};

/** Applies the app's output cap where the operation's API reads it. */
export function applyOutputCap(operation: OperationDescription, body: Record<string, unknown>, cap: number | undefined): boolean {
  const where = operation.policy?.outputCap;
  if (cap === undefined || where === undefined) return false;
  return OUTPUT_CAPS[where](body, cap);
}

/** Asks a streamed Chat Completions request to end with its usage. */
export function requestStreamUsage(operation: OperationDescription, body: Record<string, unknown>): boolean {
  if (operation.policy?.streamUsage !== true || body.stream !== true) return false;
  const options = asRecord(body.stream_options) ?? {};
  if (options.include_usage === true) return false;
  body.stream_options = { ...options, include_usage: true };
  return true;
}

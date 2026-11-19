/**
 * The request policy of the OpenAI chat style, ported from v1.
 *
 * - The output cap: a request that asks for more than `max_output_tokens`
 *   in `max_tokens` or `max_completion_tokens` is refused; one that asks for
 *   none gets `max_completion_tokens` set to the cap.
 * - Usage in a stream: `stream_options.include_usage` is added only when the
 *   request streams. OpenAI refuses `stream_options` on a request that does
 *   not stream.
 *
 * Both change the body in place and say whether they changed it.
 */
import { GatewayError } from "../core/errors.ts";

function capExceeded(field: string, cap: number): GatewayError {
  return new GatewayError(
    403,
    "max_output_tokens_exceeded",
    `Request ${field} exceeds the configured max_output_tokens cap of ${cap}`,
  );
}

/** Applies the app's output cap to a chat request. */
export function applyChatOutputCap(body: Record<string, unknown>, cap: number | undefined): boolean {
  if (cap === undefined) return false;
  let named = false;
  for (const field of ["max_tokens", "max_completion_tokens"]) {
    if (!Object.hasOwn(body, field)) continue;
    named = true;
    const value = body[field];
    if (typeof value === "number" && value > cap) throw capExceeded(field, cap);
  }
  if (named) return false;
  body.max_completion_tokens = cap;
  return true;
}

/** Asks a streamed chat request to end with its usage. */
export function requestStreamUsage(body: Record<string, unknown>): boolean {
  if (body.stream !== true) return false;
  const current = body.stream_options;
  const options =
    typeof current === "object" && current !== null && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
  if (options.include_usage === true) return false;
  body.stream_options = { ...options, include_usage: true };
  return true;
}

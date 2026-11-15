import type { ObservedBody } from "./body-observer";

/**
 * Why the gateway itself recorded a failed attempt, where the provider never
 * answered: it did not answer in time, or it could not be reached.
 */
export type NoAnswer = "timeout" | "connection_failed";

/** A code as a provider spells one: a short token, never a sentence. */
const CODE = /^[A-Za-z0-9_.:-]{1,60}$/u;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * The code a provider's error response names, or null where it names none
 * this can read.
 *
 * Providers put it in a few places, read in this order:
 *
 * - `error.code`: OpenAI and the OpenAI-compatible APIs (`rate_limit_exceeded`);
 * - `error.type`: OpenAI's broader kind, and Anthropic's (`overloaded_error`);
 * - `error.status`: Gemini (`RESOURCE_EXHAUSTED`), whose `error.code` is the
 *   HTTP status as a number;
 * - `code`, then `type`, at the top level: Mistral and others without an
 *   `error` object.
 *
 * Only a short token is kept. The provider's message is never read: it can
 * quote the request, and a usage event must never hold client text. A body
 * too big to keep whole is not an error body worth parsing.
 */
export function providerErrorCode(body: ObservedBody): string | null {
  if (body.truncated) return null;
  let value: unknown;
  try {
    value = JSON.parse(body.head);
  } catch {
    return null;
  }
  // Gemini can answer with a one-element array.
  const root = asRecord(Array.isArray(value) ? value[0] : value);
  if (!root) return null;
  const error = asRecord(root.error);
  const candidates = error ? [error.code, error.type, error.status] : [root.code, root.type];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && CODE.test(candidate)) return candidate;
  }
  return null;
}

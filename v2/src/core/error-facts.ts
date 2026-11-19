/**
 * What a log may say about an error: its class, its gateway code and a
 * recognised platform failure. Never its message, which can hold request
 * values or credentials.
 */
import { GatewayError, type ErrorCode } from "./errors.ts";
import { platformFailure, type PlatformFailureReason } from "./platform-errors.ts";

export interface ErrorFacts {
  class: string;
  code?: ErrorCode;
  platform?: PlatformFailureReason;
}

const KNOWN_CLASSES = new Set([
  "GatewayError",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "AggregateError",
  "DOMException",
  "ZodError",
  "DrizzleQueryError",
  "DrizzleError",
  "Error",
]);

export function errorFacts(error: unknown): ErrorFacts {
  if (!(error instanceof Error)) return { class: "not_an_error" };
  const name = typeof error.name === "string" && KNOWN_CLASSES.has(error.name) ? error.name : "other";
  const facts: ErrorFacts = { class: name };
  if (error instanceof GatewayError) facts.code = error.code;
  const platform = platformFailure(error);
  if (platform !== null) facts.platform = platform;
  return facts;
}

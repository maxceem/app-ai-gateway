import { KmsClientError } from "@maxceem/cf-kms/client";
import { DrizzleError, DrizzleQueryError } from "drizzle-orm";
import { ZodError } from "zod";
import {
  SecretVaultBlobError,
  SecretVaultConfigurationError,
  type SecretVaultProblem,
  type SecretVaultSetting,
} from "../vault/types";
import { GatewayError, type ErrorCode } from "./errors";
import {
  recognisedFailure,
  type KnownPlatformMessage,
  type PlatformFailureReason,
} from "./platform-errors";

/**
 * The error classes a log line names. An error of any other class is logged as
 * `other`: a class name is a string too, and only names this list spells are
 * written.
 */
type ErrorClass =
  | "GatewayError"
  | "SecretVaultConfigurationError"
  | "SecretVaultBlobError"
  | "KmsClientError"
  | "DrizzleQueryError"
  | "DrizzleError"
  | "ZodError"
  | "DOMException"
  | "AggregateError"
  | "TypeError"
  | "RangeError"
  | "SyntaxError"
  | "ReferenceError"
  | "URIError"
  | "EvalError"
  | "Error"
  | "other"
  | "not_an_error"
  | "unreadable";

/** Most specific first: `instanceof` matches a subclass's ancestors as well. */
const ERROR_CLASSES: readonly (readonly [new (...args: never[]) => Error, ErrorClass])[] = [
  [GatewayError, "GatewayError"],
  [SecretVaultConfigurationError, "SecretVaultConfigurationError"],
  [SecretVaultBlobError, "SecretVaultBlobError"],
  [KmsClientError, "KmsClientError"],
  [DrizzleQueryError, "DrizzleQueryError"],
  [DrizzleError, "DrizzleError"],
  [ZodError, "ZodError"],
  [AggregateError, "AggregateError"],
  [TypeError, "TypeError"],
  [RangeError, "RangeError"],
  [SyntaxError, "SyntaxError"],
  [ReferenceError, "ReferenceError"],
  [URIError, "URIError"],
  [EvalError, "EvalError"],
];

const MAX_CAUSE_DEPTH = 4;

/**
 * What a log line says about an error: its class, and the short codes and
 * numbers the gateway's own errors and services define. Never an error's
 * message or stack, which can quote what it was given — a query lists its
 * bound values, a JSON parse error its input.
 */
export interface ErrorFacts {
  class: ErrorClass;
  /** A gateway refusal's code. */
  code?: ErrorCode;
  /** The platform failure it was recognised as, and the documented message that recognised it. */
  platform?: Exclude<PlatformFailureReason, "deadline_exceeded">;
  platformMessage?: KnownPlatformMessage;
  /** Which vault setting a configuration error is about, and what is wrong with it. */
  vault?: { setting: SecretVaultSetting; problem: SecretVaultProblem; kekVersion?: number };
  /** A cf-kms failure's code and the HTTP status it came with. */
  kms?: { code: string; status: number };
  /** Cloudflare's own flags, copied only where they are booleans. */
  retryable?: boolean;
  overloaded?: boolean;
  remote?: boolean;
  cause?: ErrorFacts;
}

function errorClass(error: Error): ErrorClass {
  if (error instanceof DOMException) return "DOMException";
  for (const [type, name] of ERROR_CLASSES) {
    if (error instanceof type) return name;
  }
  return Object.getPrototypeOf(error) === Error.prototype ? "Error" : "other";
}

/** `true` or `false` where `value` is that boolean, and nothing otherwise. */
function flag(value: unknown): boolean | undefined {
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
}

/**
 * The facts about `error` that are safe to log, and the only description of
 * an error a log line may carry.
 *
 * Never throws. Reading an error runs its getters, and a getter or a `Proxy`
 * may throw; this is called from error handlers, where a throw would let the
 * original error escape to the runtime, which logs its message and stack.
 */
export function errorFacts(error: unknown, depth = 0): ErrorFacts {
  try {
    return readFacts(error, depth);
  } catch {
    return { class: "unreadable" };
  }
}

function readFacts(error: unknown, depth: number): ErrorFacts {
  if (!(error instanceof Error)) return { class: "not_an_error" };
  const flags = error as { retryable?: unknown; overloaded?: unknown; remote?: unknown };
  const facts: ErrorFacts = { class: errorClass(error) };
  if (error instanceof GatewayError) facts.code = error.code;
  if (error instanceof SecretVaultConfigurationError) {
    facts.vault = {
      setting: error.setting,
      problem: error.problem,
      ...(error.kekVersion === undefined ? {} : { kekVersion: error.kekVersion }),
    };
  }
  if (error instanceof KmsClientError) facts.kms = { code: error.code, status: error.status };
  const recognised = recognisedFailure(error);
  if (recognised !== null) {
    facts.platform = recognised.reason;
    if (recognised.message !== undefined) facts.platformMessage = recognised.message;
  }
  const retryable = flag(flags.retryable);
  const overloaded = flag(flags.overloaded);
  const remote = flag(flags.remote);
  if (retryable !== undefined) facts.retryable = retryable;
  if (overloaded !== undefined) facts.overloaded = overloaded;
  if (remote !== undefined) facts.remote = remote;
  if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH) facts.cause = errorFacts(error.cause, depth + 1);
  return facts;
}

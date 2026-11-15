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
  | "APIError"
  | "BetterAuthError"
  | "BetterCallError"
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

/**
 * Library errors named by their `name` rather than their class, because
 * importing their class would put the library on every cold start: Better
 * Auth's and better-call's. Matched only against this list, so a name is
 * never copied for being one.
 */
const NAMED_CLASSES: ReadonlySet<ErrorClass> = new Set(["APIError", "BetterAuthError", "BetterCallError"]);

/**
 * A code as libraries and SQLite spell them: upper-case words joined by
 * underscores, such as `FAILED_TO_GET_SESSION` or `SQLITE_BUSY`. No digits and
 * at least one underscore, so a key, a token or an identifier cannot pass for
 * one.
 */
const CODE = /^[A-Z]+(?:_[A-Z]+)+$/u;
/** The database codes an error's message may name, copied alone and never the text around them. */
const DATABASE_CODE = /\b(?:SQLITE|D1)_[A-Z]+(?:_[A-Z]+)*\b/gu;
const MAX_CODES = 4;

/**
 * One stack frame as V8 writes it — `at fn (file:line:col)`, `at async fn
 * (…)` or `at file:line:col` — reduced to the function and where in the
 * bundle it is. A frame of any other shape is dropped.
 */
const FRAME = /^at (?:async )?(?:(?:new )?([A-Za-z0-9_$.<>[\] ]{1,100}) \()?([^()\s]{1,300}):(\d{1,7}):(\d{1,7})\)?$/u;
const MAX_FRAMES = 8;

const MAX_CAUSE_DEPTH = 4;

/**
 * What a log line says about an error: its class, the short codes and numbers
 * the gateway's own errors and services define, codes of a fixed shape, and
 * where in the code it was thrown. Never an error's message, nor the first
 * line of its stack that repeats it, which can quote what it was given — a
 * query lists its bound values, a JSON parse error its input.
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
  /**
   * The codes the error carries in its `code`, `status` or `body.code`, and the
   * database codes its message names — only those of the {@link CODE} shape,
   * and only the code itself.
   */
  codes?: string[];
  /**
   * Where it was thrown: its stack below the error's own first line, which is
   * the only line that quotes its message, as `function file:line:col`. Code
   * locations, never data.
   */
  where?: string[];
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
  if (Object.getPrototypeOf(error) === Error.prototype) return "Error";
  const name: unknown = error.name;
  return typeof name === "string" && NAMED_CLASSES.has(name as ErrorClass) ? (name as ErrorClass) : "other";
}

/** The {@link CODE}-shaped codes `error` carries, at most {@link MAX_CODES}. */
function errorCodes(error: Error): string[] {
  const carried = error as { code?: unknown; status?: unknown; body?: unknown };
  const body = carried.body !== null && typeof carried.body === "object" ? (carried.body as { code?: unknown }) : {};
  const codes = new Set<string>();
  for (const value of [carried.code, carried.status, body.code]) {
    if (typeof value === "string" && value.length <= 64 && CODE.test(value)) codes.add(value);
  }
  if (typeof error.message === "string") {
    for (const [match] of error.message.matchAll(DATABASE_CODE)) {
      if (match.length <= 64) codes.add(match);
    }
  }
  return [...codes].slice(0, MAX_CODES);
}

/**
 * The frames of `error`'s stack, read only below its first line. That line is
 * `name: message`, and a message can run over several lines; so the stack is
 * read only when it begins with exactly that, and everything after it is a
 * frame the runtime wrote. Anything else — a stack a library rewrote, a name
 * changed after the error was made — gives no frames at all.
 */
function stackFrames(error: Error): string[] {
  const stack: unknown = error.stack;
  const name: unknown = error.name;
  const message: unknown = error.message;
  if (typeof stack !== "string" || typeof name !== "string" || typeof message !== "string") return [];
  const header = message === "" ? name : `${name}: ${message}`;
  if (!stack.startsWith(`${header}\n`)) return [];
  const frames: string[] = [];
  for (const line of stack.slice(header.length + 1).split("\n")) {
    const match = FRAME.exec(line.trim());
    if (match === null) continue;
    const [, fn, file, row, column] = match;
    frames.push(`${fn ?? "<anonymous>"} ${file!.split(/[\\/]/u).pop()}:${row}:${column}`);
    if (frames.length === MAX_FRAMES) break;
  }
  return frames;
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
  const codes = errorCodes(error);
  if (codes.length > 0) facts.codes = codes;
  const where = stackFrames(error);
  if (where.length > 0) facts.where = where;
  if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH) facts.cause = errorFacts(error.cause, depth + 1);
  return facts;
}

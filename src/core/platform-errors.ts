import { DrizzleQueryError } from "drizzle-orm";
import { GatewayError } from "./errors";

/**
 * Why a request was refused as `service_unavailable`. Log- and event-only, like
 * every `reason`: the client's correct response to all three is the same.
 */
export type PlatformFailureReason =
  | "platform_unavailable"
  | "platform_overloaded"
  | "deadline_exceeded";

/** What a `service_unavailable` refusal asks the client to wait before retrying. */
export const PLATFORM_RETRY_AFTER_SECONDS = 5;

/**
 * D1's documented transient errors, which its guide answers with "retry the
 * operation". D1 errors carry no `retryable` flag, so the message is all there
 * is to go on. Its memory, CPU and storage-timeout resets are deliberately
 * absent: those are caused by the query's own cost, and stay internal errors.
 */
const D1_TRANSIENT_MESSAGES = [
  "Network connection lost.",
  "Replica disconnected from primary.",
  "Internal error in D1 DB storage caused object to be reset.",
  "Cannot resolve D1 DB due to transient issue on remote node.",
  "Internal error while starting up D1 DB storage caused object to be reset.",
  "D1 DB reset because its code was updated.",
];
const D1_OVERLOADED_PREFIX = "D1 DB is overloaded.";

/**
 * What the Workers runtime substitutes for a failure inside the runtime
 * itself. The gateway never writes it, so it always names the platform.
 */
const RUNTIME_INTERNAL_PREFIX = "internal error; reference = ";

const MAX_CAUSE_DEPTH = 4;
const MAX_STACK_FRAMES = 8;

interface CloudflareErrorFlags {
  retryable?: unknown;
  overloaded?: unknown;
  remote?: unknown;
}

/** The causes an error was wrapped around, itself first. */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  while (current !== undefined && current !== null && chain.length <= MAX_CAUSE_DEPTH) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

function classify(error: unknown): PlatformFailureReason | null {
  if (!(error instanceof Error)) return null;
  const flags = error as CloudflareErrorFlags;
  // Durable Object stubs mark their own failures; an overloaded object is
  // still the platform's state, not a fault in the call that met it.
  if (flags.overloaded === true) return "platform_overloaded";
  if (flags.retryable === true) return "platform_unavailable";
  const message = error.message.replace(/^D1_ERROR: /u, "");
  if (message.startsWith(D1_OVERLOADED_PREFIX)) return "platform_overloaded";
  if (D1_TRANSIENT_MESSAGES.includes(message)) return "platform_unavailable";
  if (message.startsWith(RUNTIME_INTERNAL_PREFIX)) return "platform_unavailable";
  return null;
}

/**
 * Whether `error` is the platform failing underneath the gateway — D1, a
 * Durable Object, or the runtime itself — rather than the gateway's own code.
 * Looks through wrappers such as Drizzle's query error to the cause they hold.
 */
export function platformFailure(error: unknown): PlatformFailureReason | null {
  for (const link of causeChain(error)) {
    const reason = classify(link);
    if (reason !== null) return reason;
  }
  return null;
}

/** The refusal a client gets when the platform, not its request, is at fault. */
export function serviceUnavailable(
  reason: PlatformFailureReason,
  message: string,
  cause?: unknown,
): GatewayError {
  return new GatewayError(
    503,
    "service_unavailable",
    message,
    { "retry-after": String(PLATFORM_RETRY_AFTER_SECONDS) },
    { reason, cause },
  );
}

/**
 * The refusal `error` should be answered with: itself when it already is one,
 * `service_unavailable` when the platform failed, and `null` for anything else,
 * which is a fault in the gateway and stays an `internal_error`.
 */
export function asGatewayError(error: unknown): GatewayError | null {
  if (error instanceof GatewayError) return error;
  const reason = platformFailure(error);
  if (reason === null) return null;
  return serviceUnavailable(reason, "The gateway is temporarily unavailable; retry shortly", error);
}

export interface ErrorDescription {
  name: string;
  message: string;
  retryable?: boolean;
  overloaded?: boolean;
  remote?: boolean;
  stack?: string[];
  cause?: ErrorDescription;
}

/**
 * A D1 type error quotes the value it refused, which may be one the caller
 * sent; the code before it is all that is kept.
 */
const D1_VALUE_QUOTING_PREFIX = "D1_TYPE_ERROR";

/**
 * The frames of `error`'s stack, or none where they cannot be told apart from
 * its message. V8 opens a stack with `name: message`, and a message may run
 * over several lines — a Drizzle query error's lists the bound values — so
 * the whole header is cut off before any line is read as a frame.
 */
function stackFrames(error: Error): string[] {
  const header = error.message === "" ? error.name : `${error.name}: ${error.message}`;
  if (!error.stack?.startsWith(header)) return [];
  return error.stack
    .slice(header.length)
    .split("\n")
    .filter((line) => /^ {4}at /u.test(line))
    .slice(0, MAX_STACK_FRAMES)
    .map((line) => line.trim());
}

function loggableMessage(error: Error): string {
  if (error instanceof DrizzleQueryError) return `Failed query: ${error.query}`;
  if (error.message.startsWith(D1_VALUE_QUOTING_PREFIX)) return `${D1_VALUE_QUOTING_PREFIX} (value withheld)`;
  return error.message;
}

/**
 * Everything worth logging about an unexpected error: its class, message,
 * Cloudflare's flags, where it was thrown, and what it wrapped.
 *
 * Bound values are never copied. A Drizzle query error is reduced to the SQL
 * it ran, since its message lists the values, which may be a caller's
 * credential material; a D1 type error loses the value it quotes; and the
 * stack keeps only frames that follow the message.
 */
export function describeError(error: unknown, depth = 0): ErrorDescription {
  if (!(error instanceof Error)) return { name: typeof error, message: String(error) };
  const query = error instanceof DrizzleQueryError;
  const flags = error as CloudflareErrorFlags;
  const frames = stackFrames(error);
  return {
    name: query ? "DrizzleQueryError" : error.name,
    message: loggableMessage(error),
    ...(typeof flags.retryable === "boolean" ? { retryable: flags.retryable } : {}),
    ...(typeof flags.overloaded === "boolean" ? { overloaded: flags.overloaded } : {}),
    ...(typeof flags.remote === "boolean" ? { remote: flags.remote } : {}),
    ...(frames.length > 0 ? { stack: frames } : {}),
    ...(error.cause !== undefined && depth < MAX_CAUSE_DEPTH
      ? { cause: describeError(error.cause, depth + 1) }
      : {}),
  };
}

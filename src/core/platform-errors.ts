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
] as const;
const D1_OVERLOADED_PREFIX = "D1 DB is overloaded.";
const D1_ERROR_PREFIX = "D1_ERROR: ";

/**
 * What the Workers runtime substitutes for a failure inside the runtime
 * itself. The gateway never writes it, so it always names the platform.
 */
const RUNTIME_INTERNAL_PREFIX = "internal error; reference = ";

/**
 * The platform messages the gateway recognises, as the gateway itself spells
 * them. A recognised error is described by one of these strings, never by its
 * own message: the error's text only selects which constant applies.
 */
export type KnownPlatformMessage =
  | (typeof D1_TRANSIENT_MESSAGES)[number]
  | typeof D1_OVERLOADED_PREFIX
  | "internal error";

const MAX_CAUSE_DEPTH = 4;

interface CloudflareErrorFlags {
  retryable?: unknown;
  overloaded?: unknown;
}

/** One error recognised as the platform failing, without what it wrapped. */
export interface RecognisedFailure {
  reason: Exclude<PlatformFailureReason, "deadline_exceeded">;
  /** Absent where a Durable Object flag recognised it rather than the message. */
  message?: KnownPlatformMessage;
}

/** Whether this one error, not its causes, is the platform failing. */
export function recognisedFailure(error: unknown): RecognisedFailure | null {
  try {
    return recognise(error);
  } catch {
    // An error whose properties cannot be read is not one the platform is
    // known to have raised. Never thrown on: callers are error handlers.
    return null;
  }
}

function recognise(error: unknown): RecognisedFailure | null {
  if (!(error instanceof Error)) return null;
  const flags = error as CloudflareErrorFlags;
  // Durable Object stubs mark their own failures; an overloaded object is
  // still the platform's state, not a fault in the call that met it.
  if (flags.overloaded === true) return { reason: "platform_overloaded" };
  if (flags.retryable === true) return { reason: "platform_unavailable" };
  const text: unknown = error.message;
  if (typeof text !== "string") return null;
  const message = text.startsWith(D1_ERROR_PREFIX) ? text.slice(D1_ERROR_PREFIX.length) : text;
  if (message.startsWith(D1_OVERLOADED_PREFIX)) {
    return { reason: "platform_overloaded", message: D1_OVERLOADED_PREFIX };
  }
  const transient = D1_TRANSIENT_MESSAGES.find((known) => known === message);
  if (transient !== undefined) return { reason: "platform_unavailable", message: transient };
  if (message.startsWith(RUNTIME_INTERNAL_PREFIX)) {
    return { reason: "platform_unavailable", message: "internal error" };
  }
  return null;
}

/**
 * Whether `error` is the platform failing underneath the gateway — D1, a
 * Durable Object, or the runtime itself — rather than the gateway's own code.
 * Looks through wrappers such as Drizzle's query error to the cause they hold.
 */
export function platformFailure(error: unknown): PlatformFailureReason | null {
  let current = error;
  try {
    for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
      const recognised = recognisedFailure(current);
      if (recognised !== null) return recognised.reason;
      current = current.cause;
    }
  } catch {
    // A cause that cannot be read ends the search, as it would end any other.
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

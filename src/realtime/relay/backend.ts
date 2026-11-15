import { RelayError } from "./errors";
import { REALTIME_LIMITS } from "./limits";
import {
  REALTIME_BACKEND_CONTRACT as V,
  type BackendResult,
  type Bootstrap,
  type PreviousGrant,
  type RealtimeBackendCalls,
  type SessionGrant,
  type SessionLease,
  type Settlement,
} from "./contract";

/** What a session asks the gateway, with refusals thrown as {@link RelayError}. */
export interface SessionBackend {
  grant(bootstrap: Bootstrap, headers: Headers, previous: SessionGrant | null): Promise<SessionGrant>;
  capacity(
    bootstrap: Bootstrap,
    scope: "user" | "app",
    operation: "acquire" | "renew" | "release",
    cap?: number,
  ): Promise<SessionLease>;
  /** Counts one response already sent; a refusal applies from the next turn. */
  admit(bootstrap: Bootstrap, headers: Headers, previous: SessionGrant, generationId: string, at: number): Promise<SessionGrant>;
  settle(bootstrap: Bootstrap, settlement: Settlement): Promise<void>;
  maintain(bootstrap: Bootstrap, headers: Headers, previous: SessionGrant, active: boolean): Promise<SessionGrant>;
}

export function unwrapBackend<T>(result: BackendResult<T>): T {
  if (result.ok) return result.value;
  const e = result.error;
  throw new RelayError(e.status, e.code, e.message, e.headers, e.data);
}

/** Whether a thrown error is one the platform marks as worth repeating. */
function transient(error: unknown): boolean {
  return error instanceof Error && (
    ("retryable" in error && error.retryable === true)
    || ("overloaded" in error && error.overloaded === true)
  );
}

/** What the gateway compares of the last grant. The credential stays here. */
function prior(grant: SessionGrant): PreviousGrant;
function prior(grant: SessionGrant | null): PreviousGrant | null;
function prior(grant: SessionGrant | null): PreviousGrant | null {
  return grant && { checks: grant.checks, outputCap: grant.outputCap };
}

/** Retries transport failures only. A refusal is never retried. */
export async function safeBackendCall<T>(
  call: () => Promise<BackendResult<T>>,
  deadline = Date.now() + REALTIME_LIMITS.setupMs,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let response: BackendResult<T>;
    try {
      response = await call();
    } catch (error) {
      const backoffMs = 100 * (attempt + 1);
      if (!transient(error) || attempt >= 2 || Date.now() + backoffMs >= deadline) {
        throw new RelayError(503, "provider_unavailable", "Realtime backend unavailable");
      }
      await new Promise(resolve => setTimeout(resolve, backoffMs));
      continue;
    }
    return unwrapBackend(response);
  }
}

/**
 * The session's gateway, reached through `calls`: the binding in a realtime
 * Worker, or the same calls made in-process when the gateway serves sessions
 * itself. Both take the one path, so they behave alike.
 */
export function sessionBackend(calls: RealtimeBackendCalls): SessionBackend {
  return {
    grant: (b, headers, previous) => safeBackendCall(() => calls.grant(V, b, headers, prior(previous))),
    capacity: (b, scope, operation, cap) => safeBackendCall(() => calls.capacity(V, b, scope, operation, cap)),
    // Retried for a platform fault, as the other calls are: the gateway's
    // limiters keep a receipt per generation id, so a repeat never counts twice.
    admit: (b, headers, previous, generationId, at) =>
      safeBackendCall(() => calls.admit(V, b, headers, prior(previous), generationId, at)),
    settle: (b, settlement) => safeBackendCall(() => calls.settle(V, b, settlement)),
    maintain: (b, headers, previous, active) =>
      safeBackendCall(() => calls.maintain(V, b, headers, prior(previous), active)),
  };
}

import { RpcTarget } from "cloudflare:workers";
import { RelayError } from "./errors";
import { REALTIME_LIMITS } from "./limits";
import {
  REALTIME_BACKEND_CONTRACT as V,
  type AdmissionClaim,
  type AdmissionReceipt,
  type BackendResult,
  type Bootstrap,
  type PreviousGrant,
  type RealtimeBackendCalls,
  type SessionGrant,
  type SessionLease,
  type Settlement,
  type UsageTicket,
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
  /**
   * Admits one response. `beforeClaim` runs before the gateway spends the
   * claim, and must store it; `live` says whether the session still wants it.
   */
  admit(
    bootstrap: Bootstrap,
    headers: Headers,
    previous: SessionGrant,
    generationId: string,
    at: number,
    beforeClaim: (claim: AdmissionClaim | null, ticket: UsageTicket) => void | Promise<void>,
    live: () => boolean,
  ): Promise<SessionGrant>;
  receipt(bootstrap: Bootstrap, generationId: string): Promise<AdmissionReceipt | null>;
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

class DurableClaimAcknowledgement extends RpcTarget {
  constructor(
    private beforeClaim: (claim: AdmissionClaim | null, ticket: UsageTicket) => void | Promise<void>,
    private live: () => boolean,
  ) {
    super();
  }

  async acknowledge(claim: AdmissionClaim | null, ticket: UsageTicket) {
    if (!this.live()) throw new Error("Realtime session ended");
    // Once stored the claim goes ahead, and recovery reconciles it.
    await this.beforeClaim(claim, ticket);
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
    async admit(b, headers, previous, generationId, at, beforeClaim, live) {
      const acknowledgement = new DurableClaimAcknowledgement(beforeClaim, live);
      const call = () => calls.admit(V, b, headers, prior(previous), generationId, at, acknowledgement);
      try {
        return unwrapBackend(await call());
      } catch (error) {
        // Once, and only for a platform fault: the gateway's limiters keep a
        // receipt per generation id, so a repeat never counts twice. Anything
        // else is reconciled through the stored claim's receipt.
        if (!transient(error) || !live()) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
        return unwrapBackend(await call());
      }
    },
    receipt: (b, id) => safeBackendCall(() => calls.receipt(V, b, id)),
    settle: (b, settlement) => safeBackendCall(() => calls.settle(V, b, settlement)),
    maintain: (b, headers, previous, active) =>
      safeBackendCall(() => calls.maintain(V, b, headers, prior(previous), active)),
  };
}

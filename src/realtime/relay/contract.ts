/**
 * Everything that crosses the binding between the realtime Worker and the
 * gateway.
 *
 * The realtime Worker holds the sockets and nothing else of the gateway's: no
 * pricing, no limits, no app settings, no provider routing. It asks the
 * gateway through these calls instead, so a gateway release or a price update
 * never changes its code. A release Worker is reused for as long as its code
 * is unchanged, and the sessions open on it stay open.
 *
 * The rules that keep that true:
 *
 * - A running realtime Worker can be up to a few days older than the gateway
 *   it calls. The gateway answers every contract version a retained release
 *   declares, so change these shapes only by adding optional fields.
 * - Values the gateway hands the realtime Worker to keep and send back, the
 *   claim and the usage ticket, are opaque to it. The gateway reads the ones
 *   it wrote in any earlier release.
 * - Nothing here may carry a secret into storage. The grant holds the
 *   provider credential, so the realtime Worker keeps it in memory only.
 *
 * Only types and the version number live here, so importing this file adds no
 * code to either Worker. Type imports from the gateway are fine: they leave no
 * code behind.
 */

import type { GatewayIdentity } from "../../core/types";
import type { ErrorCode } from "../../core/errors";
import type { RealtimeProtocol } from "../../shared/capabilities";

export { REALTIME_BACKEND_CONTRACT } from "./version";

export type JsonObject = Record<string, unknown>;

export type { RealtimeProtocol };

export type CompletionStatus = "completed" | "cancelled" | "failed" | "incomplete" | "interrupted";

/**
 * Who opened a session, and on what, as the gateway decided at the handshake.
 * The realtime Worker stores it and sends it back on every call; it reads only
 * `sessionId`, `protocol`, `requestedModel` and the identity's `expiresAt`.
 */
export interface Bootstrap {
  sessionId: string;
  appId: string;
  organizationId: string;
  providerId: string;
  providerSlug: string;
  model: string;
  requestedModel: string;
  protocol: RealtimeProtocol;
  identity: GatewayIdentity;
  appVersion: string | null;
  origin: string;
}

/**
 * What the gateway allows a session right now. It comes back from every check,
 * so a change of policy takes effect at the next one. Held in memory only: it
 * carries the provider credential.
 */
export interface SessionGrant {
  /** Where to open the provider socket, with the headers that authenticate it. */
  upstream: { url: string; headers: Record<string, string> };
  protocol: RealtimeProtocol;
  /** The model the provider is asked for. */
  model: string;
  /** The most output tokens one response may produce. */
  outputCap: number;
  maxSessionSeconds: number;
  maxSessionsPerIdentity: number;
  maxSessions: number;
  /**
   * Whether the session waits for the provider's first event before it sends
   * its configuration, as Cloudflare AI Gateway requires.
   */
  waitForProvider: boolean;
  /**
   * Opaque to the realtime Worker. The gateway compares it with the next
   * check's, to end a session whose credentials or rules changed under it.
   */
  checks: JsonObject;
  /** What the gateway needs to record a response's usage, as of this check. */
  ticket: UsageTicket;
}

/**
 * What the realtime Worker sends back of its last grant, for the gateway to
 * compare. Never the credential: the gateway has its own.
 */
export type PreviousGrant = Pick<SessionGrant, "checks" | "outputCap">;

/**
 * What the gateway needs to record a response's usage: the record's metadata
 * and the price, as of the session's last check. The realtime Worker stores it
 * with each response. Opaque to it, and free of secrets, so it can be stored
 * for recovery.
 */
export type UsageTicket = JsonObject;

/** What a finished, or abandoned, response reports for its usage record. */
export interface Settlement {
  generationId: string;
  /** When the response was sent to the provider, epoch milliseconds. */
  at: number;
  ticket: UsageTicket;
  /** The provider's own usage object, as it reported it; null when it reported none. */
  usage: JsonObject | null;
  responseId: string | null;
  status: CompletionStatus;
  /** Whether the session ended before the response did. */
  aborted: boolean;
  latencyMs: number;
}

export interface SessionLease {
  allowed: boolean;
  expiresAt: number;
}

/** A refusal, carried as data so it keeps its status, code and headers. */
export interface BackendRefusal {
  status: number;
  code: ErrorCode;
  message: string;
  headers: Record<string, string>;
  data?: Record<string, string | number | boolean>;
}

export type BackendResult<T> = { ok: true; value: T } | { ok: false; error: BackendRefusal };

/**
 * The gateway's side of the binding. Each call names the contract version its
 * caller speaks. A refusal comes back as data; anything thrown is an outage,
 * with only its `retryable` and `overloaded` flags kept.
 */
export interface RealtimeBackendCalls {
  /** Authenticates a WebSocket handshake and decides who the session is. */
  prepare(
    version: number,
    releaseId: string,
    request: Request,
    appId: string,
    provider: string,
    origin: string,
  ): Promise<BackendResult<{ bootstrap: Bootstrap; headers: Headers }>>;
  /** Checks the session again. `previous` is null when the session opens. */
  grant(
    version: number,
    bootstrap: Bootstrap,
    headers: Headers,
    previous: PreviousGrant | null,
  ): Promise<BackendResult<SessionGrant>>;
  capacity(
    version: number,
    bootstrap: Bootstrap,
    scope: "user" | "app",
    operation: "acquire" | "renew" | "release",
    cap?: number,
  ): Promise<BackendResult<SessionLease>>;
  /**
   * Checks the session again and counts one response, which the realtime
   * Worker has already sent to the provider: a refusal applies from its next
   * turn. Repeating it for the same `generationId` counts nothing twice.
   */
  admit(
    version: number,
    bootstrap: Bootstrap,
    headers: Headers,
    previous: PreviousGrant,
    generationId: string,
    at: number,
  ): Promise<BackendResult<SessionGrant>>;
  /** Records a response's usage. Repeating it records nothing twice. */
  settle(version: number, bootstrap: Bootstrap, settlement: Settlement): Promise<BackendResult<void>>;
  /** Checks the session again while it stays open. */
  maintain(
    version: number,
    bootstrap: Bootstrap,
    headers: Headers,
    previous: PreviousGrant,
    active: boolean,
  ): Promise<BackendResult<SessionGrant>>;
}

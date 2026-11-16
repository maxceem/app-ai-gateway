import { and, eq } from "drizzle-orm";
import type { ErrorCode } from "../core/errors";
import { log } from "../core/log";
import { timeOrderedId } from "../core/ids";
import { database } from "../db/index";
import type { AuthMethod } from "../core/types";
import type { ClientNetwork } from "../core/client-network";
import { appAuthChallenge, appAuthEvent, type AuthEventName } from "../db/schema";
import { storedAppVersion } from "../core/app-version";
import { storedClientSdk } from "../core/client-sdk";
import { errorFacts } from "../core/error-facts";

/**
 * How long an authentication attempt stays on file. Long enough to answer "did
 * this get worse after the release three weeks ago?", short enough that a
 * diagnostic table never becomes the largest thing a deployment stores. These
 * rows are dropped outright; usage events, which are billing history, are summed
 * into `app_usage_rollup` before theirs are.
 */
export const AUTH_EVENT_RETENTION_DAYS = 90;

/** How long an App Attest challenge can be spent, from the moment it is issued. */
export const CHALLENGE_TTL_SECONDS = 300;

/**
 * How a `challenge` auth event ended. None is an error code a client was
 * handed: each describes an issued challenge that no registration or exchange
 * spent.
 *
 * - `abandoned`: it expired unused and the app never said why.
 * - `client_failed`: the app reported the step that failed on the device.
 * - `client_recovered`: the app reported a failure it then recovered from by
 *   itself, such as a key lost when the app was reinstalled.
 */
export type ChallengeOutcome = "abandoned" | "client_failed" | "client_recovered";

const SUCCESS_RECORD_ATTEMPTS = 3;
const RECORD_RETRY_DELAY_MS = 25;

export interface AuthEventInput {
  env: Env;
  appId: string;
  event: AuthEventName;
  /** Null wherever the attempt never established a trusted identity. */
  userId?: string | null;
  authMethod?: AuthMethod | null;
  /** `ok`, the error code the client was handed, or how a challenge ended: a constant either way, so it may be logged. */
  outcome: "ok" | ErrorCode | ChallengeOutcome;
  reason?: string | null;
  appVersion?: string | null;
  /** The raw `X-Client-SDK` header; only a well-formed value is stored. */
  clientSdk?: string | null;
  /** The network the attempt came from; see `clientNetwork`. */
  network?: ClientNetwork | null;
  latencyMs: number;
  claimDelayMs?: number | null;
}

/**
 * Records one authentication attempt, and never fails the request that made it.
 *
 * The response has already been decided by the time this runs — the caller
 * hands it to `waitUntil` — so a recording failure is logged under its own code
 * and abandoned rather than thrown. Retrying is safe because the insert is
 * idempotent under `event_id`: an ambiguous failure that actually landed costs
 * a wasted no-op, never a duplicate row.
 */
export async function recordAuthEvent(input: AuthEventInput): Promise<void> {
  // Minted before any attempt so every retry, and any later replay, settles
  // under one identity.
  const eventId = timeOrderedId();
  // A successful exchange is worth retrying because it is trusted operational
  // history. A rejection is attacker-triggerable, so it gets one best-effort
  // insert: a D1 outage or exhausted quota must not triple the attacker's work.
  const attempts = input.outcome === "ok" ? SUCCESS_RECORD_ATTEMPTS : 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await database(input.env.DB)
        .insert(appAuthEvent)
        .values({
          eventId,
          appId: input.appId,
          userId: input.userId ?? null,
          event: input.event,
          authMethod: input.authMethod ?? null,
          outcome: input.outcome,
          reason: input.reason ?? null,
          appVersion: storedAppVersion(input.appVersion),
          clientSdk: storedClientSdk(input.clientSdk),
          networkAsn: input.network?.asn ?? null,
          networkName: input.network?.name ?? null,
          latencyMs: input.latencyMs,
          claimDelayMs: input.claimDelayMs ?? null,
        })
        .onConflictDoNothing({ target: appAuthEvent.eventId });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, RECORD_RETRY_DELAY_MS * attempt));
      }
    }
  }
  log("error", "auth_event_record_failed", {
    eventId,
    appId: input.appId,
    userId: input.userId ?? null,
    event: input.event,
    outcome: input.outcome,
    error: errorFacts(lastError),
  });
}

/**
 * Drops authentication attempts past the retention window.
 *
 * Scoped to `app_auth_event` on purpose and forever: `app_usage_event` is
 * accounting history, and nothing scheduled is allowed to delete a row that
 * something was billed for.
 */
export async function pruneAuthEvents(
  db: D1Database,
  retentionDays = AUTH_EVENT_RETENTION_DAYS,
): Promise<number> {
  const result = await db
    .prepare("DELETE FROM app_auth_event WHERE created_at < datetime('now', ?)")
    .bind(`-${retentionDays} days`)
    .run();
  return result.meta.changes ?? 0;
}

/**
 * Records that a registration or exchange named this challenge and was refused
 * before spending it.
 *
 * That attempt already has its own auth event, so without this mark the
 * challenge expiring afterwards would be counted as a second, abandoned
 * failure. A challenge the attempt did spend is gone already, and then this
 * changes nothing.
 */
export async function markChallengeAttempted(env: Env, appId: string, challenge: string): Promise<void> {
  await database(env.DB)
    .update(appAuthChallenge)
    .set({ attempted: true })
    .where(and(eq(appAuthChallenge.challenge, challenge), eq(appAuthChallenge.appId, appId)));
}

/** `YYYY-MM-DD HH:MM:SS` in UTC, the form SQLite's `datetime()` writes. */
function sqliteDateTime(at: Date): string {
  return at.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Settles App Attest challenges whose five-minute window has passed.
 *
 * Every challenge is issued for exactly one registration or exchange to spend.
 * One that expired with nothing ever naming it means the app's sign-in stopped
 * on the device between the two calls: App Attest failed there, the request
 * never arrived, or the app was closed. Each of those becomes a `challenge`
 * auth event, outcome `abandoned`, dated when the challenge was issued, and
 * then every expired challenge is deleted.
 *
 * The challenge endpoint is unauthenticated, so unused rows would otherwise
 * accumulate for as long as someone keeps asking for them. An expired row is
 * already worthless to `consumeChallenge`, which refuses anything past its
 * `expires_at`, so deleting it changes no outcome.
 *
 * Both statements compare against one cutoff, so a challenge that expires
 * between them is neither deleted without its event nor recorded twice. The
 * event is keyed by the challenge, so a batch that is retried after it landed
 * records nothing new.
 */
export async function settleExpiredChallenges(
  db: D1Database,
  now: Date = new Date(),
): Promise<{ abandoned: number; deleted: number }> {
  const cutoff = sqliteDateTime(now);
  const [recorded, deleted] = await db.batch([
    db.prepare(
      `INSERT INTO app_auth_event
         (event_id, app_id, event, outcome, reason, app_version, client_sdk, network_asn, network_name, created_at)
       SELECT 'challenge:' || challenge, app_id, 'challenge', 'abandoned', 'challenge_unused',
              app_version, client_sdk, network_asn, network_name, datetime(expires_at, ?)
         FROM app_auth_challenge
        WHERE expires_at < ? AND attempted = 0
       ON CONFLICT (event_id) DO NOTHING`,
    ).bind(`-${CHALLENGE_TTL_SECONDS} seconds`, cutoff),
    db.prepare("DELETE FROM app_auth_challenge WHERE expires_at < ?").bind(cutoff),
  ]);
  return { abandoned: recorded?.meta.changes ?? 0, deleted: deleted?.meta.changes ?? 0 };
}

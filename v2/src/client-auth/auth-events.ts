/**
 * Auth events: one `app_auth_event` row per sign-in attempt, successful or
 * refused, kept 90 days, so a developer can see why their app's users cannot
 * sign in.
 */
import { and, eq } from "drizzle-orm";
import { deletePass, type Pass } from "../core/chunked-delete.ts";
import { errorFacts } from "../core/error-facts.ts";
import type { ErrorCode } from "../core/errors.ts";
import { timeOrderedId } from "../core/ids.ts";
import { log } from "../core/log.ts";
import type { AuthMethod } from "../core/types.ts";
import type { ClientNetwork } from "../core/client-network.ts";
import { storedAppVersion } from "../core/app-version.ts";
import { storedClientSdk } from "../core/client-sdk.ts";
import { database } from "../db/index.ts";
import { appAuthChallenge, type AuthEventName } from "../db/schema.ts";

export const AUTH_EVENT_RETENTION_DAYS = 90;

/** How long an issued challenge can be used. */
export const CHALLENGE_TTL_SECONDS = 300;

/** What became of a challenge that no register or token call used. */
export type ChallengeOutcome = "abandoned" | "client_failed" | "client_recovered";

/** A success is worth a few tries: it is what tells a developer sign-in works. A refusal gets one. */
const SUCCESS_RECORD_ATTEMPTS = 3;
const RECORD_RETRY_DELAY_MS = 25;

export interface AuthEventInput {
  env: Env;
  appId: string;
  event: AuthEventName;
  userId?: string | null;
  authMethod?: AuthMethod | null;
  outcome: "ok" | ErrorCode | ChallengeOutcome;
  reason?: string | null;
  appVersion?: string | null;
  clientSdk?: string | null;
  network?: ClientNetwork | null;
  latencyMs: number;
}

/** What an attempt does to its user's wait for an entitlement claim, if anything. */
function claimChange(input: AuthEventInput): "open" | "close" | null {
  if (input.userId == null || input.event === "challenge") return null;
  if (input.outcome === "issuer_claims_missing") return "open";
  return input.outcome === "ok" ? "close" : null;
}

/**
 * The statements that record one attempt, run as one batch (one transaction):
 * the event, and the change it makes to the user's wait for an entitlement
 * claim. The event and the state change are written together, so neither is
 * lost without the other, and both are judged at the attempt's own time
 * `now`, so writes that land out of order still apply in attempt order:
 *
 * - a refusal for a missing claim opens the wait, unless a later successful
 *   sign-in of that user is already recorded (it ended the wait first);
 * - a successful sign-in closes a wait opened before it, and records on its
 *   event how long it was open. Two at once measure it once: the first
 *   transaction clears it.
 *
 * `account_id` comes from the app row at write time: an app deleted since
 * leaves it null, and such a row is never shown.
 */
function recordStatements(db: D1Database, input: AuthEventInput, id: string, now: number): D1PreparedStatement[] {
  const change = claimChange(input);
  const userId = input.userId ?? null;
  const statements = [
    db
      .prepare(
        `INSERT INTO app_auth_event
           (id, app_id, account_id, user_id, event, auth_method, outcome, reason, app_version, client_sdk,
            network_asn, network_name, latency_ms, claim_delay_ms, created_at)
         SELECT ?1, ?2, (SELECT account_id FROM app WHERE id = ?2), ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                ${
                  change === "close"
                    ? "(SELECT MAX(0, ?13 - claim_pending_since) FROM app_end_user WHERE app_id = ?2 AND id = ?3 AND claim_pending_since <= ?13)"
                    : "NULL"
                }, ?13
          WHERE true
         ON CONFLICT (id) DO NOTHING
         RETURNING claim_delay_ms`,
      )
      .bind(
        id,
        input.appId,
        userId,
        input.event,
        input.authMethod ?? null,
        input.outcome,
        input.reason ?? null,
        storedAppVersion(input.appVersion),
        storedClientSdk(input.clientSdk),
        input.network?.asn ?? null,
        input.network?.name ?? null,
        input.latencyMs,
        now,
      ),
  ];
  if (change === "close") {
    statements.push(
      db
        .prepare("UPDATE app_end_user SET claim_pending_since = NULL WHERE app_id = ? AND id = ? AND claim_pending_since <= ?")
        .bind(input.appId, userId, now),
    );
  } else if (change === "open") {
    // Never for a blocked user, whose wait could never end; only the first refusal opens it.
    statements.push(
      db
        .prepare(
          `INSERT INTO app_end_user (app_id, id, created_at, claim_pending_since)
           SELECT ?1, ?2, ?3, ?3
            WHERE NOT EXISTS (SELECT 1 FROM app_auth_event
                               WHERE app_id = ?1 AND user_id = ?2 AND outcome = 'ok' AND event <> 'challenge' AND created_at > ?3)
           ON CONFLICT (app_id, id) DO UPDATE SET claim_pending_since = excluded.claim_pending_since
            WHERE claim_pending_since IS NULL AND status = 'active'`,
        )
        .bind(input.appId, userId, now),
    );
  }
  return statements;
}

/**
 * Writes one auth event, with the change it makes to its user's wait for an
 * entitlement claim (see `recordStatements`). A failure is logged, never
 * thrown: a diagnostic never fails sign-in, and it runs after the answer is
 * sent. The attempt's time is taken when this is called, before any wait.
 */
export async function recordAuthEvent(input: AuthEventInput): Promise<void> {
  const id = timeOrderedId();
  const now = Date.now();
  const attempts = input.outcome === "ok" ? SUCCESS_RECORD_ATTEMPTS : 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const [event] = await input.env.DB.batch(recordStatements(input.env.DB, input, id, now));
      const delayMs = (event?.results[0] as { claim_delay_ms: number | null } | undefined)?.claim_delay_ms ?? null;
      if (delayMs !== null) log("info", "claim_propagation_recovered", { app: input.appId, delayMs });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, RECORD_RETRY_DELAY_MS * attempt));
    }
  }
  log("error", "auth_event_record_failed", {
    id,
    appId: input.appId,
    event: input.event,
    outcome: input.outcome,
    error: errorFacts(lastError),
  });
}

/** Marks a challenge as used by a refused attempt, so its expiry is not also counted as abandoned. */
export async function markChallengeAttempted(env: Env, appId: string, challenge: string): Promise<void> {
  await database(env.DB)
    .update(appAuthChallenge)
    .set({ attempted: true })
    .where(and(eq(appAuthChallenge.challenge, challenge), eq(appAuthChallenge.appId, appId)));
}

/**
 * Records every expired challenge nobody used as an `abandoned` event, then
 * deletes all expired challenges. The event id comes from the challenge, so
 * running this twice records each one once.
 */
export async function settleExpiredChallenges(
  db: D1Database,
  now: number = Date.now(),
): Promise<{ abandoned: number; deleted: number }> {
  const [recorded, deleted] = await db.batch([
    db
      .prepare(
        `INSERT INTO app_auth_event
           (id, app_id, account_id, event, outcome, reason, app_version, client_sdk, network_asn, network_name, created_at)
         SELECT 'challenge:' || challenge, app_id, (SELECT account_id FROM app WHERE app.id = app_auth_challenge.app_id),
                'challenge', 'abandoned', 'challenge_unused',
                app_version, client_sdk, network_asn, network_name, expires_at - ?
           FROM app_auth_challenge
          WHERE expires_at < ? AND attempted = 0
         ON CONFLICT (id) DO NOTHING`,
      )
      .bind(CHALLENGE_TTL_SECONDS * 1000, now),
    db.prepare("DELETE FROM app_auth_challenge WHERE expires_at < ?").bind(now),
  ]);
  return { abandoned: recorded?.meta.changes ?? 0, deleted: deleted?.meta.changes ?? 0 };
}

/**
 * The nightly pass deleting auth events older than the retention, a chunk at
 * a time (`../core/chunked-delete.ts`). Served by `app_auth_event_created`.
 */
export function authEventsPass(now: number): Pass {
  return deletePass("auth_events_prune", {
    table: "app_auth_event",
    rowids: "SELECT rowid FROM app_auth_event WHERE created_at < ?",
    params: [now - AUTH_EVENT_RETENTION_DAYS * 86_400_000],
  });
}

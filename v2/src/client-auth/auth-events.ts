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
import { appAuthChallenge, appAuthEvent, type AuthEventName } from "../db/schema.ts";

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

/**
 * Opens a user's wait for an entitlement claim: their issuer token was valid
 * but lacked a required claim. Only the first refusal opens it, and never for
 * a blocked user, whose wait could never end. Never throws.
 */
async function markClaimPending(db: D1Database, appId: string, userId: string, now: number): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO app_end_user (app_id, id, created_at, claim_pending_since) VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT (app_id, id) DO UPDATE SET claim_pending_since = excluded.claim_pending_since
         WHERE claim_pending_since IS NULL AND status = 'active'`,
      )
      .bind(appId, userId, now)
      .run();
  } catch (error) {
    log("warn", "claim_pending_mark_failed", { app: appId, error: errorFacts(error) });
  }
}

/**
 * Closes a user's wait for an entitlement claim, if one is open, and returns
 * how long it was. Null when none was open, or when closing it failed: a wait
 * still open has not been measured. Never throws.
 */
async function settleClaimPending(db: D1Database, appId: string, userId: string, now: number): Promise<number | null> {
  try {
    const row = await db
      .prepare(
        `UPDATE app_end_user SET claim_pending_since = NULL
          WHERE app_id = ? AND id = ? AND claim_pending_since IS NOT NULL
          RETURNING claim_pending_since AS since`,
      )
      .bind(appId, userId)
      .first<{ since: number | null }>();
    if (row?.since == null) return null;
    const delayMs = Math.max(0, now - row.since);
    log("info", "claim_propagation_recovered", { app: appId, delayMs });
    return delayMs;
  } catch (error) {
    log("warn", "claim_settle_failed", { app: appId, error: errorFacts(error) });
    return null;
  }
}

/**
 * Writes one auth event. A failure is logged, never thrown: a diagnostic never
 * fails sign-in. It runs after the answer is sent, so the wait for an
 * entitlement claim is measured here too: a refusal for a missing claim opens
 * the user's wait, and their next successful sign-in closes it and records
 * how long it was.
 */
export async function recordAuthEvent(input: AuthEventInput): Promise<void> {
  const id = timeOrderedId();
  const now = Date.now();
  let claimDelayMs: number | null = null;
  if (input.userId != null && input.event !== "challenge") {
    if (input.outcome === "issuer_claims_missing") await markClaimPending(input.env.DB, input.appId, input.userId, now);
    else if (input.outcome === "ok") claimDelayMs = await settleClaimPending(input.env.DB, input.appId, input.userId, now);
  }
  const attempts = input.outcome === "ok" ? SUCCESS_RECORD_ATTEMPTS : 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await database(input.env.DB)
        .insert(appAuthEvent)
        .values({
          id,
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
          claimDelayMs,
          createdAt: now,
        })
        .onConflictDoNothing({ target: appAuthEvent.id });
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
           (id, app_id, event, outcome, reason, app_version, client_sdk, network_asn, network_name, created_at)
         SELECT 'challenge:' || challenge, app_id, 'challenge', 'abandoned', 'challenge_unused',
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

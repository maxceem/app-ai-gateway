/**
 * Auth events: one `app_auth_event` row per sign-in attempt, successful or
 * refused, kept 90 days, so a developer can see why their app's users cannot
 * sign in.
 */
import { and, eq } from "drizzle-orm";
import { deletePass, type Pass } from "../core/chunked-delete.ts";
import { withDeadline } from "../core/background.ts";
import { errorFacts } from "../core/error-facts.ts";
import type { ErrorCode } from "../core/errors.ts";
import { timeOrderedId } from "../core/ids.ts";
import { log } from "../core/log.ts";
import type { AuthMethod } from "../core/types.ts";
import type { ClientNetwork } from "../core/client-network.ts";
import { storedAppVersion } from "../core/app-version.ts";
import { storedClientSdk } from "../core/client-sdk.ts";
import { database } from "../db/index.ts";
import { ledgerDb } from "../ledger/database.ts";
import { appAuthChallenge, type AuthEventName } from "../db/schema.ts";

export const AUTH_EVENT_RETENTION_DAYS = 90;

/** A claim wait older than this began before the events' retention: stale, never measured. */
const STALE_WAIT_MS = AUTH_EVENT_RETENTION_DAYS * 86_400_000;

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
  /**
   * The account that owned the app when the attempt read it, never looked up
   * again when the event is written. Null when the attempt never read the app:
   * such a row is never shown.
   */
  accountId: string | null;
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
function claimChange(input: AuthEventInput): "refused" | "succeeded" | null {
  // An attempt that never read its app has no account: its row is never read, so it moves no wait.
  if (input.userId == null || input.accountId === null || input.event === "challenge") return null;
  if (input.outcome === "issuer_claims_missing") return "refused";
  return input.outcome === "ok" ? "succeeded" : null;
}

/**
 * Records one attempt (plan, step 8f): the event goes to the account's ledger
 * object, and its change to the user's wait for an entitlement claim to D1,
 * kept on the user row (`app_end_user.claim_pending_since`), as v1 did.
 *
 * - A refusal for a missing claim opens a wait at the attempt's time, unless
 *   one is already open (the first refusal is the start), or the user signed
 *   in after this attempt began: sign-in sets `last_seen_at` before it
 *   answers, so a refusal whose write lands after a later success opens none.
 * - A successful sign-in records on its event how long the open wait had
 *   been open (`claim_delay_ms`, the attempt's time `now` minus the start),
 *   then closes it. A success with no wait open writes no user row.
 *
 * The steps run in order: read the wait from D1 (a success only), write the
 * event (its id is stable, so a retry writes it once), then change D1. An
 * attempt that never read its app has no account: its event would never be
 * shown, so it is not written.
 *
 * A wait that began before the events' retention (`AUTH_EVENT_RETENTION_DAYS`)
 * is stale: its user left and came back. A refusal starts a new wait in its
 * place, and a success measures nothing from it, only closes it (Gemini Neon
 * 7b-4). Otherwise a returning user would report a wait of months.
 *
 * This is a diagnostic, so rare gaps are accepted (owner, 2026-11-22 and
 * 2026-11-25): writes from attempts moments apart that land in reverse order
 * can miss a wait or close a newer one, a lost write leaves the wait as it was
 * until the user's next success, and an event the ledger cannot take is
 * logged and skipped. `account_id` is the account the attempt read the app
 * under (`accountId`).
 */
async function recordAttempt(input: AuthEventInput & { accountId: string }, id: string, now: number): Promise<number | null> {
  const db = input.env.DB;
  const change = claimChange(input);
  const userId = input.userId ?? null;
  let delayMs: number | null = null;
  if (change === "succeeded") {
    const wait = await db
      .prepare("SELECT claim_pending_since AS since FROM app_end_user WHERE app_id = ? AND id = ?")
      .bind(input.appId, userId)
      .first<{ since: number | null }>();
    const since = wait?.since ?? null;
    if (since !== null && since <= now && since >= now - STALE_WAIT_MS) delayMs = Math.max(0, now - since);
  }
  await writeEvent(input, id, now, delayMs);
  if (change === "succeeded") {
    // Only a user who is waiting: a success with no wait open writes no row (Fable 7b-4).
    await db
      .prepare(
        `UPDATE app_end_user SET claim_pending_since = NULL
          WHERE app_id = ?1 AND id = ?2 AND claim_pending_since IS NOT NULL AND claim_pending_since <= ?3`,
      )
      .bind(input.appId, userId, now)
      .run();
  } else if (change === "refused") {
    // A user first seen here gets a row, but only while the app is still there under
    // the attempt's account: a refusal landing after the app was deleted leaves no
    // row behind (Fable 7b-4). A blocked user's wait is never opened, as it could
    // never end.
    await db
      .prepare(
        `INSERT INTO app_end_user (app_id, id, created_at, claim_pending_since)
         SELECT ?1, ?2, ?4, ?4
          WHERE EXISTS (SELECT 1 FROM app WHERE id = ?1 AND account_id = ?3)
         ON CONFLICT (app_id, id) DO UPDATE SET claim_pending_since = excluded.claim_pending_since
          WHERE status = 'active' AND (claim_pending_since IS NULL OR claim_pending_since < excluded.claim_pending_since - ?5)
            AND (last_seen_at IS NULL OR last_seen_at < excluded.claim_pending_since)`,
      )
      .bind(input.appId, userId, input.accountId, now, STALE_WAIT_MS)
      .run();
  }
  return delayMs;
}

/**
 * How long the whole recording of one attempt may take: the D1 read of the
 * user's wait, every try at the event, and the D1 change. It runs after the
 * answer, inside the request's `waitUntil`, which ends about 30 s after it,
 * so this ends well before and its warning is always logged. Each ledger
 * call also has the ledger's own deadline (`ledgerDb`).
 */
export const AUTH_EVENT_JOB_DEADLINE_MS = 20_000;

/** The event itself, in the account's ledger, once: its id is stable. A success gets a few tries; a failure is logged and skipped. */
async function writeEvent(input: AuthEventInput & { accountId: string }, id: string, now: number, delayMs: number | null): Promise<void> {
  const ledger = ledgerDb(input.env, input.accountId);
  const attempts = input.outcome === "ok" ? SUCCESS_RECORD_ATTEMPTS : 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await ledger
        .prepare(
          `INSERT INTO app_auth_event
             (id, app_id, account_id, user_id, event, auth_method, outcome, reason, app_version, client_sdk,
              network_asn, network_name, latency_ms, claim_delay_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
        )
        .bind(
          id,
          input.appId,
          input.accountId,
          input.userId ?? null,
          input.event,
          input.authMethod ?? null,
          input.outcome,
          input.reason ?? null,
          storedAppVersion(input.appVersion),
          storedClientSdk(input.clientSdk),
          input.network?.asn ?? null,
          input.network?.name ?? null,
          input.latencyMs,
          delayMs,
          now,
        )
        .run();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, RECORD_RETRY_DELAY_MS * attempt));
    }
  }
  log("warn", "auth_event_record_failed", { id, appId: input.appId, event: input.event, outcome: input.outcome, error: errorFacts(lastError) });
}

/**
 * Writes one auth event, with the change it makes to its user's wait for an
 * entitlement claim (see `recordAttempt`). A failure is logged, never
 * thrown: a diagnostic never fails sign-in, and it runs after the answer is
 * sent. The attempt's time is taken when this is called, before any wait.
 */
export async function recordAuthEvent(input: AuthEventInput): Promise<void> {
  if (input.accountId === null) return;
  const id = timeOrderedId();
  const now = Date.now();
  try {
    const delayMs = await withDeadline(recordAttempt({ ...input, accountId: input.accountId }, id, now), AUTH_EVENT_JOB_DEADLINE_MS, "recording the auth event");
    if (delayMs !== null) log("info", "claim_propagation_recovered", { app: input.appId, delayMs });
  } catch (error) {
    log("warn", "auth_event_record_failed", { id, appId: input.appId, event: input.event, outcome: input.outcome, error: errorFacts(error) });
  }
}

/** Marks a challenge as used by a refused attempt, so its expiry is not also counted as abandoned. */
export async function markChallengeAttempted(env: Env, appId: string, challenge: string): Promise<void> {
  await database(env.DB)
    .update(appAuthChallenge)
    .set({ attempted: true })
    .where(and(eq(appAuthChallenge.challenge, challenge), eq(appAuthChallenge.appId, appId)));
}

/** Expired challenges one settlement handles: its reads and bindings stay small whatever the backlog. */
export const CHALLENGE_SETTLE_BATCH = 1000;

/** The SQL that picks one settlement's challenges, oldest first, through `app_auth_challenge_expiry`. */
export const EXPIRED_CHALLENGES_SQL = `SELECT challenge, app_id, (SELECT account_id FROM app WHERE app.id = app_auth_challenge.app_id) AS account_id,
    attempted, app_version, client_sdk, network_asn, network_name, expires_at
  FROM app_auth_challenge WHERE expires_at < ? ORDER BY expires_at LIMIT ?`;

/**
 * Records the oldest expired challenges nobody used as `abandoned` events,
 * then deletes those expired challenges, at most `batch` of them. The event
 * id comes from the challenge, so running this twice records each one once.
 *
 * The challenges are in D1 and the events in each account's ledger (D21), so
 * this is three steps (plan, step 8f): read the challenges with their app's
 * account, write each account's events, then delete the challenges. An event
 * write that fails is logged as a warning and the challenge is deleted all the
 * same: this is a diagnostic, and a rare gap is accepted (owner, 2026-11-25).
 * A challenge whose app is gone has no account: its event is skipped, as the
 * console never showed it. D1 sees two statements: the read and the delete.
 *
 * A challenge's version is copied only when `storedAppVersion` keeps it, the
 * same check every other writer uses: a challenge written before that check
 * existed may hold any text the caller sent (Sol 7b-4 round 3). The batch
 * bounds what is read and bound back to D1, so a large backlog never makes a
 * statement too big to send (Sol 7b-4 round 4); it is worked down by the
 * next runs: the hourly cron (`drainExpiredChallenges`), and one challenge in
 * a hundred.
 */
export async function settleExpiredChallenges(
  env: Env,
  db: D1Database,
  now: number = Date.now(),
  batch: number = CHALLENGE_SETTLE_BATCH,
): Promise<{ abandoned: number; deleted: number; selected: number }> {
  const { results } = await db
    .prepare(EXPIRED_CHALLENGES_SQL)
    .bind(now, batch)
    .all<ExpiredChallenge>();
  const rows = results ?? [];
  if (rows.length === 0) return { abandoned: 0, deleted: 0, selected: 0 };
  const byAccount = new Map<string, ExpiredChallenge[]>();
  for (const row of rows) {
    // Used by a refused attempt (already recorded), or its app is gone: no event.
    if (row.attempted !== 0 || row.account_id === null) continue;
    const list = byAccount.get(row.account_id) ?? [];
    list.push(row);
    byAccount.set(row.account_id, list);
  }
  let abandoned = 0;
  await Promise.all(
    [...byAccount].map(async ([accountId, challenges]) => {
      try {
        abandoned += await writeAbandonedChallenges(ledgerDb(env, accountId), challenges);
      } catch (error) {
        log("warn", "auth_event_record_failed", { event: "challenge", account: accountId, count: challenges.length, error: errorFacts(error) });
      }
    }),
  );
  // `expires_at < now` again: only ever an expired challenge, whatever happened since the read.
  const deleted = await db
    .prepare("DELETE FROM app_auth_challenge WHERE challenge IN (SELECT value FROM json_each(?1)) AND expires_at < ?2")
    .bind(JSON.stringify(rows.map((row) => row.challenge)), now)
    .run();
  return { abandoned, deleted: deleted.meta.changes ?? 0, selected: rows.length };
}

interface ExpiredChallenge {
  challenge: string;
  app_id: string;
  account_id: string | null;
  attempted: number;
  app_version: string | null;
  client_sdk: string | null;
  network_asn: number | null;
  network_name: string | null;
  expires_at: number;
}

/** One account's abandoned challenges, as events in its ledger. Returns how many were new. */
async function writeAbandonedChallenges(ledger: D1Database, challenges: readonly ExpiredChallenge[]): Promise<number> {
  const results = await ledger.batch(
    challenges.map((row) =>
      ledger
        .prepare(
          `INSERT INTO app_auth_event
             (id, app_id, account_id, event, outcome, reason, app_version, client_sdk, network_asn, network_name, created_at)
           VALUES (?, ?, ?, 'challenge', 'abandoned', 'challenge_unused', ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
        )
        .bind(
          `challenge:${row.challenge}`,
          row.app_id,
          row.account_id,
          row.app_version !== null && storedAppVersion(row.app_version) === row.app_version ? row.app_version : null,
          row.client_sdk,
          row.network_asn,
          row.network_name,
          row.expires_at - CHALLENGE_TTL_SECONDS * 1000,
        ),
    ),
  );
  return results.reduce((sum, result) => sum + (result.meta.changes > 0 ? 1 : 0), 0);
}

/**
 * Settles expired challenges a batch at a time while each batch comes back
 * full, at most `batches` of them, so a burst is cleared within the hour
 * rather than one batch an hour (Sol 7b-4 round 5). Each batch is two D1
 * statements. A batch is full when it *selected* `batch` challenges: another
 * clean-up running at the same time may have deleted some of them first, and
 * that must not end the drain early (Sol 7b-4 round 6). Logs
 * `auth_challenges_backlog_left` when the last batch was still full.
 */
export async function drainExpiredChallenges(
  env: Env,
  db: D1Database,
  batches: number,
  now: number = Date.now(),
  batch: number = CHALLENGE_SETTLE_BATCH,
): Promise<{ abandoned: number; deleted: number; batches: number }> {
  let abandoned = 0;
  let deleted = 0;
  let runs = 0;
  let full: boolean;
  do {
    const settled = await settleExpiredChallenges(env, db, now, batch);
    abandoned += settled.abandoned;
    deleted += settled.deleted;
    runs += 1;
    full = settled.selected >= batch;
  } while (full && runs < batches);
  if (full) log("warn", "auth_challenges_backlog_left", { batches: runs, batch });
  return { abandoned, deleted, batches: runs };
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

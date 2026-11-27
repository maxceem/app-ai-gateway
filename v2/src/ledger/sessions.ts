/**
 * Live sessions in the ledger: the session row, checkpoints, close, and
 * settlement with its barrier (plan sections 4.2 and 4.3; rules S6–S9, S12,
 * S14 in v2-prep/admission-and-settlement.md).
 *
 * - A checkpoint is one transaction in the account's ledger object (step 8f):
 *   it writes the slice charge, then reads the totals the stop decision needs, so a big
 *   turn counts at once. A repeated checkpoint id skips the insert but still
 *   reads the totals and answers, so a lost "stop" is not turned into
 *   "continue" by the retry (S14). If the transaction fails, the session
 *   continues unless a stop is already known from settings (a blocked user, a
 *   removed key): the relay keeps the slice in its journal and sends it again
 *   (S15). "Replaced" is not the ledger's: the end user's limiter decides it
 *   (crash table row 20).
 * - The settlement barrier (S6–S8): the relay sends slices in order, one
 *   unconfirmed at a time, so the final slice being written proves every
 *   earlier one is. A session settles only once its final slice (from
 *   `close`) is in. The wait is bounded: once the provider's session-level
 *   total exists, the session settles after `BARRIER_WAIT_MS` even with a
 *   slice missing. A slice that arrives after settlement costs $0 when a
 *   session-level dollar total already covers it, and its own cost otherwise.
 * - A session-level total subtracts every slice recorded, worked out and
 *   written in one transaction in the account's ledger object (S9), and is dated on the day the session ended
 *   (S12).
 */
import { withDeadline } from "../core/background.ts";
import { errorFacts } from "../core/error-facts.ts";
import { UNRESOLVED_FIRST_TRY_MS } from "../proxy/call-charge.ts";
import { log } from "../core/log.ts";
import type { NanoDollars } from "../money.ts";
import type { BudgetScope, SessionEndReason, SessionMode, SessionSlot } from "./labels.ts";
import { utcMonthDays } from "../limits/spend.ts";
import { bookingTooLate, logTooLate, sessionStartTakesBookings } from "./late-booking.ts";
import { insertChargeWithCostStatement, utcDay, type ChargeRow } from "./write.ts";
import { firstRowOf, sentOf, shapedLikeD1, type LedgerResult, type LedgerStatement } from "./database.ts";

/**
 * How long settlement waits for a missing slice once the provider's
 * session-level total is known. The relay retries an unconfirmed slice from
 * its journal for minutes; two minutes covers a retry after a short outage
 * without holding the customer's figures back for long.
 */
export const BARRIER_WAIT_MS = 2 * 60 * 1000;

/**
 * How long after a session's time cap a session that never closed is treated
 * as ended. A lost `close` holds the session until its cap (plan section 6);
 * this margin lets a late `close` still arrive first.
 */
export const STALE_SESSION_GRACE_MS = 5 * 60 * 1000;

/** How soon after `close` the sweep first tries to settle the session. */
export const SETTLE_FIRST_TRY_MS = 30 * 1000;

/** A session row, as the code builds it (see `session` in `src/db/schema.ts`). */
export interface SessionRow {
  readonly id: string;
  readonly accountId: string;
  readonly appId: string;
  readonly endUserId: string | null;
  readonly installId: string | null;
  readonly appleAccountId: string | null;
  readonly appKeyId: string | null;
  readonly providerType: string;
  readonly providerConnectionId: string | null;
  readonly operation: string;
  readonly model: string | null;
  readonly mode: SessionMode;
  readonly slot: SessionSlot;
  readonly timeCapMs: number;
  readonly startedAt: number;
  /** Whether the provider reports a session-level dollar total after the call. */
  readonly expectsSessionTotal: boolean;
}

/** The open-work row that settles a session: one per session, moved by `close`. */
export function sessionWorkId(sessionId: string): string {
  return `session:${sessionId}`;
}

/** The id of a session's one session-level correction. */
export function sessionSettlementId(sessionId: string): string {
  return `settle:session:${sessionId}`;
}

function insertSessionStatements(db: D1Database, session: SessionRow, now: number): D1PreparedStatement[] {
  return [
    // A session row that is not there is written only while a session that
    // started then could still take bookings (`./late-booking.ts`). Past that,
    // a missing row means retention deleted it with its slices, and a late
    // checkpoint or close must not bring it back: its slice would count twice.
    db
      .prepare(
        `INSERT INTO session (id, account_id, app_id, end_user_id, install_id, apple_account_id, app_key_id,
           provider_type, provider_connection_id, operation, model, mode, slot, state, time_cap_ms, started_at,
           expects_session_total, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ? WHERE ?
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(
        session.id,
        session.accountId,
        session.appId,
        session.endUserId,
        session.installId,
        session.appleAccountId,
        session.appKeyId,
        session.providerType,
        session.providerConnectionId,
        session.operation,
        session.model,
        session.mode,
        session.slot,
        session.timeCapMs,
        session.startedAt,
        session.expectsSessionTotal ? 1 : 0,
        now,
        now,
        sessionStartTakesBookings(session.startedAt, now) ? 1 : 0,
      ),
    // The sweep settles a session that never closes, once its cap has passed.
    // Never for a session that has ended: its work may be done and removed.
    // Never for a session whose row is not there (one too old to write again).
    db
      .prepare(
        `INSERT INTO open_work (id, kind, account_id, app_id, owner_type, owner_id, charge_id, detail_json, due_at, tries, created_at)
         SELECT ?, 'stale_session', ?, ?, 'session', ?, NULL, NULL, ?, 0, ?
         WHERE EXISTS (SELECT 1 FROM session WHERE id = ?7 AND state <> 'ended')
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(
        sessionWorkId(session.id),
        session.accountId,
        session.appId,
        session.id,
        session.startedAt + session.timeCapMs + STALE_SESSION_GRACE_MS,
        now,
        session.id,
      ),
  ];
}

/**
 * Writes a new session's row, and the open work that settles it if it never
 * closes. Written after the ticket reply; if it fails, the first checkpoint
 * writes both. Safe to repeat.
 */
export async function openSession(db: D1Database, session: SessionRow, now: number): Promise<void> {
  await db.batch(insertSessionStatements(db, session, now));
}

/** A dollar budget the checkpoint checks: a scope's month against its limit. */
export interface CheckpointBudget {
  readonly scope: BudgetScope;
  readonly scopeId: string;
  readonly limitNano: NanoDollars;
}

/** Plan minutes the checkpoint checks: the account's session time over the plan period. */
export interface CheckpointPlanMinutes {
  /** First day of the plan period, `YYYY-MM-DD`, inclusive. */
  readonly fromDay: string;
  /** First day after it, exclusive. */
  readonly toDay: string;
  readonly limitMs: number;
}

export type StopReason = "replaced" | "ended" | "budget_stop" | "allowance_used_up" | "user_blocked" | "key_removed";

/**
 * A checkpoint's two results, apart: whether its slice is written, and the
 * stop decision (plan 4.2, "one rule for the result"). An explicit stop ends
 * the session even when the write failed; with no stop, a failed write means
 * the session continues and the relay sends the slice again.
 */
export type CheckpointAnswer =
  | { readonly decision: "continue"; readonly written: boolean }
  | { readonly decision: "stop"; readonly reasons: readonly StopReason[]; readonly written: boolean };

/**
 * A slice priced inside the transaction: its charge id, and its charge row
 * at the session's price (`../relay/session-price.ts`): the one saved, or
 * today's, which the same transaction saves. Null when there is neither.
 */
export interface SliceAtSavedPrice {
  readonly id: string;
  readonly priceAt: (saved: string | null) => ChargeRow;
}

/** The checkpoint's two checks on settings, read before the ledger transaction: null when they could not be read. */
export interface CheckpointStanding {
  readonly userBlocked: boolean;
  readonly keyRemoved: boolean;
  /** The connection's own rates, read with its status, for pricing the slice. */
  readonly ratesJson?: string | null;
}

/** What one checkpoint writes (`writeCheckpoint`). */
export interface CheckpointWrite {
  readonly session: SessionRow;
  readonly slice: ChargeRow | null;
  /** The slice's input transcriptions, booked beside it, each at its own model's price (OpenAI, 9e). */
  readonly transcriptions?: readonly ChargeRow[];
  readonly budgets: readonly CheckpointBudget[];
  readonly planMinutes: CheckpointPlanMinutes | null;
  readonly now: number;
  /** The provider's id for the call, recorded on the session the first time (crash table row 13). */
  readonly providerCallId?: string | null;
  /** The settings checks, when the caller read them already; else they are read here. */
  readonly standing?: CheckpointStanding | null;
  /** How many crash gaps this slice carries: added to the session's count when the slice is really written. */
  readonly gaps?: number;
  /**
   * Today's price, saved form, saved on the session when none is yet (its
   * first checkpoint). Undefined when today's price couldn't be read: then
   * nothing is saved.
   */
  readonly price?: string;
}

/** What one checkpoint writes inside the ledger object (`writeCheckpointIn`): its slice priced there. */
export type LedgerCheckpointWrite = Omit<CheckpointWrite, "slice" | "standing"> & {
  readonly slice: SliceAtSavedPrice | null;
  readonly standing: CheckpointStanding | null;
};

/**
 * Writes one checkpoint slice and answers continue or stop (S14).
 *
 * `slice` is a charge of kind `slice` owned by the session, its `seq` the
 * slice number and `sessionMs` its connection time. It is null for an empty
 * checkpoint: the session row is still written and moved to `active`, and the
 * stop checks still run (crash table, "Checkpoints"). `budgets` and
 * `planMinutes` come from the app's limits and the account's plan, resolved by
 * the caller; the totals they are compared with are read in the same batch,
 * after the slice is written. The plan's request allowance is not here: it
 * lives in the account's limiter object, which the caller asks itself.
 *
 * The slice and the totals are one transaction in the account's ledger
 * object (`db`, step 8f). The end user's and the connection's status are
 * settings, read from D1 (`settings`) just before it. If that read fails,
 * only those two checks are skipped: the slice is still written, and the
 * ledger's own stop decisions still apply.
 *
 * A live session's checkpoint runs inside the ledger object instead
 * (`writeCheckpointIn`), which prices its slice there. This one, over D1's
 * shape, takes a slice already priced. Only tests call it: they check the
 * ledger's own rules through the same statements (`checkpointStatements`).
 */
export async function writeCheckpoint(db: D1Database, settings: D1Database, input: CheckpointWrite): Promise<CheckpointAnswer> {
  const standing = input.standing !== undefined ? input.standing : await checkpointStanding(settings, input.session);
  try {
    const plan = checkpointStatements(db, input, input.slice, false, input.transcriptions ?? []);
    const results = await db.batch(plan.statements);
    return checkpointAnswer(input, input.slice, results.map((result) => result.results[0] as Row), plan.stateAt, standing);
  } catch (error) {
    return failedCheckpoint(input, input.slice, standing, error);
  }
}

/**
 * `writeCheckpoint` inside the account's ledger object, run within one
 * synchronous SQLite transaction (`exec` runs statements in it). The price
 * read, the price save, the slice and the stop checks commit together, or
 * not at all. It throws when a statement fails: the caller answers with
 * `failedCheckpoint`.
 */
export function writeCheckpointIn(exec: (statements: readonly LedgerStatement[]) => LedgerResult[], input: LedgerCheckpointWrite): CheckpointAnswer {
  const run = (statements: readonly D1PreparedStatement[]) => exec(statements.map(sentOf)).map(firstRowOf);
  let slice: ChargeRow | null = null;
  let duplicate = false;
  if (input.slice !== null) {
    const [saved, booked] = run(priceReads(BUILDER, input.session.id, input.slice.id));
    ({ slice, duplicate } = sliceToBook(input.slice, input.price, saved, booked));
  }
  // The slice's transcriptions go with it: a repeated slice books none of them.
  const plan = checkpointStatements(BUILDER, input, slice, duplicate, slice === null ? [] : (input.transcriptions ?? []));
  return checkpointAnswer(input, slice, run(plan.statements), plan.stateAt, input.standing);
}

/** A checkpoint whose transaction failed: nothing written, and the stops settings already know (crash table row 16). */
export function failedCheckpoint(input: Pick<CheckpointWrite, "session">, slice: ChargeRow | null, standing: CheckpointStanding | null, error: unknown): CheckpointAnswer {
  const { session } = input;
  log("warn", "checkpoint_unchecked", { app: session.appId, session: session.id, slice: slice?.id ?? null, error: errorFacts(error) });
  const known = knownStops(standing);
  return known.length > 0 ? { decision: "stop", reasons: known, written: false } : { decision: "continue", written: false };
}

type Row = Record<string, unknown> | undefined;

/** Statements built here to be run elsewhere: inside the ledger object's own transaction. */
const BUILDER = shapedLikeD1(async () => {
  throw new Error("Built to be run inside the ledger object");
});

/** The session's saved price, and whether the slice is booked already. Reads only. */
function priceReads(db: D1Database, sessionId: string, sliceId: string): D1PreparedStatement[] {
  return [
    db.prepare("SELECT rates_json FROM session WHERE id = ?").bind(sessionId),
    db.prepare("SELECT EXISTS (SELECT 1 FROM charge WHERE id = ?) AS booked").bind(sliceId),
  ];
}

/**
 * The slice to book at the session's saved price, or none: a slice booked
 * already (a retry after a slow first commit) is acknowledged and changes
 * nothing (S1, S14). With no price saved yet, it is priced at today's, which
 * the same transaction saves.
 */
function sliceToBook(make: SliceAtSavedPrice, today: string | undefined, saved: Row, booked: Row): { slice: ChargeRow | null; duplicate: boolean } {
  if (booked?.booked === 1) return { slice: null, duplicate: true };
  return { slice: make.priceAt(typeof saved?.rates_json === "string" ? saved.rates_json : (today ?? null)), duplicate: false };
}

/** The stops settings already know: kept even when the ledger can't be written (crash table row 16). */
export function knownStops(standing: CheckpointStanding | null): StopReason[] {
  const known: StopReason[] = [];
  if (standing?.userBlocked === true) known.push("user_blocked");
  if (standing?.keyRemoved === true) known.push("key_removed");
  return known;
}

/**
 * One checkpoint's statements: the writes, then the stop checks' reads. A
 * duplicate slice writes nothing: only the stop checks run.
 */
function checkpointStatements(
  db: D1Database,
  input: Omit<CheckpointWrite, "slice" | "transcriptions">,
  slice: ChargeRow | null,
  duplicate: boolean,
  transcriptions: readonly ChargeRow[] = [],
): { statements: D1PreparedStatement[]; stateAt: number } {
  const { session, now } = input;
  const month = utcMonthDays(now);
  const statements: D1PreparedStatement[] = [];
  if (!duplicate) {
    statements.push(
      // The first checkpoint writes the session row if its own write failed.
      ...insertSessionStatements(db, session, now),
      db
        .prepare("UPDATE session SET state = 'active', updated_at = ? WHERE id = ? AND state = 'starting'")
        .bind(now, session.id),
    );
    if (input.price !== undefined) {
      statements.push(db.prepare("UPDATE session SET rates_json = ? WHERE id = ? AND rates_json IS NULL").bind(input.price, session.id));
    }
    if ((input.providerCallId ?? null) !== null) {
      statements.push(
        db
          .prepare("UPDATE session SET provider_call_id = ?, updated_at = ? WHERE id = ? AND provider_call_id IS NULL")
          .bind(input.providerCallId, now, session.id),
      );
    }
  }
  if (slice !== null) {
    // A slice after settlement is $0 when a session-level dollar total covers it (S8).
    // Written only under a session row. The slice's own day is judged by the insert
    // (`./late-booking.ts`), which logs a refusal: a slice inside the window cannot
    // have been deleted by retention, so its id still guards against a repeat.
    statements.push(
      insertChargeWithCostStatement(
        db,
        slice,
        now,
        "CASE WHEN (SELECT session_total_nano FROM session WHERE id = ? AND settlement = 'settled') IS NOT NULL THEN 0 ELSE ? END",
        [session.id, slice.costNano],
        { sql: "EXISTS (SELECT 1 FROM session WHERE id = ?)", params: [session.id] },
      ),
    );
    // Its crash gaps count on the session once, only when the insert just above really wrote it.
    if ((input.gaps ?? 0) > 0) {
      statements.push(
        db.prepare("UPDATE session SET gaps = gaps + ?, updated_at = ? WHERE id = ? AND changes() > 0").bind(input.gaps, now, session.id),
      );
    }
  }
  if (slice !== null && slice.priceSource === "unresolved" && (hasTokens(slice) || billableTime(slice))) {
    // An unpriced slice is queued for pricing in the same batch (S17), only
    // when the insert just above really wrote it: `changes()` is 0 for a
    // repeated checkpoint. A slice with neither tokens nor connection time to
    // bill (a gap alone) has nothing to price: the sweep would book it at $0
    // and undo its unknown cost.
    statements.push(unresolvedWork(db, session, slice, now));
  }
  for (const transcription of transcriptions) {
    // The slice's input transcriptions, each at its own model's price, written like the slice (OpenAI, 9e).
    statements.push(
      insertChargeWithCostStatement(
        db,
        transcription,
        now,
        "CASE WHEN (SELECT session_total_nano FROM session WHERE id = ? AND settlement = 'settled') IS NOT NULL THEN 0 ELSE ? END",
        [session.id, transcription.costNano],
        { sql: "EXISTS (SELECT 1 FROM session WHERE id = ?)", params: [session.id] },
      ),
    );
    if (transcription.priceSource === "unresolved" && (hasTokens(transcription) || billableTime(transcription))) {
      statements.push(unresolvedWork(db, session, transcription, now));
    }
  }
  const stateAt = statements.length;
  statements.push(db.prepare("SELECT state FROM session WHERE id = ?").bind(session.id));
  for (const budget of input.budgets) {
    statements.push(
      db
        .prepare(
          `SELECT COALESCE(SUM(cost_nano), 0) AS spent FROM budget_day
           WHERE app_id = ? AND scope = ? AND scope_id = ? AND day >= ? AND day < ?`,
        )
        .bind(session.appId, budget.scope, budget.scopeId, month.from, month.to),
    );
  }
  if (input.planMinutes !== null) {
    statements.push(
      db
        .prepare("SELECT COALESCE(SUM(session_ms), 0) AS ms FROM usage_day WHERE account_id = ? AND day >= ? AND day < ?")
        .bind(session.accountId, input.planMinutes.fromDay, input.planMinutes.toDay),
    );
  }
  return { statements, stateAt };
}

/**
 * An unpriced charge queued for pricing in the same batch (S17), only when the insert just before it really
 * wrote it: `changes()` is 0 for a repeated checkpoint.
 */
function unresolvedWork(db: D1Database, session: SessionRow, charge: ChargeRow, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO open_work (id, kind, account_id, app_id, owner_type, owner_id, charge_id, detail_json, due_at, tries, created_at)
       SELECT ?, 'unresolved', ?, ?, 'session', ?, ?, ?, ?, 0, ? WHERE changes() > 0
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(
      `unresolved:${charge.id}`,
      session.accountId,
      session.appId,
      session.id,
      charge.id,
      JSON.stringify({ providerType: charge.providerType, model: charge.model }),
      now + UNRESOLVED_FIRST_TRY_MS,
      now,
    );
}

/** Whether a slice holds units that may be billed (`sliceCharge` keeps them as usage): connection time, text messages, a transcription's audio. */
function billableTime(charge: ChargeRow): boolean {
  return ["units_session_seconds", "units_text_messages", "units_audio_seconds"].some((name) => {
    const count = charge.measures[name];
    return typeof count === "number" && count > 0;
  });
}

/** Whether a charge holds tokens to price. */
function hasTokens(charge: ChargeRow): boolean {
  return [charge.inputTokens, charge.cachedInputTokens, charge.cacheWriteTokens, charge.outputTokens].some((count) => (count ?? 0) > 0);
}

/** The answer, from each statement's first row. */
function checkpointAnswer(input: Omit<CheckpointWrite, "slice">, slice: ChargeRow | null, rows: Row[], stateAt: number, standing: CheckpointStanding | null): CheckpointAnswer {
  const { now } = input;
  let index = stateAt + 1;
  const reasons: StopReason[] = [];
  const state = rows[stateAt];
  if (state === undefined) {
    // No session row, and none written: a replay of a session too old for the
    // ledger (`./late-booking.ts`), long over. Nothing was booked; the relay is
    // told to stop, so it does not send the slice again. A slice dated too late
    // was logged by its insert already.
    if (slice !== null && !bookingTooLate(slice.usageDay, now)) logTooLate(slice);
    return { decision: "stop", reasons: ["ended"], written: true };
  }
  if (state.state === "ended") reasons.push("ended");
  for (const budget of input.budgets) {
    const spent = Number(rows[index]?.spent ?? 0);
    index += 1;
    if (spent >= budget.limitNano && !reasons.includes("budget_stop")) reasons.push("budget_stop");
  }
  if (input.planMinutes !== null) {
    const ms = Number(rows[index]?.ms ?? 0);
    index += 1;
    if (ms >= input.planMinutes.limitMs) reasons.push("allowance_used_up");
  }
  reasons.push(...knownStops(standing));
  return reasons.length === 0 ? { decision: "continue", written: true } : { decision: "stop", reasons, written: true };
}

/**
 * How long a checkpoint waits for its two settings from D1. Past it, both
 * checks are skipped, so a slow D1 never holds up the ledger transaction and
 * its stop decisions.
 */
export const CHECKPOINT_SETTINGS_DEADLINE_MS = 1_000;

/**
 * The checkpoint's two checks on settings in D1: the end user blocked, the
 * connection gone or disabled. Null when D1 cannot answer in time: both are
 * skipped.
 */
export async function checkpointStanding(settings: D1Database, session: SessionRow): Promise<CheckpointStanding | null> {
  const reads: D1PreparedStatement[] = [];
  if (session.endUserId !== null) {
    reads.push(settings.prepare("SELECT status FROM app_end_user WHERE app_id = ? AND id = ?").bind(session.appId, session.endUserId));
  }
  if (session.providerConnectionId !== null) {
    reads.push(settings.prepare("SELECT status, rates_json FROM provider_connection WHERE id = ?").bind(session.providerConnectionId));
  }
  if (reads.length === 0) return { userBlocked: false, keyRemoved: false, ratesJson: null };
  let results: D1Result[];
  try {
    results = await withDeadline(settings.batch(reads), CHECKPOINT_SETTINGS_DEADLINE_MS, "reading the checkpoint's settings");
  } catch (error) {
    log("warn", "checkpoint_settings_unchecked", { app: session.appId, session: session.id, error: errorFacts(error) });
    return null;
  }
  let index = 0;
  let userBlocked = false;
  let keyRemoved = false;
  let ratesJson: string | null = null;
  if (session.endUserId !== null) {
    userBlocked = (results[index]?.results[0] as { status?: unknown } | undefined)?.status === "blocked";
    index += 1;
  }
  if (session.providerConnectionId !== null) {
    const row = results[index]?.results[0] as { status?: unknown; rates_json?: unknown } | undefined;
    keyRemoved = row?.status === undefined || row.status === "disabled";
    ratesJson = typeof row?.rates_json === "string" ? row.rates_json : null;
  }
  return { userBlocked, keyRemoved, ratesJson };
}

/**
 * Records a session's end: its final slice number and why it ended (S6).
 * Safe to repeat: the first close wins, and closing an ended session changes
 * nothing. The sweep then settles it soon after.
 *
 * If the session row was never written (its write after the ticket reply
 * failed, and no checkpoint has written it yet), close writes it, ended, in
 * the same batch, from the ticket's data in `session`. A checkpoint that
 * arrives later finds it ended and keeps it so, so the end reason, end time
 * and final slice stay right and the barrier still waits for that slice.
 */
export async function closeSession(
  db: D1Database,
  input: {
    readonly session: SessionRow;
    readonly finalSlice: number;
    readonly endReason: SessionEndReason;
    readonly endedAt: number;
    readonly now: number;
    /** The provider's id for the call, when the relay knows it: a session that ended before its first checkpoint still settles with it (crash table row 13). */
    readonly providerCallId?: string | null;
  },
): Promise<void> {
  const sessionId = input.session.id;
  await db.batch([
    ...insertSessionStatements(db, input.session, input.now),
    db
      .prepare(
        `UPDATE session SET state = 'ended',
           end_reason = COALESCE(end_reason, ?),
           ended_at = COALESCE(ended_at, ?),
           final_slice = COALESCE(final_slice, ?),
           provider_call_id = COALESCE(provider_call_id, ?),
           updated_at = ?
         WHERE id = ? AND state != 'ended'`,
      )
      .bind(input.endReason, input.endedAt, input.finalSlice, input.providerCallId ?? null, input.now, sessionId),
    // Only the close that ended the session moves the next try earlier.
    // `changes()` is the rows the update just above changed, in this same
    // batch: 0 for a repeated close, which must not pull the sweep's last try
    // ahead of a provider total that is still on its way.
    db
      .prepare("UPDATE open_work SET due_at = MIN(due_at, ?) WHERE id = ? AND gave_up_at IS NULL AND changes() > 0")
      .bind(input.now + SETTLE_FIRST_TRY_MS, sessionWorkId(sessionId)),
  ]);
}

export type SessionSettlement =
  | "settled"
  | "already"
  | "missing"
  /** Not closed, and its time cap has not passed yet. */
  | "not_closed"
  /** Closed, but its final slice or its provider total is not in yet. */
  | "waiting"
  /** No provider total came in time: the slices' estimate stays, and the session is marked. */
  | "estimate_kept";

interface StoredSession {
  readonly id: string;
  readonly account_id: string;
  readonly app_id: string;
  readonly end_user_id: string | null;
  readonly install_id: string | null;
  readonly apple_account_id: string | null;
  readonly app_key_id: string | null;
  readonly provider_type: string;
  readonly provider_connection_id: string | null;
  readonly operation: string;
  readonly model: string | null;
  readonly state: string;
  readonly time_cap_ms: number;
  readonly started_at: number;
  readonly ended_at: number | null;
  readonly final_slice: number | null;
  readonly expects_session_total: number;
  readonly settlement: string;
  readonly session_total_nano: number | null;
  readonly mode: SessionMode;
  readonly slot: SessionSlot;
}

function sessionFromStored(stored: StoredSession): SessionRow {
  return {
    id: stored.id,
    accountId: stored.account_id,
    appId: stored.app_id,
    endUserId: stored.end_user_id,
    installId: stored.install_id,
    appleAccountId: stored.apple_account_id,
    appKeyId: stored.app_key_id,
    providerType: stored.provider_type,
    providerConnectionId: stored.provider_connection_id,
    operation: stored.operation,
    model: stored.model,
    mode: stored.mode,
    slot: stored.slot,
    timeCapMs: stored.time_cap_ms,
    startedAt: stored.started_at,
    expectsSessionTotal: Boolean(stored.expects_session_total),
  };
}

/**
 * Settles a session once the barrier allows it.
 *
 * - `providerTotal`: the provider's final session-level dollar total, for a
 *   session that has one. The correction subtracts every slice recorded, in
 *   one D1 batch (S9), dated on the day the session ended (S12).
 * - `lastTry`: the sweep's last try. A session still waiting for its
 *   provider total keeps the slices' estimate and is marked (S7).
 *
 * A session that never closed is ended here once its time cap and
 * `STALE_SESSION_GRACE_MS` have passed, with the slices recorded so far.
 */
export async function settleSession(
  db: D1Database,
  input: {
    readonly sessionId: string;
    readonly providerTotal?: NanoDollars;
    readonly lastTry?: boolean;
    readonly now: number;
  },
): Promise<SessionSettlement> {
  const { sessionId, now } = input;
  let stored = await db.prepare("SELECT * FROM session WHERE id = ?").bind(sessionId).first<StoredSession>();
  if (stored === null) return "missing";
  if (stored.settlement !== "open") return "already";

  // The first final total stored wins, and it is stored as soon as it
  // arrives, even before `close` is recorded: a later try (the sweep's, with
  // no total of its own) still applies it, and a later, different total
  // never replaces it.
  if (stored.expects_session_total && input.providerTotal !== undefined && stored.session_total_nano === null) {
    await db
      .prepare("UPDATE session SET session_total_nano = ?, updated_at = ? WHERE id = ? AND settlement = 'open' AND session_total_nano IS NULL")
      .bind(input.providerTotal, now, sessionId)
      .run();
    stored = await db.prepare("SELECT * FROM session WHERE id = ?").bind(sessionId).first<StoredSession>();
    if (stored === null) return "missing";
    if (stored.settlement !== "open") return "already";
  }

  const lastSlice = async () =>
    Number(
      (
        await db
          .prepare(
            "SELECT COALESCE(MAX(seq), 0) AS last FROM charge WHERE owner_type = 'session' AND owner_id = ? AND kind = 'slice'",
          )
          .bind(sessionId)
          .first<{ last: number }>()
      )?.last ?? 0,
    );

  if (stored.state !== "ended" || stored.final_slice === null || stored.ended_at === null) {
    const capEnds = stored.started_at + stored.time_cap_ms;
    if (now < capEnds + STALE_SESSION_GRACE_MS) return "not_closed";
    // A lost close: the session held its slot until the cap, and ends there.
    // A session still `starting` never connected (crash table rows 2, 4–6): it ends with `error`.
    const endReason = stored.state === "starting" ? "error" : "time_cap";
    await closeSession(db, { session: sessionFromStored(stored), finalSlice: await lastSlice(), endReason, endedAt: capEnds, now });
    stored = await db.prepare("SELECT * FROM session WHERE id = ?").bind(sessionId).first<StoredSession>();
    if (stored === null || stored.ended_at === null || stored.final_slice === null) return "missing";
  }

  const endedAt = stored.ended_at!;
  const barrierMet = (await lastSlice()) >= stored.final_slice!;
  const waited = now - endedAt >= BARRIER_WAIT_MS;
  // The stored provider total is never overwritten or cleared here: settling
  // only fills it when it is still empty.
  const markSettled = (settlement: "settled" | "estimate_kept") =>
    db
      .prepare(
        "UPDATE session SET settlement = ?, settled_at = ?, updated_at = ? WHERE id = ? AND settlement = 'open'" +
          // The estimate is kept only while no provider total is stored.
          (settlement === "estimate_kept" ? " AND session_total_nano IS NULL" : ""),
      )
      .bind(settlement, now, now, sessionId);

  if (!stored.expects_session_total) {
    // Slices priced from the provider's own usage events are final already.
    // A missing slice still adds its cost when it arrives (S8).
    if (!barrierMet && !waited && input.lastTry !== true) return "waiting";
    await markSettled("settled").run();
    return "settled";
  }

  const providerTotal = stored.session_total_nano === null ? undefined : (stored.session_total_nano as NanoDollars);

  if (providerTotal === undefined) {
    if (input.lastTry !== true) return "waiting";
    const kept = await markSettled("estimate_kept").run();
    if (kept.meta.changes === 0) {
      // A provider total was stored after this try read the row: apply it now.
      return settleSession(db, input);
    }
    log("warn", "session_estimate_kept", { app: stored.app_id, session: sessionId });
    return "estimate_kept";
  }
  // On the last try the bounded wait is over, whatever the clock says.
  if (!barrierMet && !waited && input.lastTry !== true) return "waiting";
  if (!barrierMet) log("warn", "session_settled_without_slice", { app: stored.app_id, session: sessionId });

  const correction: ChargeRow = {
    id: sessionSettlementId(sessionId),
    kind: "correction",
    accountId: stored.account_id,
    appId: stored.app_id,
    endUserId: stored.end_user_id,
    installId: stored.install_id,
    appleAccountId: stored.apple_account_id,
    appKeyId: stored.app_key_id,
    ownerType: "session",
    ownerId: sessionId,
    seq: null,
    providerType: stored.provider_type,
    providerConnectionId: stored.provider_connection_id,
    operation: stored.operation,
    preset: null,
    model: stored.model,
    status: "ok",
    httpStatus: null,
    errorCode: null,
    costNano: providerTotal,
    measured: "complete",
    priceSource: "provider_usd",
    priceIsEstimate: false,
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
    unit: null,
    units: null,
    measures: { session_total_nano: providerTotal },
    rates: null,
    sessionMs: null,
    correctionKind: "dollars",
    correctsChargeId: null,
    latencyMs: null,
    appVersion: null,
    authMethod: null,
    clientTraceId: null,
    // Dated on the day the session ended (S12).
    usedAt: endedAt,
    usageDay: utcDay(endedAt),
    writtenAt: now,
  };
  if (bookingTooLate(correction.usageDay, now)) {
    // Too late for the ledger (`./late-booking.ts`): the slices' estimate
    // stands, and the session says so, where the provider total stays stored.
    logTooLate(correction);
    await db
      .prepare("UPDATE session SET settlement = 'estimate_kept', settled_at = ?, updated_at = ? WHERE id = ? AND settlement = 'open'")
      .bind(now, now, sessionId)
      .run();
    return "estimate_kept";
  }
  // Worked out and written in one batch: the total minus every slice recorded
  // (S9). Both the correction and the state change need the session still
  // open, so a sweep that kept the estimate meanwhile wins, and neither happens.
  const [inserted] = await db.batch([
    insertChargeWithCostStatement(
      db,
      correction,
      now,
      // Every charge the session owns but this correction: its slices and any
      // pricing corrections of them.
      `(SELECT session_total_nano FROM session WHERE id = ?)
         - COALESCE((SELECT SUM(cost_nano) FROM charge WHERE owner_type = 'session' AND owner_id = ? AND id != ?), 0)`,
      [sessionId, sessionId, sessionSettlementId(sessionId)],
      { sql: "(SELECT settlement FROM session WHERE id = ?) = 'open'", params: [sessionId] },
    ),
    markSettled("settled"),
  ]);
  return (inserted?.meta.changes ?? 0) > 0 ? "settled" : "already";
}

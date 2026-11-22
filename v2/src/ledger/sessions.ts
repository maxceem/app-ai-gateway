/**
 * Live sessions in the ledger: the session row, checkpoints, close, and
 * settlement with its barrier (plan sections 4.2 and 4.3; rules S6–S9, S12,
 * S14 in v2-prep/admission-and-settlement.md).
 *
 * - A checkpoint is ONE D1 batch, which D1 runs as one transaction: it writes
 *   the slice charge, then reads the totals the stop decision needs, so a big
 *   turn counts at once. A repeated checkpoint id skips the insert but still
 *   reads the totals and answers, so a lost "stop" is not turned into
 *   "continue" by the retry (S14). If the batch fails, the session continues:
 *   the relay keeps the slice in its journal and sends it again (S15).
 * - The settlement barrier (S6–S8): the relay sends slices in order, one
 *   unconfirmed at a time, so the final slice being written proves every
 *   earlier one is. A session settles only once its final slice (from
 *   `close`) is in. The wait is bounded: once the provider's session-level
 *   total exists, the session settles after `BARRIER_WAIT_MS` even with a
 *   slice missing. A slice that arrives after settlement costs $0 when a
 *   session-level dollar total already covers it, and its own cost otherwise.
 * - A session-level total subtracts every slice recorded, worked out and
 *   written in one D1 batch (S9), and is dated on the day the session ended
 *   (S12).
 */
import { errorFacts } from "../core/error-facts.ts";
import { UNRESOLVED_FIRST_TRY_MS } from "../proxy/call-charge.ts";
import { log } from "../core/log.ts";
import type { NanoDollars } from "../money.ts";
import type { BudgetScope, SessionEndReason, SessionMode, SessionSlot } from "./labels.ts";
import { utcMonthDays } from "../limits/spend.ts";
import { bookingTooLate, logTooLate, sessionStartTakesBookings } from "./late-booking.ts";
import { insertChargeWithCostStatement, utcDay, type ChargeRow } from "./write.ts";

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

export type CheckpointAnswer =
  | { readonly decision: "continue"; readonly written: true }
  | { readonly decision: "stop"; readonly reasons: readonly StopReason[]; readonly written: true }
  /** The batch failed: the session continues, and the relay sends the slice again. */
  | { readonly decision: "continue"; readonly written: false };

/**
 * Writes one checkpoint slice and answers continue or stop (S14).
 *
 * `slice` is a charge of kind `slice` owned by the session, its `seq` the
 * slice number and `sessionMs` its connection time. `budgets` and
 * `planMinutes` come from the app's limits and the account's plan, resolved by
 * the caller; the totals they are compared with are read in the same batch,
 * after the slice is written. The plan's request allowance is not here: it
 * lives in the account's limiter object, which the caller asks itself.
 */
export async function writeCheckpoint(
  db: D1Database,
  input: {
    readonly session: SessionRow;
    readonly slice: ChargeRow;
    readonly budgets: readonly CheckpointBudget[];
    readonly planMinutes: CheckpointPlanMinutes | null;
    readonly now: number;
  },
): Promise<CheckpointAnswer> {
  const { session, slice, now } = input;
  const month = utcMonthDays(now);
  const statements: D1PreparedStatement[] = [
    // The first checkpoint writes the session row if its own write failed.
    ...insertSessionStatements(db, session, now),
    db
      .prepare("UPDATE session SET state = 'active', updated_at = ? WHERE id = ? AND state = 'starting'")
      .bind(now, session.id),
    // A slice after settlement is $0 when a session-level dollar total covers it (S8).
    // Written only under a session row that started inside the late-booking
    // window (`./late-booking.ts`); the slice's own day is judged by the insert.
    insertChargeWithCostStatement(
      db,
      slice,
      now,
      "CASE WHEN (SELECT session_total_nano FROM session WHERE id = ? AND settlement = 'settled') IS NOT NULL THEN 0 ELSE ? END",
      [session.id, slice.costNano],
      {
        sql: "EXISTS (SELECT 1 FROM session WHERE id = ?) AND ?",
        params: [session.id, sessionStartTakesBookings(session.startedAt, now) ? 1 : 0],
      },
    ),
  ];
  if (slice.priceSource === "unresolved") {
    // An unpriced slice is queued for pricing in the same batch (S17), only
    // when the insert just above really wrote it: `changes()` is 0 for a
    // repeated checkpoint.
    statements.push(
      db
        .prepare(
          `INSERT INTO open_work (id, kind, account_id, app_id, owner_type, owner_id, charge_id, detail_json, due_at, tries, created_at)
           SELECT ?, 'unresolved', ?, ?, 'session', ?, ?, ?, ?, 0, ? WHERE changes() > 0
           ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          `unresolved:${slice.id}`,
          session.accountId,
          session.appId,
          session.id,
          slice.id,
          JSON.stringify({ providerType: slice.providerType, model: slice.model }),
          now + UNRESOLVED_FIRST_TRY_MS,
          now,
        ),
    );
  }
  const stateAt = statements.length;
  statements.push(db.prepare("SELECT state, replaced_by FROM session WHERE id = ?").bind(session.id));
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
  const checksUser = session.endUserId !== null;
  if (checksUser) {
    statements.push(db.prepare("SELECT status FROM app_end_user WHERE app_id = ? AND id = ?").bind(session.appId, session.endUserId));
  }
  const checksKey = session.providerConnectionId !== null;
  if (checksKey) {
    statements.push(db.prepare("SELECT status FROM provider_connection WHERE id = ?").bind(session.providerConnectionId));
  }

  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    log("warn", "checkpoint_unchecked", { app: session.appId, session: session.id, slice: slice.id, error: errorFacts(error) });
    return { decision: "continue", written: false };
  }

  const first = (index: number) => results[index]?.results[0] as Record<string, unknown> | undefined;
  let index = stateAt + 1;
  const reasons: StopReason[] = [];
  const state = first(stateAt);
  if (state === undefined) {
    // No session row, and none written: a replay of a session too old for the
    // ledger (`./late-booking.ts`), long over. Nothing was booked; the relay is
    // told to stop, so it does not send the slice again. A slice dated too late
    // was logged by its insert already.
    if (!bookingTooLate(slice.usageDay, now)) logTooLate(slice);
    return { decision: "stop", reasons: ["ended"], written: true };
  }
  if (state?.replaced_by !== null && state?.replaced_by !== undefined) reasons.push("replaced");
  else if (state?.state === "ended") reasons.push("ended");
  for (const budget of input.budgets) {
    const spent = Number(first(index)?.spent ?? 0);
    index += 1;
    if (spent >= budget.limitNano && !reasons.includes("budget_stop")) reasons.push("budget_stop");
  }
  if (input.planMinutes !== null) {
    const ms = Number(first(index)?.ms ?? 0);
    index += 1;
    if (ms >= input.planMinutes.limitMs) reasons.push("allowance_used_up");
  }
  if (checksUser) {
    if (first(index)?.status === "blocked") reasons.push("user_blocked");
    index += 1;
  }
  if (checksKey) {
    const status = first(index)?.status;
    if (status === undefined || status === "disabled") reasons.push("key_removed");
    index += 1;
  }
  return reasons.length === 0 ? { decision: "continue", written: true } : { decision: "stop", reasons, written: true };
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
           updated_at = ?
         WHERE id = ? AND state != 'ended'`,
      )
      .bind(input.endReason, input.endedAt, input.finalSlice, input.now, sessionId),
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
    await closeSession(db, { session: sessionFromStored(stored), finalSlice: await lastSlice(), endReason: "time_cap", endedAt: capEnds, now });
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

/**
 * Live-session slots, kept in a limiter object (plan D15 and section 6;
 * `v2-prep/admission-and-settlement.md`). The end user's limiter keeps the
 * user's slots, and the app's limiter keeps the app's seats, both in this one
 * table shape.
 *
 * A slot is `reserved` once its ticket is issued, `active` once `open`
 * succeeds, and gone once it ends. The one exception is a slot the end user's
 * limiter ended as `replaced`: it is kept only to answer "replaced" until its
 * session's `close` or deadline, and never counts toward any limit (crash
 * table row 20).
 *
 * Nothing here waits on anything: each call reads and writes the table with
 * no `await` in between, so two calls on one object can never overshoot a
 * limit.
 */
import type { SessionSlot } from "../ledger/labels.ts";

/** What a slot is when it is taken. */
export interface SlotClaim {
  readonly sessionId: string;
  readonly kind: SessionSlot;
  /** The ticket's start: replacement picks the oldest by it, and the deadline counts from it. */
  readonly ticketStart: number;
  /** The ticket's expiry: a slot still `reserved` then frees itself (T7). */
  readonly expiresAt: number;
  /** The ticket's start plus its cap: a slot still held then frees itself (T9). */
  readonly deadline: number;
}

export type SlotState = "reserved" | "active" | "replaced";

export type SlotRow = {
  session_id: string;
  kind: SessionSlot;
  state: SlotState;
  ticket_start: number;
  expires_at: number;
  deadline: number;
  connected: number;
  takes_over: string | null;
};

/** Creates the table. Call from the object's constructor, inside `blockConcurrencyWhile`. */
export function createSlotTable(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS session_slot (
      session_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      ticket_start INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      deadline INTEGER NOT NULL,
      connected INTEGER NOT NULL DEFAULT 0,
      takes_over TEXT
    );
  `);
}

/**
 * Drops what has freed itself by `now`: a reservation whose ticket expired
 * (T7), and any slot, a retained `replaced` one too, past its deadline (T9).
 */
export function pruneSlots(sql: SqlStorage, now: number): void {
  sql.exec("DELETE FROM session_slot WHERE (state = 'reserved' AND expires_at <= ?) OR deadline <= ?", now, now);
}

/** The slots of one kind that count toward a limit: `reserved` and `active`, never a retained `replaced` one. */
export function heldSlots(sql: SqlStorage, kind: SessionSlot): number {
  const row = sql
    .exec<{ held: number }>("SELECT COUNT(*) AS held FROM session_slot WHERE kind = ? AND state IN ('reserved', 'active')", kind)
    .toArray()[0];
  return row?.held ?? 0;
}

export function slotRow(sql: SqlStorage, sessionId: string): SlotRow | null {
  return sql.exec<SlotRow>("SELECT * FROM session_slot WHERE session_id = ?", sessionId).toArray()[0] ?? null;
}

/** Takes a `reserved` slot. A slot already taken for this session is left as it is. */
export function reserveSlot(sql: SqlStorage, claim: SlotClaim, takesOver: string | null = null): void {
  sql.exec(
    `INSERT INTO session_slot (session_id, kind, state, ticket_start, expires_at, deadline, connected, takes_over)
     VALUES (?, ?, 'reserved', ?, ?, ?, 0, ?)
     ON CONFLICT(session_id) DO NOTHING`,
    claim.sessionId,
    claim.kind,
    claim.ticketStart,
    claim.expiresAt,
    claim.deadline,
    takesOver,
  );
}

/**
 * Moves a session's slot to `active` when `open` succeeds (T4). Safe to
 * repeat. A slot this object never wrote, because its reservation was lost
 * or skipped (T13), is taken now, so it still counts while the session runs.
 * A retained `replaced` slot stays as it is.
 */
export function activateSlot(sql: SqlStorage, claim: SlotClaim): void {
  sql.exec(
    `INSERT INTO session_slot (session_id, kind, state, ticket_start, expires_at, deadline, connected, takes_over)
     VALUES (?, ?, 'active', ?, ?, ?, 0, NULL)
     ON CONFLICT(session_id) DO UPDATE SET state = 'active' WHERE session_slot.state = 'reserved'`,
    claim.sessionId,
    claim.kind,
    claim.ticketStart,
    claim.expiresAt,
    claim.deadline,
  );
}

/** Frees a session's slot at its `close`, a retained `replaced` one too (T8). Safe to repeat. */
export function releaseSlot(sql: SqlStorage, sessionId: string): void {
  sql.exec("DELETE FROM session_slot WHERE session_id = ?", sessionId);
}

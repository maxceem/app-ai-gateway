/**
 * The end user's limiter object (plan section 4.2, admission step 1).
 *
 * One per end user: per install on an App Attest app
 * (`<app>:install:<key id>`), per `<app>:user:<user>` on a server app. It
 * holds the App Attest assertion counter of an install, and the end user's
 * request windows and monthly budget (shared with the app limiter, see
 * `./request-limits.ts`), and the user's live-session slots
 * (`./session-slots.ts`): this object alone decides when one session
 * replaces another (crash table row 20).
 *
 * Each assertion counter is accepted once. Requests are signed in one order
 * and can arrive in another, so a counter up to COUNTER_WINDOW behind the
 * highest one seen is still accepted once; one further behind never is.
 */
import type { SpendKey } from "../limits/spend.ts";
import { RequestLimitObject } from "./request-limits.ts";
import { heldSlots, pruneSlots, reserveSlot, slotRow, type SlotClaim, type SlotRow } from "./session-slots.ts";

/** Open conversational sessions per end user; a new one replaces the oldest (D15). */
export const USER_CONVERSATIONAL_LIMIT = 2;
/** Streaming sessions per end user; at the limit a new one is refused (D15). */
export const USER_STREAMING_LIMIT = 5;
/** Conversational slots one user may hold while new sessions start: a guard against abuse (T14). */
export const USER_STARTING_BOUND = 4;

/** What the session request asks of the end user's limiter. */
export interface UserSessionRequest extends SlotClaim {
  readonly now: number;
  /** The user's monthly budget in nano-dollars, or null for none. */
  readonly budgetNano: number | null;
  readonly spend: SpendKey | null;
  /** The session this one takes over, as the app named it. */
  readonly takesOver: string | null;
}

export type UserSessionAdmission =
  | {
      readonly admitted: true;
      /** The named session when it is an active conversational slot of this user; else null, and the request is an ordinary one (T11). */
      readonly takesOver: string | null;
      readonly budget: "checked" | "unread" | "none";
    }
  | { readonly admitted: false; readonly reason: "budget" | "streaming_limit" | "starting_bound" };

/** What a session's checkpoint asks: whether it now counts as connected. */
export interface SessionCheckpointInput {
  readonly sessionId: string;
  /** The session object's sticky proof of a real session (crash table row 20, rule 3). */
  readonly connected: boolean;
  readonly now: number;
}

export interface SessionCheckpointAnswer {
  readonly decision: "continue" | "replaced";
  /** The sessions this call ended as replaced, for the log. */
  readonly replaced: readonly string[];
}

export const COUNTER_WINDOW = 64;

const MASK_64 = (1n << 64n) - 1n;

export class EndUserLimiter extends RequestLimitObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      // The highest counter used, and which of the COUNTER_WINDOW below it
      // have been, as a 64-bit mask in sixteen hex digits (bit n is
      // counter_high - n). Absent until the first assertion, which is
      // accepted whatever its counter.
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS assertion_counter (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          counter_high INTEGER NOT NULL,
          counter_seen TEXT NOT NULL
        );
      `);
    });
  }

  /**
   * Admits a live session for this user: the user's budget, then a slot (T1,
   * T2, T3, T14). Opening a session uses no request (D8). A conversational
   * session at the per-user limit is admitted; it replaces the oldest only
   * once it counts as connected (`sessionCheckpoint`).
   */
  async admitSession(input: UserSessionRequest): Promise<UserSessionAdmission> {
    const now = Number.isFinite(input.now) ? input.now : Date.now();
    const budget = await this.budgetSpent(input.budgetNano, input.spend, now);
    if (budget === "spent") return { admitted: false, reason: "budget" };
    // No `await` from here to the write: two requests can never both take the last slot.
    const sql = this.ctx.storage.sql;
    pruneSlots(sql, now);
    if (input.kind === "streaming" && heldSlots(sql, "streaming") >= USER_STREAMING_LIMIT) {
      return { admitted: false, reason: "streaming_limit" };
    }
    if (input.kind === "conversational" && heldSlots(sql, "conversational") >= USER_STARTING_BOUND) {
      return { admitted: false, reason: "starting_bound" };
    }
    // A name counts only when it is this user's own active conversational
    // slot; otherwise the request is an ordinary one (T11).
    let takesOver: string | null = null;
    if (input.kind === "conversational" && input.takesOver !== null && input.takesOver !== input.sessionId) {
      const target = slotRow(sql, input.takesOver);
      if (target !== null && target.state === "active" && target.kind === "conversational") takesOver = target.session_id;
    }
    reserveSlot(sql, input, takesOver);
    return { admitted: true, takesOver, budget };
  }

  /**
   * The replacement decision, at a session's live checkpoint (crash table row
   * 20). The caller runs the ledger side first and calls this only when the
   * ledger gave no explicit stop; a streaming session, an accounting-only
   * delivery and a session with no end user never call it.
   *
   * The decision is made once, when a slot is first marked connected: end a
   * named takeover target still `active`, connected or not; then, while the
   * user's connected conversational slots are over the limit, end the oldest
   * by ticket time. Every later call only answers. Repeating a call changes
   * nothing.
   */
  sessionCheckpoint(input: SessionCheckpointInput): SessionCheckpointAnswer {
    const sql = this.ctx.storage.sql;
    pruneSlots(sql, Number.isFinite(input.now) ? input.now : Date.now());
    const slot = slotRow(sql, input.sessionId);
    if (slot === null || slot.state === "reserved" || slot.kind !== "conversational") return { decision: "continue", replaced: [] };
    if (slot.state === "replaced") return { decision: "replaced", replaced: [] };
    if (slot.connected === 1 || !input.connected) return { decision: "continue", replaced: [] };
    sql.exec("UPDATE session_slot SET connected = 1 WHERE session_id = ?", slot.session_id);
    const replaced: string[] = [];
    if (slot.takes_over !== null) {
      const target = slotRow(sql, slot.takes_over);
      if (target !== null && target.state === "active" && target.kind === "conversational") {
        endAsReplaced(sql, target.session_id);
        replaced.push(target.session_id);
      }
    }
    const connected = sql
      .exec<SlotRow>(
        `SELECT * FROM session_slot WHERE kind = 'conversational' AND state = 'active' AND connected = 1
         ORDER BY ticket_start, session_id`,
      )
      .toArray();
    for (const oldest of connected.slice(0, Math.max(0, connected.length - USER_CONVERSATIONAL_LIMIT))) {
      endAsReplaced(sql, oldest.session_id);
      replaced.push(oldest.session_id);
    }
    return { decision: replaced.includes(slot.session_id) ? "replaced" : "continue", replaced };
  }

  /** Accepts one assertion counter, or refuses it as a replay. */
  useCounter(counter: number): { accepted: boolean } {
    return { accepted: this.accept(counter) };
  }

  /** No `await` between the read and the write, so two requests with one counter cannot both pass. */
  private accept(counter: number): boolean {
    if (!Number.isSafeInteger(counter) || counter < 0) return false;
    const stored = this.ctx.storage.sql
      .exec<{ counter_high: number; counter_seen: string }>(
        "SELECT counter_high, counter_seen FROM assertion_counter WHERE singleton = 1",
      )
      .toArray()[0];
    let high: number;
    let seen: bigint;
    if (stored === undefined) {
      high = counter;
      seen = 1n;
    } else if (counter > stored.counter_high) {
      const shift = counter - stored.counter_high;
      seen = shift >= COUNTER_WINDOW ? 1n : ((BigInt(`0x${stored.counter_seen}`) << BigInt(shift)) & MASK_64) | 1n;
      high = counter;
    } else {
      const behind = stored.counter_high - counter;
      if (behind >= COUNTER_WINDOW) return false;
      const bit = 1n << BigInt(behind);
      const mask = BigInt(`0x${stored.counter_seen}`);
      if ((mask & bit) !== 0n) return false;
      high = stored.counter_high;
      seen = mask | bit;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO assertion_counter(singleton, counter_high, counter_seen) VALUES (1, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         counter_high = excluded.counter_high,
         counter_seen = excluded.counter_seen`,
      high,
      seen.toString(16).padStart(16, "0"),
    );
    return true;
  }
}

/** Ends a slot as `replaced`: kept only to answer so, until its `close` or deadline, and never counted. */
function endAsReplaced(sql: SqlStorage, sessionId: string): void {
  sql.exec("UPDATE session_slot SET state = 'replaced' WHERE session_id = ?", sessionId);
}


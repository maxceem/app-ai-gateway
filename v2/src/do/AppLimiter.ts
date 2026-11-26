/**
 * The app's limiter object (plan section 4.2, admission step 2): one per app,
 * holding the limits the customer set on the app as a whole, requests per
 * minute and per day and a monthly dollar budget (`./request-limits.ts`),
 * and the app's live-session seats (`./session-slots.ts`): at most so many
 * conversational and streaming sessions at once (D15). At a full app a new
 * session is refused, a named takeover too (owner, 2026-11-26).
 */
import type { SpendKey } from "../limits/spend.ts";
import { RequestLimitObject } from "./request-limits.ts";
import { activateSlot, heldSlots, pruneSlots, releaseSlot, reserveSlot, type SlotClaim } from "./session-slots.ts";

/** What the session request asks of the app's limiter. */
export interface AppSessionRequest extends SlotClaim {
  readonly now: number;
  /** The app's monthly budget in nano-dollars, or null for none. */
  readonly budgetNano: number | null;
  readonly spend: SpendKey | null;
  /** How many sessions of this kind the app may have at once. */
  readonly cap: number;
}

export type AppSessionAdmission =
  | { readonly admitted: true; readonly budget: "checked" | "unread" | "none" }
  | { readonly admitted: false; readonly reason: "budget" | "session_limit"; readonly cap?: number };

export class AppLimiter extends RequestLimitObject {
  /** Admits a live session for the app: its budget, then a seat (T1, T3). Uses no request (D8). */
  async admitSession(input: AppSessionRequest): Promise<AppSessionAdmission> {
    const now = Number.isFinite(input.now) ? input.now : Date.now();
    const budget = await this.budgetSpent(input.budgetNano, input.spend, now);
    if (budget === "spent") return { admitted: false, reason: "budget" };
    // No `await` from here to the write: two requests can never both take the last seat.
    const sql = this.ctx.storage.sql;
    pruneSlots(sql, now);
    if (heldSlots(sql, input.kind) >= input.cap) return { admitted: false, reason: "session_limit", cap: input.cap };
    reserveSlot(sql, input);
    return { admitted: true, budget };
  }

  /** `open` succeeded: the session's seat is `active` (T4). Safe to repeat. */
  activateSession(claim: SlotClaim, now: number): void {
    const sql = this.ctx.storage.sql;
    pruneSlots(sql, Number.isFinite(now) ? now : Date.now());
    activateSlot(sql, claim);
  }

  /** The session closed, or its start was refused further on: its seat is freed (T8). Safe to repeat. */
  releaseSession(sessionId: string): void {
    releaseSlot(this.ctx.storage.sql, sessionId);
  }
}

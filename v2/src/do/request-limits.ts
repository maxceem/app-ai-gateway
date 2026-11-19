/**
 * What the app limiter and the end user's limiter share: request windows
 * (per minute and per UTC day) counted at admission, and a dollar budget read
 * from the D1 rollups (v1's `UserLimiter`, ported).
 *
 * The budget total is cached in the object and refreshed in the background
 * every `SPEND_REFRESH_MS` while the object is in use (plan section 4.2): a
 * request uses the cached figure and, if it is older than that, starts one
 * refresh for the next request. Only a cold object waits for its first read.
 * A read that fails leaves the budget unchecked; the request is served.
 *
 * These are the limits a customer sets on its own app (`app_*`). They never
 * read, and are never read by, the plan allowance (`billing_*`).
 */
import { DurableObject } from "cloudflare:workers";
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";
import { monthlySpendNano, utcMonthDays, type SpendKey } from "../limits/spend.ts";

/** How often a budget total in use is read again from the rollups. */
export const SPEND_REFRESH_MS = 10_000;

/** How many budget totals one object keeps; it is asked for one or two. */
const MAX_SPEND_LEDGERS = 8;

export interface RequestLimitCheck {
  now: number;
  /** Requests per minute, or null for none. */
  rpm: number | null;
  /** Requests per UTC day, or null for none. */
  rpd: number | null;
  /** The monthly budget in nano-dollars, or null for none. */
  budgetNano: number | null;
  /** Whose month the budget is measured over. Needed when `budgetNano` is set. */
  spend: SpendKey | null;
}

export type RequestLimitResult =
  | {
      allowed: true;
      /** `unread`: the budget total could not be read, so the budget was not checked. */
      budget: "checked" | "unread" | "none";
    }
  | { allowed: false; reason: "rate" | "budget"; retryAfterSeconds?: number };

export class RequestLimitObject extends DurableObject<Env> {
  /** The last read of each budget total, by app, scope, key and month. Memory only. */
  private spend = new Map<string, { nano: number; readAt: number }>();
  /** Reads in flight, shared by every request that finds that total cold or old. */
  private spendReads = new Map<string, Promise<number>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        -- Both windows in one row, so an admitted request writes once. A
        -- window that has rolled is overwritten in place, so nothing needs
        -- pruning. Fixed windows can admit twice the limit across a boundary,
        -- which is accepted at these sizes.
        CREATE TABLE IF NOT EXISTS request_windows (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          minute_key TEXT NOT NULL,
          minute_count INTEGER NOT NULL,
          day_key TEXT NOT NULL,
          day_count INTEGER NOT NULL
        );
      `);
    });
  }

  /**
   * Claims one request against these limits, or refuses it. The decision and
   * the count happen with no `await` between them, so concurrent requests can
   * never overshoot a window. Both windows are counted only once both, and the
   * budget, have room.
   */
  async checkRequest(input: RequestLimitCheck): Promise<RequestLimitResult> {
    const now = Number.isFinite(input.now) ? input.now : Date.now();
    let budget: "checked" | "unread" | "none" = "none";
    let spent = 0;
    if (input.budgetNano !== null && input.spend !== null) {
      const total = await this.budgetTotal(input.spend, now);
      if (total === null) budget = "unread";
      else {
        budget = "checked";
        spent = total;
      }
    }
    const windows = this.windowCounts(now);
    if (input.rpm !== null && windows.minute >= input.rpm) {
      const nextMinute = (Math.floor(now / 60_000) + 1) * 60_000;
      return { allowed: false, reason: "rate", retryAfterSeconds: Math.max(1, Math.ceil((nextMinute - now) / 1000)) };
    }
    if (input.rpd !== null && windows.day >= input.rpd) {
      const date = new Date(now);
      const nextDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) + 86_400_000;
      return { allowed: false, reason: "rate", retryAfterSeconds: Math.max(1, Math.ceil((nextDay - now) / 1000)) };
    }
    if (budget === "checked" && input.budgetNano !== null && spent >= input.budgetNano) {
      return { allowed: false, reason: "budget" };
    }
    this.bumpWindows(windows.minuteKey, windows.minute + 1, windows.dayKey, windows.day + 1);
    return { allowed: true, budget };
  }

  /** Requests counted today, for `/me`. */
  requestsToday(now: number): number {
    return this.windowCounts(Number.isFinite(now) ? now : Date.now()).day;
  }

  /**
   * The counts standing at `now`, a rolled window reading as zero. A window
   * never moves backwards: a request whose clock trails the stored window is
   * counted into the newer one rather than resetting it.
   */
  private windowCounts(now: number): { minuteKey: string; minute: number; dayKey: string; day: number } {
    const stored = this.ctx.storage.sql
      .exec<{ minute_key: string; minute_count: number; day_key: string; day_count: number }>(
        "SELECT minute_key, minute_count, day_key, day_count FROM request_windows WHERE singleton = 1",
      )
      .toArray()[0];
    let minuteKey = String(Math.floor(now / 60_000));
    let dayKey = new Date(now).toISOString().slice(0, 10);
    if (stored && Number(stored.minute_key) > Number(minuteKey)) minuteKey = stored.minute_key;
    if (stored && stored.day_key > dayKey) dayKey = stored.day_key;
    return {
      minuteKey,
      minute: stored?.minute_key === minuteKey ? stored.minute_count : 0,
      dayKey,
      day: stored?.day_key === dayKey ? stored.day_count : 0,
    };
  }

  private bumpWindows(minuteKey: string, minute: number, dayKey: string, day: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO request_windows(singleton, minute_key, minute_count, day_key, day_count)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         minute_key = excluded.minute_key, minute_count = excluded.minute_count,
         day_key = excluded.day_key, day_count = excluded.day_count`,
      minuteKey,
      minute,
      dayKey,
      day,
    );
  }

  /**
   * The budget total: the cached figure when there is one, refreshed in the
   * background once it is older than `SPEND_REFRESH_MS`; read and awaited only
   * when this object has none yet. Null when that first read fails.
   */
  private async budgetTotal(key: SpendKey, now: number): Promise<number | null> {
    const identity = JSON.stringify([key.appId, key.scope, key.key, utcMonthDays(now).from]);
    const cached = this.spend.get(identity);
    if (cached !== undefined) {
      if (now - cached.readAt >= SPEND_REFRESH_MS) void this.readSpend(identity, key, now).catch(() => undefined);
      return cached.nano;
    }
    try {
      return await this.readSpend(identity, key, now);
    } catch {
      return null;
    }
  }

  /** One read of a budget total, shared by concurrent callers. A failed read is logged and forgotten. */
  private readSpend(identity: string, key: SpendKey, now: number): Promise<number> {
    const pending = this.spendReads.get(identity);
    if (pending !== undefined) return pending;
    const read = monthlySpendNano(this.env.DB, key, now)
      .then((nano) => {
        const current = this.spend.get(identity);
        // A slower read never replaces a newer figure.
        if (current === undefined || current.readAt <= now) {
          if (current === undefined && this.spend.size >= MAX_SPEND_LEDGERS) this.spend.clear();
          this.spend.set(identity, { nano, readAt: now });
        }
        return nano;
      })
      .catch((error: unknown) => {
        log("warn", "budget_total_unread", { app: key.appId, scope: key.scope, error: errorFacts(error) });
        throw error;
      })
      .finally(() => {
        if (this.spendReads.get(identity) === read) this.spendReads.delete(identity);
      });
    this.spendReads.set(identity, read);
    return read;
  }
}

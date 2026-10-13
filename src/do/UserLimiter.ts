import { DurableObject } from "cloudflare:workers";
import { monthlySpendMicrousd, type SpendKey } from "../usage/app-usage-accounting";

/**
 * Request windows for the app's own limits, counted consistently per scope,
 * and the App Attest assertion counter of an install.
 *
 * One instance per install of an App Attest application
 * (`app:install:<key id>`), one per `app:user` pair of a server application,
 * and one more per app id, which is why nothing here is named for a user. An
 * install's object is called on every request, limits or not, because it owns
 * the install's counter: each assertion's counter is accepted once, and a
 * replayed one is refused before anything is counted. The month's spend is D1's — one row the
 * usage triggers keep current — and is read from there and cached for
 * {@link SPEND_REFRESH_MS}, so a budget settles within that window of the
 * request that spent it.
 *
 * The quota it enforces is the organization's own, set on its app and applied
 * to that app's end users. It is not the plan allowance: that is organization
 * wide, comes from billing, and lives in {@link import("./OrgQuota").OrgQuota}.
 * Neither reads the other.
 */

/**
 * How long a read of the month's spend answers for. Spend settles only once a
 * response has finished, so enforcement already trails a request by its own
 * length; a few seconds more is what turns a D1 read per request into one per
 * window per scope.
 */
export const SPEND_REFRESH_MS = 10_000;

/** How many ledgers' figures one object keeps; it is asked for one or two. */
const MAX_SPEND_LEDGERS = 8;

/** A window's key: the epoch minute, or the UTC date as `YYYY-MM-DD`. */
type WindowKind = "minute" | "day";

/**
 * How far behind the highest counter an install has used an assertion may
 * still arrive. Requests are signed on the device in one order and can reach
 * the gateway in another; a counter inside the window is accepted once, a
 * counter behind it never.
 */
export const COUNTER_WINDOW = 64;

const MASK_64 = (1n << 64n) - 1n;

export interface LimiterCheckInput {
  now: number;
  /**
   * The counter of the App Attest assertion the request was signed with, on
   * an install's object. Judged before anything else, and a replay counts
   * nothing.
   */
  assertionCounter?: number;
  rpm: number | null;
  rpd: number | null;
  monthlyBudgetMicrousd: number | null;
  /** Whose month the budget is measured against. */
  spend: SpendKey;
}

export type LimiterCheckResult =
  | { allowed: true }
  | { allowed: false; reason: "rate" | "budget" | "replay"; retryAfterSeconds?: number };

export interface LimiterStatus {
  requestsToday: number;
}

export class UserLimiter extends DurableObject<Env> {
  /**
   * The last read of each ledger's month, by its full identity — app, scope,
   * key and month. One object can be asked for more than one: an install's is
   * asked for the install's month or the user's as the app's budget scope
   * changes, and a figure read for one must never answer for the other.
   * Memory only: an evicted object reads again.
   */
  private spend = new Map<string, { microusd: number; readAt: number }>();
  /** The reads in flight, by ledger identity, each shared by every request that finds that ledger stale meanwhile. */
  private spendReads = new Map<string, Promise<number>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        -- Both counters in one row, so an admitted request writes once instead
        -- of once per window. A window that has rolled is overwritten in place
        -- rather than appended to, so there is nothing here to prune. Fixed
        -- windows admit a 2x burst across a boundary, which is an acceptable
        -- trade for abuse control at these magnitudes.
        CREATE TABLE IF NOT EXISTS request_windows (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          minute_key TEXT NOT NULL,
          minute_count INTEGER NOT NULL,
          day_key TEXT NOT NULL,
          day_count INTEGER NOT NULL
        );
        -- An install's assertion counters: the highest one used, and which of
        -- the COUNTER_WINDOW below it have been, as a 64-bit mask in sixteen
        -- hex digits (bit n is counter_high - n). Absent until the first
        -- assertion, which is accepted whatever its counter.
        CREATE TABLE IF NOT EXISTS assertion_counter (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          counter_high INTEGER NOT NULL,
          counter_seen TEXT NOT NULL
        );
      `);
    });
  }

  private month(now: number): string {
    return new Date(now).toISOString().slice(0, 7);
  }

  private startOfUtcDay(now: number): number {
    const date = new Date(now);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  }

  private windowKey(kind: WindowKind, now: number): string {
    return kind === "minute"
      ? String(Math.floor(now / 60_000))
      : new Date(now).toISOString().slice(0, 10);
  }

  /**
   * The counts standing in both windows at `now`, each read as zero when the
   * stored row belongs to a window that has since rolled. Reading a stale
   * counter as zero is what makes a rollover free: nothing has to be deleted,
   * only overwritten on the next admission.
   *
   * A window never moves backwards. A request whose clock trails the stored
   * window — one that awaited its spend read while a later request was counted,
   * or one from an isolate a moment behind — is counted into that newer window
   * rather than resetting it to its own, which would hand the newer window's
   * callers a fresh allowance.
   *
   * One row holds both, so this is a single read whichever window the caller
   * ends up deciding on.
   */
  private windowCounts(now: number): { minuteKey: string; minute: number; dayKey: string; day: number } {
    const stored = this.ctx.storage.sql
      .exec<{ minute_key: string; minute_count: number; day_key: string; day_count: number }>(
        "SELECT minute_key, minute_count, day_key, day_count FROM request_windows WHERE singleton = 1",
      )
      .toArray()[0];
    let minuteKey = this.windowKey("minute", now);
    let dayKey = this.windowKey("day", now);
    if (stored && Number(stored.minute_key) > Number(minuteKey)) minuteKey = stored.minute_key;
    // `YYYY-MM-DD` compares in date order as text.
    if (stored && stored.day_key > dayKey) dayKey = stored.day_key;
    return {
      minuteKey,
      minute: stored?.minute_key === minuteKey ? stored.minute_count : 0,
      dayKey,
      day: stored?.day_key === dayKey ? stored.day_count : 0,
    };
  }

  /**
   * Claims one request against this scope's limits, or refuses it: a replayed
   * assertion counter first, then the request windows, then the budget.
   *
   * Everything that decides and counts runs without an `await` between the
   * read and the write, so no concurrent caller can interleave and a window can
   * never be overshot. The counter is accepted and recorded in one synchronous
   * step before anything else. The one `await` — reading the month's spend
   * when the cached figure has aged — comes next, and only fills the cache: it
   * decides nothing a concurrent caller could invalidate.
   *
   * Both windows are incremented only once both have passed and the budget
   * has room, so a request the day limit or the budget refuses does not
   * silently spend a minute token. A counter, once seen, stays spent.
   */
  async checkAndIncrement(input: LimiterCheckInput): Promise<LimiterCheckResult> {
    // A caller-supplied clock decides which window a request lands in; a
    // nonsensical one falls back to real time rather than to window "NaN".
    const now = Number.isFinite(input.now) ? input.now : Date.now();
    // First and synchronously: the counter is accepted and recorded in one
    // step, so two requests carrying the same assertion cannot both pass, and
    // a replay is refused before it can spend anything.
    if (input.assertionCounter !== undefined && !this.useCounter(input.assertionCounter)) {
      return { allowed: false, reason: "replay" };
    }
    // Only fills the cache, so nothing decided after it can be invalidated by
    // a concurrent caller meanwhile.
    const spent = input.monthlyBudgetMicrousd === null ? 0 : await this.monthlySpend(input.spend, now);

    const windows = this.windowCounts(now);
    const minuteCount = windows.minute;
    const dayCount = windows.day;

    if (input.rpm !== null && minuteCount >= input.rpm) {
      const nextMinute = (Math.floor(now / 60_000) + 1) * 60_000;
      return {
        allowed: false,
        reason: "rate",
        retryAfterSeconds: Math.max(1, Math.ceil((nextMinute - now) / 1000)),
      };
    }
    if (input.rpd !== null && dayCount >= input.rpd) {
      const nextDay = this.startOfUtcDay(now) + 86_400_000;
      return {
        allowed: false,
        reason: "rate",
        retryAfterSeconds: Math.max(1, Math.ceil((nextDay - now) / 1000)),
      };
    }
    if (input.monthlyBudgetMicrousd !== null && spent >= input.monthlyBudgetMicrousd) {
      return { allowed: false, reason: "budget" };
    }

    this.bumpWindows(windows.minuteKey, minuteCount + 1, windows.dayKey, dayCount + 1);
    return { allowed: true };
  }

  /**
   * Accepts one App Attest assertion counter for the token exchange, which
   * signs from the same key and so shares the same sequence. Nothing else is
   * counted.
   */
  advanceCounter(counter: number): { accepted: boolean } {
    return { accepted: this.useCounter(counter) };
  }

  /**
   * Whether `counter` is one this install has not used yet, recording it if
   * so. Ahead of the highest seen, it becomes the highest and the window
   * slides; inside the window below it, it is accepted once; behind the
   * window, never. No `await`, so the read and the write cannot interleave.
   */
  private useCounter(counter: number): boolean {
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

  /**
   * The month's spend, from the cache while it is fresh and from D1 once it is
   * not. Requests that find it stale together share one read, so a burst at a
   * cold start or a refresh boundary costs D1 one query rather than one each;
   * a failed read is forgotten, so the next request tries again.
   */
  private async monthlySpend(key: SpendKey, now: number): Promise<number> {
    const month = this.month(now);
    const identity = JSON.stringify([key.appId, key.scope, key.key, month]);
    const cached = this.spend.get(identity);
    if (cached && now - cached.readAt < SPEND_REFRESH_MS) return cached.microusd;
    const pending = this.spendReads.get(identity);
    if (pending) return pending;
    const read = monthlySpendMicrousd(this.env.DB, key, month);
    this.spendReads.set(identity, read);
    try {
      const microusd = await read;
      // A slower read never replaces a newer figure for the same ledger.
      const current = this.spend.get(identity);
      if (!current || current.readAt <= now) {
        // A ledger of another month or scope is never read again by this
        // object's callers once they have moved on, so the map holds only the
        // few this object is asked for.
        if (!current && this.spend.size >= MAX_SPEND_LEDGERS) this.spend.clear();
        this.spend.set(identity, { microusd, readAt: now });
      }
      return microusd;
    } finally {
      if (this.spendReads.get(identity) === read) this.spendReads.delete(identity);
    }
  }


  /** Both counters in one statement, which is one row written, not two. */
  private bumpWindows(minuteKey: string, minute: number, dayKey: string, day: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO request_windows(singleton, minute_key, minute_count, day_key, day_count)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         minute_key = excluded.minute_key,
         minute_count = excluded.minute_count,
         day_key = excluded.day_key,
         day_count = excluded.day_count`,
      minuteKey,
      minute,
      dayKey,
      day,
    );
  }

  getStatus(now: number): LimiterStatus {
    const at = Number.isFinite(now) ? now : Date.now();
    return {
      requestsToday: this.windowCounts(at).day,
    };
  }
}

import { DurableObject } from "cloudflare:workers";

/**
 * State that has to be instantly consistent: the block flag an operator sets,
 * the month's settled spend, and the request windows the app's own limits are
 * counted against.
 *
 * One instance per `app:user` pair, and — only for apps that set app-wide
 * limits — one more per app id, which is why nothing here is named for a user.
 *
 * The quota it enforces is the organization's own, set on its app and applied
 * to that app's end users. It is not the plan allowance: that is organization
 * wide, comes from billing, and lives in {@link import("./OrgQuota").OrgQuota}.
 * Neither reads the other.
 */

/** A window's key: the epoch minute, or the UTC date as `YYYY-MM-DD`. */
type WindowKind = "minute" | "day";

export interface LimiterCheckInput {
  now: number;
  rpm: number | null;
  rpd: number | null;
  monthlyBudgetMicrousd: number | null;
}

export type LimiterCheckResult =
  | { allowed: true; requestsToday: number; monthlyCostMicrousd: number }
  | { allowed: false; reason: "blocked" | "rate" | "budget"; retryAfterSeconds?: number };

export interface LimiterStatus {
  blocked: boolean;
  requestsToday: number;
  monthlyCostMicrousd: number;
}

/** How long the dedup ledger keeps an event, and how often it is pruned. */
const LEDGER_RETENTION_MS = 7 * 86_400_000;
const PRUNE_INTERVAL_MS = 86_400_000;

export class UserLimiter extends DurableObject<Env> {
  /**
   * Whether a pruning alarm is already pending, as far as this instance knows.
   * `undefined` means it has not looked yet; {@link ensurePruneAlarm} asks
   * storage once and then answers from here, so the common case — a ledger that
   * already has an alarm — costs nothing.
   */
  private prunePending: boolean | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
          id INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS monthly_cost (
          month TEXT PRIMARY KEY,
          microusd INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          blocked INTEGER NOT NULL DEFAULT 0
        );
        -- WITHOUT ROWID, so the primary key *is* the table: one page write per
        -- settled event rather than a table row plus a separate index entry.
        -- Every write here is on the request path and Cloudflare bills each
        -- index a row of its own, so the ledger carries no index but its key.
        --
        -- That is also why applied_at is not indexed: the daily prune below
        -- scans instead, which is billed as rows read at a thousandth the price
        -- of the write the index would have cost on every single request.
        CREATE TABLE IF NOT EXISTS applied_events (
          event_id TEXT PRIMARY KEY,
          applied_at INTEGER NOT NULL
        ) WITHOUT ROWID;
        -- Both counters in one row, so an admitted request writes once instead
        -- of once per window. A window that has rolled is overwritten in place
        -- rather than appended to, so there is nothing here to prune and the
        -- alarm is left to applied_events alone.
        --
        -- The predecessor of this table stored one row per request to get an
        -- exact sliding window. It was dropped for costing an unbounded write
        -- per request and needing its own pruning alarm; the fixed windows here
        -- admit a 2x burst across a boundary, which is an acceptable trade for
        -- abuse control at these magnitudes.
        CREATE TABLE IF NOT EXISTS request_windows (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          minute_key TEXT NOT NULL,
          minute_count INTEGER NOT NULL,
          day_key TEXT NOT NULL,
          day_count INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO state(singleton, blocked) VALUES (1, 0);
        INSERT OR IGNORE INTO _sql_schema_migrations(id, applied_at) VALUES (1, unixepoch());
      `);
    });
  }

  /**
   * Schedules the ledger prune if nothing has scheduled it yet.
   *
   * Called after every settlement, and after a prune that left rows behind.
   * Never anywhere else: the alarm exists only to prune `applied_events`, so an
   * object that has never settled an event arms nothing at all. That is what
   * keeps a dormant end user free — an alarm re-armed unconditionally would
   * bill a request and a write every day per user, forever, whether or not
   * they ever came back.
   */
  private async ensurePruneAlarm(): Promise<void> {
    if (this.prunePending === undefined) {
      this.prunePending = (await this.ctx.storage.getAlarm()) !== null;
    }
    if (this.prunePending) return;
    await this.ctx.storage.setAlarm(Date.now() + PRUNE_INTERVAL_MS);
    this.prunePending = true;
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
   * One row holds both, so this is a single read whichever window the caller
   * ends up deciding on.
   */
  private windowCounts(now: number): { minuteKey: string; minute: number; dayKey: string; day: number } {
    const minuteKey = this.windowKey("minute", now);
    const dayKey = this.windowKey("day", now);
    const stored = this.ctx.storage.sql
      .exec<{ minute_key: string; minute_count: number; day_key: string; day_count: number }>(
        "SELECT minute_key, minute_count, day_key, day_count FROM request_windows WHERE singleton = 1",
      )
      .toArray()[0];
    return {
      minuteKey,
      minute: stored?.minute_key === minuteKey ? stored.minute_count : 0,
      dayKey,
      day: stored?.day_key === dayKey ? stored.day_count : 0,
    };
  }

  /**
   * Claims one request against this scope's limits, or refuses it.
   *
   * Synchronous on purpose, exactly as `OrgQuota.admit` is: with no `await`
   * inside it, no other event can interleave, so reading both windows, deciding
   * on them and incrementing them cannot be split by a concurrent caller and a
   * limit can never be overshot.
   *
   * Both windows are incremented only once both have passed, so a request the
   * day limit refuses does not silently spend a minute token.
   */
  checkAndIncrement(input: LimiterCheckInput): LimiterCheckResult {
    // A caller-supplied clock decides which window a request lands in; a
    // nonsensical one falls back to real time rather than to window "NaN".
    const now = Number.isFinite(input.now) ? input.now : Date.now();
    if (this.isBlocked()) return { allowed: false, reason: "blocked" };

    const month = this.month(now);
    const monthlyCostMicrousd = this.monthlyCost(month);
    if (input.monthlyBudgetMicrousd !== null && monthlyCostMicrousd >= input.monthlyBudgetMicrousd) {
      return { allowed: false, reason: "budget" };
    }

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

    this.bumpWindows(windows.minuteKey, minuteCount + 1, windows.dayKey, dayCount + 1);
    return { allowed: true, requestsToday: dayCount + 1, monthlyCostMicrousd };
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

  private monthlyCost(month: string): number {
    return this.ctx.storage.sql
      .exec<{ microusd: number }>(
        "SELECT COALESCE((SELECT microusd FROM monthly_cost WHERE month = ?), 0) AS microusd",
        month,
      )
      .one().microusd;
  }

  /** The moderation switch, read on the request path before any dispatch. */
  isBlocked(): boolean {
    return this.ctx.storage.sql
      .exec<{ blocked: number }>("SELECT blocked FROM state WHERE singleton = 1")
      .one().blocked === 1;
  }

  /**
   * Settles one usage event against the month's spend. Recording retries the
   * same event, so the cost is applied only when `eventId` is new to this
   * instance's ledger; a replay reads the month back unchanged.
   *
   * Every statement below runs before the one `await`, so the ledger insert and
   * the spend it authorises still cannot be split by a concurrent caller. The
   * await only arms the alarm that will prune the row seven days from now, and
   * it happens last precisely so it cannot interleave with the settlement.
   */
  async addCost(eventId: string, now: number, microusd: number): Promise<number> {
    const month = this.month(now);
    const applied = this.ctx.storage.sql
      .exec<{ event_id: string }>(
        `INSERT OR IGNORE INTO applied_events(event_id, applied_at) VALUES (?, ?)
         RETURNING event_id`,
        eventId,
        // Deliberately not `now`: retention is measured against real time, so a
        // caller-supplied clock cannot make a row outlive the pruning window.
        Date.now(),
      )
      .toArray().length === 1;
    const total = applied
      ? this.ctx.storage.sql
        .exec<{ microusd: number }>(
          `INSERT INTO monthly_cost(month, microusd) VALUES (?, ?)
           ON CONFLICT(month) DO UPDATE SET microusd = microusd + excluded.microusd
           RETURNING microusd`,
          month,
          Math.max(0, Math.trunc(microusd)),
        )
        .one().microusd
      : this.monthlyCost(month);
    /*
     * The ledger holds a row for this event either way — this attempt stored
     * one, or an earlier one did — so a prune is owed either way.
     *
     * Arming on the replay path too is what makes the invariant "addCost
     * returned, so a prune is pending" rather than "the attempt that stored the
     * row armed it". The weaker version breaks when that attempt's `setAlarm`
     * is the thing that failed: the SQL above has already committed, so the
     * retry finds the row present, takes the replay path, and would leave a
     * stored row with nothing scheduled to ever remove it.
     */
    await this.ensurePruneAlarm();
    return total;
  }

  getStatus(now: number): LimiterStatus {
    const at = Number.isFinite(now) ? now : Date.now();
    return {
      blocked: this.isBlocked(),
      requestsToday: this.windowCounts(at).day,
      monthlyCostMicrousd: this.monthlyCost(this.month(at)),
    };
  }

  setBlocked(blocked: boolean): void {
    this.ctx.storage.sql.exec("UPDATE state SET blocked = ? WHERE singleton = 1", blocked ? 1 : 0);
  }

  reconcileMonth(month: string, microusd: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO monthly_cost(month, microusd) VALUES (?, ?)
       ON CONFLICT(month) DO UPDATE SET microusd = excluded.microusd`,
      month,
      Math.max(0, Math.trunc(microusd)),
    );
  }

  override async alarm(): Promise<void> {
    /*
     * First, before anything that can throw. The alarm that fired is already
     * cleared, so nothing is pending from here until this handler schedules the
     * next one, and the flag has to say so even if the prune below fails.
     *
     * Leaving it set through a failure is the one way this object stops pruning
     * for good: the platform retries a failing handler a handful of times and
     * then drops the alarm, and every later `addCost` would read the stale
     * `true` and decline to arm a replacement.
     */
    this.prunePending = false;
    // Dedup only has to outlive a recording retry, which finishes with the
    // request; a week of history is generous and keeps the ledger small.
    //
    // Unindexed, so this is a scan of the ledger. That is the deliberate half
    // of the trade in the schema above: a scan once a day is billed as rows
    // read, where the index that would avoid it is billed as a row written on
    // every request that ever settles.
    this.ctx.storage.sql.exec(
      "DELETE FROM applied_events WHERE applied_at < ?",
      Date.now() - LEDGER_RETENTION_MS,
    );
    // Only whether anything survived, so it stops at the first row rather than
    // counting every one of them across a second scan of the whole ledger.
    const remaining = this.ctx.storage.sql
      .exec<{ one: number }>("SELECT 1 AS one FROM applied_events LIMIT 1")
      .toArray().length === 1;
    // A standing alarm is not free: it is a request and a write every day, for
    // as long as the object exists. So it is rearmed only while there is still
    // something to prune, and a user who stops sending traffic stops costing
    // anything once their last settled event ages out. The next `addCost`
    // arms it again.
    if (remaining) await this.ensurePruneAlarm();
  }
}

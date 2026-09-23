import { DurableObject } from "cloudflare:workers";
import { MONTH_PATTERN } from "../contracts/schemas";

/**
 * State that has to be instantly consistent: the block flag an operator sets,
 * the month's settled spend, and the request windows the app's own limits are
 * counted against.
 *
 * One instance per `app:user` pair and one more per app id, which is why
 * nothing here is named for a user. D1 owns spend accounting; the monthly row
 * here is a versioned projection used by the request gate.
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

export class UserLimiter extends DurableObject<Env> {
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
          microusd INTEGER NOT NULL,
          version INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          blocked INTEGER NOT NULL DEFAULT 0
        );
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
      const versioned = this.ctx.storage.sql
        .exec<{ id: number }>("SELECT id FROM _sql_schema_migrations WHERE id = 2")
        .toArray().length === 1;
      if (!versioned) {
        // Existing objects have the pre-projection table without a version.
        // Its spend is preserved at version zero until D1 sends revision one.
        const columns = this.ctx.storage.sql
          .exec<{ name: string }>("PRAGMA table_info(monthly_cost)")
          .toArray();
        if (!columns.some((column) => column.name === "version")) {
          this.ctx.storage.sql.exec(
            "ALTER TABLE monthly_cost ADD COLUMN version INTEGER NOT NULL DEFAULT 0",
          );
        }
        this.ctx.storage.sql.exec(`
          DROP TABLE IF EXISTS applied_events;
        `);
        // Old objects may have a ledger-pruning alarm. Versioned projection has
        // no local retention work, so migration cancels it once and never arms
        // another perpetual alarm.
        await this.ctx.storage.deleteAlarm();
        this.ctx.storage.sql.exec(
          "INSERT INTO _sql_schema_migrations(id, applied_at) VALUES (2, unixepoch())",
        );
      }
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
   * Applies a D1 aggregate snapshot only when its revision is newer.
   *
   * A delivery can be duplicated forever, arrive after a later delivery, or
   * succeed while its D1 acknowledgement fails. This predicate makes every one
   * of those cases harmless without retaining event identities in the object.
   */
  setMonthlyCost(month: string, revision: number, microusd: number): boolean {
    if (!MONTH_PATTERN.test(month)) {
      throw new TypeError("month must use a valid YYYY-MM");
    }
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      throw new TypeError("revision must be a positive safe integer");
    }
    if (!Number.isSafeInteger(microusd) || microusd < 0) {
      throw new TypeError("microusd must be a non-negative safe integer");
    }
    return this.ctx.storage.sql
      .exec<{ month: string }>(
        `INSERT INTO monthly_cost(month, microusd, version) VALUES (?, ?, ?)
         ON CONFLICT(month) DO UPDATE SET
           microusd = excluded.microusd,
           version = excluded.version
         WHERE excluded.version > monthly_cost.version
         RETURNING month`,
        month,
        microusd,
        revision,
      )
      .toArray().length === 1;
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

  /** Harmlessly consumes an alarm that an object may have carried into v2. */
  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
  }

}

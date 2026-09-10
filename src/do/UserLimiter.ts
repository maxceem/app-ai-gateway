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
          microusd INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          blocked INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS applied_events (
          event_id TEXT PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_applied_events_applied_at ON applied_events(applied_at);
        -- Per-minute and per-day counts. Two rows, ever: a window that has
        -- rolled is overwritten in place rather than appended to, so there is
        -- nothing to prune and the alarm below is left to applied_events alone.
        --
        -- The predecessor of this table stored one row per request to get an
        -- exact sliding window. It was dropped for costing an unbounded write
        -- per request and needing its own pruning alarm; the fixed windows here
        -- admit a 2x burst across a boundary, which is an acceptable trade for
        -- abuse control at these magnitudes.
        CREATE TABLE IF NOT EXISTS request_windows (
          kind TEXT PRIMARY KEY,
          window_key TEXT NOT NULL,
          count INTEGER NOT NULL
        );
        DROP INDEX IF EXISTS idx_requests_occurred_at;
        DROP TABLE IF EXISTS requests;
        INSERT OR IGNORE INTO state(singleton, blocked) VALUES (1, 0);
        INSERT OR IGNORE INTO _sql_schema_migrations(id, applied_at) VALUES (1, unixepoch());
        INSERT OR IGNORE INTO _sql_schema_migrations(id, applied_at) VALUES (2, unixepoch());
        INSERT OR IGNORE INTO _sql_schema_migrations(id, applied_at) VALUES (3, unixepoch());
        INSERT OR IGNORE INTO _sql_schema_migrations(id, applied_at) VALUES (4, unixepoch());
      `);
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
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
   * The count in the named window, or zero if the stored row belongs to a
   * window that has since rolled. Reading a stale row as zero is what makes a
   * rollover free: nothing has to be deleted, only overwritten on the next
   * admission.
   */
  private windowCount(kind: WindowKind, key: string): number {
    const row = this.ctx.storage.sql
      .exec<{ window_key: string; count: number }>(
        "SELECT window_key, count FROM request_windows WHERE kind = ?",
        kind,
      )
      .toArray();
    const stored = row[0];
    return stored !== undefined && stored.window_key === key ? stored.count : 0;
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

    const minuteKey = this.windowKey("minute", now);
    const dayKey = this.windowKey("day", now);
    const minuteCount = this.windowCount("minute", minuteKey);
    const dayCount = this.windowCount("day", dayKey);

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

    this.bumpWindow("minute", minuteKey, minuteCount + 1);
    this.bumpWindow("day", dayKey, dayCount + 1);
    return { allowed: true, requestsToday: dayCount + 1, monthlyCostMicrousd };
  }

  private bumpWindow(kind: WindowKind, key: string, count: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO request_windows(kind, window_key, count) VALUES (?, ?, ?)
       ON CONFLICT(kind) DO UPDATE SET window_key = excluded.window_key, count = excluded.count`,
      kind,
      key,
      count,
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
   */
  addCost(eventId: string, now: number, microusd: number): number {
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
    if (!applied) {
      return this.monthlyCost(month);
    }
    const safeCost = Math.max(0, Math.trunc(microusd));
    return this.ctx.storage.sql
      .exec<{ microusd: number }>(
        `INSERT INTO monthly_cost(month, microusd) VALUES (?, ?)
         ON CONFLICT(month) DO UPDATE SET microusd = microusd + excluded.microusd
         RETURNING microusd`,
        month,
        safeCost,
      )
      .one().microusd;
  }

  getStatus(now: number): LimiterStatus {
    const at = Number.isFinite(now) ? now : Date.now();
    return {
      blocked: this.isBlocked(),
      requestsToday: this.windowCount("day", this.windowKey("day", at)),
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
    // Dedup only has to outlive a recording retry, which finishes with the
    // request; a week of history is generous and keeps the ledger small.
    this.ctx.storage.sql.exec(
      "DELETE FROM applied_events WHERE applied_at < ?",
      Date.now() - 7 * 86_400_000,
    );
    await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
  }
}

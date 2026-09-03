import { DurableObject } from "cloudflare:workers";

/**
 * Per-user state that has to be instantly consistent: the block flag an
 * operator sets, and the month's settled spend.
 *
 * It enforces no quota. The gateway's only allowance is the organization-wide
 * monthly request count in {@link import("./OrgQuota").OrgQuota}; what lives
 * here is a moderation switch and cost observability, both of which are read
 * back per user and so cannot be answered from D1 within a request.
 */

export interface LimiterStatus {
  blocked: boolean;
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
        -- Per-request timestamps existed only to enforce per-minute and per-day
        -- rate limits, which the gateway no longer has. Already-deployed
        -- instances carry the table and its rows; nothing reads either, and the
        -- alarm that used to prune them is gone, so they are dropped here rather
        -- than left to accumulate forever.
        DROP INDEX IF EXISTS idx_requests_occurred_at;
        DROP TABLE IF EXISTS requests;
        INSERT OR IGNORE INTO state(singleton, blocked) VALUES (1, 0);
        INSERT OR IGNORE INTO _sql_schema_migrations(id, applied_at) VALUES (1, unixepoch());
        INSERT OR IGNORE INTO _sql_schema_migrations(id, applied_at) VALUES (2, unixepoch());
        INSERT OR IGNORE INTO _sql_schema_migrations(id, applied_at) VALUES (3, unixepoch());
      `);
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
      }
    });
  }

  private month(now: number): string {
    return new Date(now).toISOString().slice(0, 7);
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
      return this.ctx.storage.sql
        .exec<{ microusd: number }>(
          "SELECT COALESCE((SELECT microusd FROM monthly_cost WHERE month = ?), 0) AS microusd",
          month,
        )
        .one().microusd;
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
    const monthlyCostMicrousd = this.ctx.storage.sql
      .exec<{ microusd: number }>(
        "SELECT COALESCE((SELECT microusd FROM monthly_cost WHERE month = ?), 0) AS microusd",
        this.month(now),
      )
      .one().microusd;
    return { blocked: this.isBlocked(), monthlyCostMicrousd };
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

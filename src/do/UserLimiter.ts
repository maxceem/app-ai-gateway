import { DurableObject } from "cloudflare:workers";

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
        CREATE TABLE IF NOT EXISTS requests (
          occurred_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_requests_occurred_at ON requests(occurred_at);
        CREATE TABLE IF NOT EXISTS monthly_cost (
          month TEXT PRIMARY KEY,
          microusd INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          blocked INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO state(singleton, blocked) VALUES (1, 0);
        INSERT OR IGNORE INTO _sql_schema_migrations(id, applied_at) VALUES (1, unixepoch());
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

  checkAndIncrement(input: LimiterCheckInput): LimiterCheckResult {
    const blocked = this.ctx.storage.sql
      .exec<{ blocked: number }>("SELECT blocked FROM state WHERE singleton = 1")
      .one().blocked === 1;
    if (blocked) return { allowed: false, reason: "blocked" };

    const month = this.month(input.now);
    const monthlyCostMicrousd = this.ctx.storage.sql
      .exec<{ microusd: number }>(
        "SELECT COALESCE((SELECT microusd FROM monthly_cost WHERE month = ?), 0) AS microusd",
        month,
      )
      .one().microusd;
    if (input.monthlyBudgetMicrousd !== null && monthlyCostMicrousd >= input.monthlyBudgetMicrousd) {
      return { allowed: false, reason: "budget" };
    }

    const minuteStart = input.now - 60_000;
    const dayStart = this.startOfUtcDay(input.now);
    const counts = this.ctx.storage.sql
      .exec<{ minute_count: number; day_count: number }>(
        `SELECT
           SUM(CASE WHEN occurred_at > ? THEN 1 ELSE 0 END) AS minute_count,
           SUM(CASE WHEN occurred_at >= ? THEN 1 ELSE 0 END) AS day_count
         FROM requests WHERE occurred_at >= ?`,
        minuteStart,
        dayStart,
        dayStart,
      )
      .one();
    const minuteCount = counts.minute_count ?? 0;
    const dayCount = counts.day_count ?? 0;
    if (input.rpm !== null && minuteCount >= input.rpm) {
      const oldest = this.ctx.storage.sql
        .exec<{ occurred_at: number }>(
          "SELECT occurred_at FROM requests WHERE occurred_at > ? ORDER BY occurred_at LIMIT 1",
          minuteStart,
        )
        .one().occurred_at;
      return {
        allowed: false,
        reason: "rate",
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + 60_000 - input.now) / 1000)),
      };
    }
    if (input.rpd !== null && dayCount >= input.rpd) {
      const nextDay = dayStart + 86_400_000;
      return {
        allowed: false,
        reason: "rate",
        retryAfterSeconds: Math.max(1, Math.ceil((nextDay - input.now) / 1000)),
      };
    }

    this.ctx.storage.sql.exec("INSERT INTO requests(occurred_at) VALUES (?)", input.now);
    return { allowed: true, requestsToday: dayCount + 1, monthlyCostMicrousd };
  }

  addCost(now: number, microusd: number): number {
    const safeCost = Math.max(0, Math.trunc(microusd));
    const month = this.month(now);
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
    const blocked = this.ctx.storage.sql
      .exec<{ blocked: number }>("SELECT blocked FROM state WHERE singleton = 1")
      .one().blocked === 1;
    const requestsToday = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM requests WHERE occurred_at >= ?", this.startOfUtcDay(now))
      .one().count;
    const monthlyCostMicrousd = this.ctx.storage.sql
      .exec<{ microusd: number }>(
        "SELECT COALESCE((SELECT microusd FROM monthly_cost WHERE month = ?), 0) AS microusd",
        this.month(now),
      )
      .one().microusd;
    return { blocked, requestsToday, monthlyCostMicrousd };
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
    const cutoff = Date.now() - 2 * 86_400_000;
    this.ctx.storage.sql.exec("DELETE FROM requests WHERE occurred_at < ?", cutoff);
    await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
  }
}

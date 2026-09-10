import { DurableObject } from "cloudflare:workers";

export interface QuotaPeriodInput {
  limit: number;
  scheduleId: string;
  scheduleRevision: number;
  periodId: string;
  periodStart: string;
  periodEnd: string;
  resetAt: string;
}

interface QuotaState {
  limit: number;
  used: number;
  periodId: string;
  periodStart: string;
  periodEnd: string;
  resetAt: string;
}

export type QuotaAdmission =
  | (QuotaState & { allowed: true })
  | (QuotaState & { allowed: false; retryAfterSeconds: number })
  | { allowed: false; superseded: true };

export type QuotaUsage =
  | (Omit<QuotaState, "limit"> & { superseded?: false })
  | { superseded: true };

/**
 * The organization-wide allowance counter. The caller resolves the billing
 * schedule; this object atomically adopts it and admits against its counter.
 */
export class OrgQuota extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS quota_periods (
          schedule_id TEXT NOT NULL,
          period_start TEXT NOT NULL,
          used INTEGER NOT NULL,
          PRIMARY KEY (schedule_id, period_start)
        );
        CREATE TABLE IF NOT EXISTS quota_schedule (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          schedule_id TEXT NOT NULL,
          revision INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS quota_period_watermarks (
          schedule_id TEXT PRIMARY KEY,
          period_start TEXT NOT NULL
        );
      `);
    });
  }

  private adopt(input: Omit<QuotaPeriodInput, "limit">): boolean {
    const { scheduleId, scheduleRevision: revision, periodStart } = input;
    const current = this.ctx.storage.sql
      .exec<{ schedule_id: string; revision: number }>(
        "SELECT schedule_id, revision FROM quota_schedule WHERE singleton = 1",
      )
      .toArray()[0];
    if (current) {
      if (revision < current.revision) return false;
      if (revision === current.revision && scheduleId !== current.schedule_id) return false;
    }
    const watermark = this.ctx.storage.sql
      .exec<{ period_start: string }>(
        "SELECT period_start FROM quota_period_watermarks WHERE schedule_id = ?",
        scheduleId,
      )
      .toArray()[0]?.period_start;
    if (watermark && periodStart < watermark) return false;
    if (!current || revision > current.revision) {
      this.ctx.storage.sql.exec(
        `INSERT INTO quota_schedule(singleton, schedule_id, revision) VALUES (1, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           schedule_id = excluded.schedule_id,
           revision = excluded.revision`,
        scheduleId,
        revision,
      );
    }
    if (!watermark || periodStart > watermark) {
      this.ctx.storage.sql.exec(
        `INSERT INTO quota_period_watermarks(schedule_id, period_start) VALUES (?, ?)
         ON CONFLICT(schedule_id) DO UPDATE SET period_start = excluded.period_start`,
        scheduleId,
        periodStart,
      );
    }
    return true;
  }

  private valid(input: Omit<QuotaPeriodInput, "limit">, now: number): boolean {
    const start = Date.parse(input.periodStart);
    const end = Date.parse(input.periodEnd);
    return input.scheduleId.length > 0
      && Number.isSafeInteger(input.scheduleRevision)
      && input.scheduleRevision >= 0
      && input.periodId.length > 0
      && Number.isFinite(start)
      && Number.isFinite(end)
      && start < end
      && input.resetAt === input.periodEnd
      && now >= start
      && now < end;
  }

  private used(scheduleId: string, periodStart: string): number {
    return this.ctx.storage.sql
      .exec<{ used: number }>(
        `SELECT COALESCE((
           SELECT used FROM quota_periods WHERE schedule_id = ? AND period_start = ?
         ), 0) AS used`,
        scheduleId,
        periodStart,
      )
      .one().used;
  }

  /**
   * The conditional upsert prevents concurrent callers from overshooting.
   * Historical rows remain so a return to Free recovers its earlier count.
   */
  admit(input: QuotaPeriodInput): QuotaAdmission {
    const now = Date.now();
    if (!this.valid(input, now) || !this.adopt(input)) {
      return { allowed: false, superseded: true };
    }
    const end = Date.parse(input.periodEnd);
    const limit = Number.isFinite(input.limit) ? Math.max(0, Math.trunc(input.limit)) : 0;
    const state = (used: number): QuotaState => ({
      limit,
      used,
      periodId: input.periodId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      resetAt: input.resetAt,
    });
    const refuse = (used: number): QuotaAdmission => ({
      allowed: false,
      ...state(used),
      retryAfterSeconds: Math.max(1, Math.ceil((end - now) / 1_000)),
    });
    if (limit < 1) return refuse(this.used(input.scheduleId, input.periodStart));

    const admitted = this.ctx.storage.sql
      .exec<{ used: number }>(
        `INSERT INTO quota_periods(schedule_id, period_start, used) VALUES (?, ?, 1)
         ON CONFLICT(schedule_id, period_start) DO UPDATE SET used = used + 1
         WHERE quota_periods.used < ?
         RETURNING used`,
        input.scheduleId,
        input.periodStart,
        limit,
      )
      .toArray();
    if (admitted.length !== 1) {
      return refuse(this.used(input.scheduleId, input.periodStart));
    }
    return { allowed: true, ...state(admitted[0]!.used) };
  }

  usage(input: Omit<QuotaPeriodInput, "limit">): QuotaUsage {
    if (!this.valid(input, Date.now()) || !this.adopt(input)) return { superseded: true };
    return {
      periodId: input.periodId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      resetAt: input.resetAt,
      used: this.used(input.scheduleId, input.periodStart),
    };
  }
}

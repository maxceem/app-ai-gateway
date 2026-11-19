/**
 * The account's limiter object (plan section 4.2, admission step 3): the
 * plan allowance, on hosted deployments only. One per account. Ported from
 * v1's `OrgQuota`.
 *
 * Requests are counted here at admission, one row per plan period. The caller
 * resolves the period and the limit; the limit arrives with every admission
 * rather than being stored, so a limit change takes effect on the next request
 * and the period's count carries over.
 *
 * Plan minutes are not counted here: they come from the ledger, the sum of the
 * daily rollups over the period (D18), read and cached like a budget total.
 *
 * This is the plan allowance (`billing_*`). It never reads, and is never read
 * by, the limits a customer sets on its own app (`app_*`).
 */
import { DurableObject } from "cloudflare:workers";
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";

/** How often a minute total in use is read again from the rollups. */
export const MINUTES_REFRESH_MS = 10_000;

export interface AllowanceAdmissionInput {
  /** The plan period's schedule and start: all the counter is keyed by. */
  periodId: string;
  /** When the period resets, for a refusal's `Retry-After`. */
  periodEnd: string;
  limit: number;
}

export type AllowanceAdmission =
  | { allowed: true; used: number; limit: number }
  | { allowed: false; used: number; limit: number; retryAfterSeconds: number };

export class AccountLimiter extends DurableObject<Env> {
  private minutes: { key: string; ms: number; readAt: number } | null = null;
  /** Reads in flight, by account and date range, so two ranges never share one answer. */
  private readonly minutesReads = new Map<string, Promise<number>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS allowance (
          period_id TEXT PRIMARY KEY,
          used INTEGER NOT NULL
        );
      `);
    });
  }

  /**
   * Admits one request against the period, or refuses it. Synchronous, so the
   * conditional upsert cannot be interleaved and the limit is never overshot.
   * The period is the caller's, resolved when its request arrived.
   */
  admit(input: AllowanceAdmissionInput): AllowanceAdmission {
    const now = Date.now();
    const end = Date.parse(input.periodEnd);
    const limit = Number.isFinite(input.limit) ? Math.max(0, Math.trunc(input.limit)) : 0;
    const refuse = (): AllowanceAdmission => ({
      allowed: false,
      used: this.usage(input.periodId),
      limit,
      retryAfterSeconds: Number.isFinite(end) ? Math.max(1, Math.ceil((end - now) / 1_000)) : 1,
    });
    if (limit < 1) return refuse();
    const admitted = this.ctx.storage.sql
      .exec<{ used: number }>(
        `INSERT INTO allowance(period_id, used) VALUES (?, 1)
         ON CONFLICT(period_id) DO UPDATE SET used = used + 1
         WHERE allowance.used < ?
         RETURNING used`,
        input.periodId,
        limit,
      )
      .toArray();
    if (admitted.length !== 1) return refuse();
    return { allowed: true, used: admitted[0]!.used, limit };
  }

  /** Requests admitted in one period so far. */
  usage(periodId: string): number {
    return this.ctx.storage.sql
      .exec<{ used: number }>("SELECT COALESCE((SELECT used FROM allowance WHERE period_id = ?), 0) AS used", periodId)
      .one().used;
  }

  /**
   * Session time used in a plan period, in milliseconds: the account's daily
   * rollups from `fromDay` (inclusive) to `toDay` (exclusive). Cached and
   * refreshed in the background every `MINUTES_REFRESH_MS` while in use; only
   * a cold object waits. Null when the first read fails.
   */
  async sessionMs(input: { accountId: string; fromDay: string; toDay: string; now: number }): Promise<number | null> {
    const key = `${input.accountId}|${input.fromDay}|${input.toDay}`;
    const cached = this.minutes?.key === key ? this.minutes : null;
    if (cached !== null) {
      if (input.now - cached.readAt >= MINUTES_REFRESH_MS) void this.readSessionMs(key, input).catch(() => undefined);
      return cached.ms;
    }
    try {
      return await this.readSessionMs(key, input);
    } catch {
      return null;
    }
  }

  private readSessionMs(key: string, input: { accountId: string; fromDay: string; toDay: string; now: number }): Promise<number> {
    const pending = this.minutesReads.get(key);
    if (pending !== undefined) return pending;
    const read = this.env.DB.prepare(
      `SELECT COALESCE(SUM(session_ms), 0) AS ms FROM usage_day WHERE account_id = ? AND day >= ? AND day < ?`,
    )
      .bind(input.accountId, input.fromDay, input.toDay)
      .first<{ ms: number }>()
      .then((row) => {
        const ms = row?.ms ?? 0;
        if (this.minutes === null || this.minutes.key !== key || this.minutes.readAt <= input.now) {
          this.minutes = { key, ms, readAt: input.now };
        }
        return ms;
      })
      .catch((error: unknown) => {
        log("warn", "plan_minutes_unread", { account: input.accountId, error: errorFacts(error) });
        throw error;
      })
      .finally(() => {
        if (this.minutesReads.get(key) === read) this.minutesReads.delete(key);
      });
    this.minutesReads.set(key, read);
    return read;
  }
}

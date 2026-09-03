import { DurableObject } from "cloudflare:workers";

/**
 * The gateway's only quota: a calendar-month request allowance shared by an
 * entire organization.
 *
 * One instance per organization, addressed by organization id, so the count is
 * authoritative no matter which app, user, credential or colo the request came
 * through. The allowance itself is not stored here — it comes from the billing
 * plan on every call, so a plan change takes effect on the next request without
 * anything having to be written back into this object.
 */

/** A month key in UTC, `YYYY-MM`. */
export function utcMonthKey(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

/** The instant the current UTC month's allowance is replaced by a fresh one. */
export function nextUtcMonthStart(now: number): number {
  const date = new Date(now);
  // Month 12 rolls into January of the following year, which is exactly the
  // boundary wanted; no year arithmetic of our own is needed.
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

export interface QuotaAdmissionInput {
  now: number;
  /** The plan's `maxRequestsPerMonth`. Callers with no limit never call in. */
  limit: number;
}

interface QuotaState {
  limit: number;
  used: number;
  /** The next UTC month boundary, ISO-8601 with a `Z` offset. */
  resetAt: string;
}

export type QuotaAdmission =
  | (QuotaState & { allowed: true })
  | (QuotaState & { allowed: false; retryAfterSeconds: number });

export interface QuotaUsage {
  month: string;
  used: number;
  resetAt: string;
}

export class OrgQuota extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS monthly_requests (
          month TEXT PRIMARY KEY,
          used INTEGER NOT NULL
        );
      `);
    });
  }

  private used(month: string): number {
    return this.ctx.storage.sql
      .exec<{ used: number }>(
        "SELECT COALESCE((SELECT used FROM monthly_requests WHERE month = ?), 0) AS used",
        month,
      )
      .one().used;
  }

  /**
   * Claims one request against this month's allowance, or refuses it.
   *
   * The claim is a single upsert whose `DO UPDATE` is conditional on the stored
   * count, so the read and the increment cannot be separated: concurrent callers
   * are serialized by SQLite itself and the limit can never be overshot. The
   * whole method is synchronous, which additionally means no other event can
   * interleave with it inside the object.
   */
  admit(input: QuotaAdmissionInput): QuotaAdmission {
    const now = Number.isFinite(input.now) ? input.now : Date.now();
    const month = utcMonthKey(now);
    const resetAtMs = nextUtcMonthStart(now);
    const resetAt = new Date(resetAtMs).toISOString();
    // A fractional or negative allowance is nonsense the caller should never
    // send; floor it rather than admit more than was paid for.
    const limit = Number.isFinite(input.limit) ? Math.max(0, Math.trunc(input.limit)) : 0;
    const refuse = (used: number): QuotaAdmission => ({
      allowed: false,
      limit,
      used,
      resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - now) / 1000)),
    });
    if (limit < 1) return refuse(this.used(month));

    const admitted = this.ctx.storage.sql
      .exec<{ used: number }>(
        `INSERT INTO monthly_requests(month, used) VALUES (?, 1)
           ON CONFLICT(month) DO UPDATE SET used = used + 1
           WHERE monthly_requests.used < ?
         RETURNING used`,
        month,
        limit,
      )
      .toArray();
    if (admitted.length !== 1) return refuse(this.used(month));

    const used = admitted[0]!.used;
    // The first admission of a new month is the one moment the previous month's
    // row becomes dead weight, so that is when it is dropped. Doing it here
    // rather than on an alarm keeps this object free of scheduled wake-ups.
    if (used === 1) {
      this.ctx.storage.sql.exec("DELETE FROM monthly_requests WHERE month <> ?", month);
    }
    return { allowed: true, limit, used, resetAt };
  }

  /** Read-only view of the current month, for reporting. Never admits. */
  usage(now: number): QuotaUsage {
    const at = Number.isFinite(now) ? now : Date.now();
    const month = utcMonthKey(at);
    return {
      month,
      used: this.used(month),
      resetAt: new Date(nextUtcMonthStart(at)).toISOString(),
    };
  }
}

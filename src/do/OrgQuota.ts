import { AdmissionReceipts } from "./admission-receipts";
import { DurableObject } from "cloudflare:workers";

export interface QuotaAdmissionInput {
  /** The allowance period's schedule and start, which is all the counter is keyed by. */
  admissionId?: string;
  periodId: string;
  /** When the period resets, which is all a refusal's `Retry-After` needs. */
  periodEnd: string;
  limit: number;
}

export type QuotaAdmission =
  | { allowed: true; used: number; limit: number }
  | { allowed: false; used: number; limit: number; retryAfterSeconds: number };

/**
 * The organization-wide allowance counter: one row per allowance period.
 *
 * The caller resolves which period a request falls in and what the plan's
 * limit is; this object only counts. The limit arrives with every admission
 * rather than being stored, so a limit change on the same schedule takes effect
 * on the next request and the count the period has already spent carries over.
 *
 * There is exactly one instance per organization, so every request that
 * organization makes is serialized through it and pays a round trip to
 * wherever it lives — a pinned serialization point by design, and what makes
 * the allowance an exact count rather than an estimate. The admission module,
 * `src/execution/admission.ts`, explains what that costs per request and why
 * leasing admissions per isolate was refused.
 */
export class OrgQuota extends DurableObject<Env> {
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
   * conditional upsert and the read behind a refusal cannot be interleaved by
   * a concurrent caller and the limit can never be overshot.
   *
   * The period is the caller's, resolved when its request arrived, and is
   * never judged against the clock here: a request that crosses midnight on
   * its way in counts toward the month it started in rather than being refused
   * as though that month were exhausted. An unclaimed account whose one window
   * has closed never gets this far — the account gate refuses it first.
   */
  receipt(admissionId: string): QuotaAdmission | null {
    return new AdmissionReceipts(this.ctx.storage.sql).read(admissionId);
  }

  admit(input: QuotaAdmissionInput): QuotaAdmission {
    if (!input.admissionId) return this.claim(input);
    return this.ctx.storage.transactionSync(() => {
      const receipts = new AdmissionReceipts(this.ctx.storage.sql);
      const fingerprint = JSON.stringify([input.periodId, input.periodEnd, input.limit]);
      const previous = receipts.read<QuotaAdmission>(input.admissionId!, fingerprint);
      if (previous) return previous;
      const result = this.claim(input);
      receipts.save(input.admissionId!, fingerprint, result);
      return result;
    });
  }

  private claim(input: QuotaAdmissionInput): QuotaAdmission {
    const now = Date.now();
    const end = Date.parse(input.periodEnd);
    const limit = Number.isFinite(input.limit) ? Math.max(0, Math.trunc(input.limit)) : 0;
    const refuse = (): QuotaAdmission => ({
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
      .exec<{ used: number }>(
        "SELECT COALESCE((SELECT used FROM allowance WHERE period_id = ?), 0) AS used",
        periodId,
      )
      .one().used;
  }
}

import { AdmissionReceipts } from "./admission-receipts";
import { DurableObject } from "cloudflare:workers";
import { monthlySpendMicrousd, type SpendKey } from "../usage/app-usage-accounting";

/**
 * Request windows for the app's own limits, counted consistently per scope.
 *
 * One instance per `app:user` pair and one more per app id, which is why
 * nothing here is named for a user. The month's spend is D1's — one row the
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

/** A window's key: the epoch minute, or the UTC date as `YYYY-MM-DD`. */
type WindowKind = "minute" | "day";

export interface LimiterCheckInput {
  admissionId?: string;
  freshSpend?: boolean;
  now: number;
  rpm: number | null;
  rpd: number | null;
  monthlyBudgetMicrousd: number | null;
  /** Whose month the budget is measured against. */
  spend: SpendKey;
}

export type LimiterCheckResult =
  | { allowed: true }
  | { allowed: false; reason: "rate" | "budget"; retryAfterSeconds?: number };

export interface LimiterStatus {
  requestsToday: number;
}

export class UserLimiter extends DurableObject<Env> {
  /** The last read of the month's spend. Memory only: an evicted object reads again. */
  private spend: { month: string; microusd: number; readAt: number } | null = null;
  /** The read in flight, shared by every request that finds the cache stale meanwhile. */
  private spendRead: { month: string; promise: Promise<number> } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        -- Both counters in one row, so an admitted request writes once instead
        -- of once per window. A window that has rolled is overwritten in place
        -- rather than appended to, so there is nothing here to prune. Fixed
        -- windows admit a 2x burst across a boundary, which is an acceptable
        -- trade for abuse control at these magnitudes.
        CREATE TABLE IF NOT EXISTS session_leases (session_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS request_windows (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          minute_key TEXT NOT NULL,
          minute_count INTEGER NOT NULL,
          day_key TEXT NOT NULL,
          day_count INTEGER NOT NULL
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
   * Claims one request against this scope's limits, or refuses it.
   *
   * Everything that decides and counts runs without an `await` between the
   * read and the write, so no concurrent caller can interleave and a window can
   * never be overshot. The one `await` — reading the month's spend when the
   * cached figure has aged — comes first, and only fills the cache: it decides
   * nothing a concurrent caller could invalidate.
   *
   * Both windows are incremented only once both have passed, so a request the
   * day limit refuses does not silently spend a minute token.
   */
  async checkAndIncrement(input: LimiterCheckInput): Promise<LimiterCheckResult> {
    const fingerprint = JSON.stringify(input);
    const receipts = input.admissionId ? new AdmissionReceipts(this.ctx.storage.sql) : null;
    const previous = input.admissionId ? receipts!.read<LimiterCheckResult>(input.admissionId, fingerprint) : null;
    if (previous) return previous;
    // A caller-supplied clock decides which window a request lands in; a
    // nonsensical one falls back to real time rather than to window "NaN".
    const now = Number.isFinite(input.now) ? input.now : Date.now();
    if (input.monthlyBudgetMicrousd !== null) {
      const spent = await this.monthlySpend(input.spend, now, input.freshSpend);
      if (spent >= input.monthlyBudgetMicrousd) {
        return this.ctx.storage.transactionSync(() => {
          const result = { allowed: false, reason: "budget" } as const;
          if (input.admissionId) {
            const previous = receipts!.read<LimiterCheckResult>(input.admissionId, fingerprint);
            if (previous) return previous;
            receipts!.save(input.admissionId, fingerprint, result);
          }
          return result;
        });
      }
    }

    return this.ctx.storage.transactionSync(() => {
      const previous = input.admissionId ? receipts!.read<LimiterCheckResult>(input.admissionId, fingerprint) : null;
      if (previous) return previous;
      const result = this.claimWindows(input, now);
      if (input.admissionId) receipts!.save(input.admissionId, fingerprint, result);
      return result;
    });
  }

  receipt(admissionId: string): LimiterCheckResult | null {
    return new AdmissionReceipts(this.ctx.storage.sql).read(admissionId);
  }

  private claimWindows(input: LimiterCheckInput, now: number): LimiterCheckResult {
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
    return { allowed: true };
  }

  /**
   * The month's spend, from the cache while it is fresh and from D1 once it is
   * not. Requests that find it stale together share one read, so a burst at a
   * cold start or a refresh boundary costs D1 one query rather than one each;
   * a failed read is forgotten, so the next request tries again.
   */
  private async monthlySpend(key: SpendKey, now: number, fresh = false): Promise<number> {
    const month = this.month(now);
    if (fresh) return monthlySpendMicrousd(this.env.DB, key, month);
    const cached = this.spend;
    if (cached && cached.month === month && now - cached.readAt < SPEND_REFRESH_MS) {
      return cached.microusd;
    }
    if (this.spendRead?.month === month) return this.spendRead.promise;
    const read = { month, promise: monthlySpendMicrousd(this.env.DB, key, month) };
    this.spendRead = read;
    try {
      const microusd = await read.promise;
      // A slower read of an older window never replaces a newer figure.
      if (!this.spend || this.spend.month !== month || this.spend.readAt <= now) {
        this.spend = { month, microusd, readAt: now };
      }
      return microusd;
    } finally {
      if (this.spendRead === read) this.spendRead = null;
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

  acquireSession(sessionId: string, cap: number): { allowed: boolean; expiresAt: number } {
    if (!Number.isSafeInteger(cap) || cap <= 0) throw new RangeError("Invalid session cap");
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      this.ctx.storage.sql.exec("DELETE FROM session_leases WHERE expires_at <= ?", now);
      const existing = this.ctx.storage.sql.exec<{ expires_at: number }>("SELECT expires_at FROM session_leases WHERE session_id = ?", sessionId).toArray()[0];
      if (existing) return { allowed: true, expiresAt: existing.expires_at };
      const count = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM session_leases").one().count;
      if (count >= cap) return { allowed: false, expiresAt: 0 };
      const expiresAt = now + 90_000;
      this.ctx.storage.sql.exec("INSERT INTO session_leases VALUES (?, ?)", sessionId, expiresAt);
      return { allowed: true, expiresAt };
    });
  }

  renewSession(sessionId: string): { allowed: boolean; expiresAt: number } {
    const now = Date.now();
    const expiresAt = now + 90_000;
    const rows = this.ctx.storage.sql.exec("UPDATE session_leases SET expires_at = ? WHERE session_id = ? AND expires_at > ? RETURNING session_id", expiresAt, sessionId, now).toArray();
    return { allowed: rows.length === 1, expiresAt: rows.length ? expiresAt : 0 };
  }

  releaseSession(sessionId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM session_leases WHERE session_id = ?", sessionId);
  }

  getStatus(now: number): LimiterStatus {
    const at = Number.isFinite(now) ? now : Date.now();
    return {
      requestsToday: this.windowCounts(at).day,
    };
  }
}

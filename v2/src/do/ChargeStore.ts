/**
 * One store per app for ledger writes that failed (plan section 4.2).
 *
 * It is used only when a D1 write fails, so it is never on the normal request
 * path. It keeps the whole entries (charge and open work) and its alarm
 * retries them in batches, with the same `ON CONFLICT(id) DO NOTHING` write,
 * until D1 takes them. Writing one twice is harmless.
 *
 * Limits (set in step 1c): it holds at most `MAX_PENDING` entries and keeps
 * one for at most `RETENTION_MS` after it arrived. Past either, the oldest
 * entries are written to the logs in full (`usage_record_failed`) and
 * dropped; the console shows the gap. Nothing is lost silently: a logged
 * charge can still be written by hand.
 */
import { DurableObject } from "cloudflare:workers";
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";
import { logLostEntry, writeToLedger, type LedgerEntry } from "../ledger/write.ts";

/**
 * How many entries one store holds before the oldest go to the logs. One
 * entry is a few kilobytes, so this stays far below a Durable Object's storage
 * limit, while covering a long D1 outage for a busy app.
 */
export const MAX_PENDING = 10_000;
/**
 * How long an entry is kept before it goes to the logs: longer than any D1
 * outage we expect, short enough that a stuck entry is noticed within a week.
 */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Entries written per alarm. */
export const RETRY_BATCH = 50;
/** The first retry, then doubling up to `MAX_RETRY_DELAY_MS`. */
export const FIRST_RETRY_DELAY_MS = 5_000;
export const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;

export class ChargeStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS pending (
        id TEXT PRIMARY KEY,
        entry TEXT NOT NULL,
        stored_at INTEGER NOT NULL
      )`);
      ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS pending_stored ON pending (stored_at)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    });
  }

  /** Keeps entries for retry. An entry already kept is not kept twice. */
  async keep(entries: readonly LedgerEntry[]): Promise<void> {
    const now = Date.now();
    for (const entry of entries) {
      this.ctx.storage.sql.exec(
        "INSERT INTO pending (id, entry, stored_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
        entry.charge.id,
        JSON.stringify(entry),
        now,
      );
    }
    this.trim(now);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now + FIRST_RETRY_DELAY_MS);
    }
  }

  /**
   * Keeps a job's final result with its estimate, when the estimate waits
   * here: the result goes on the job's check row, so both are written
   * together and the sweep settles the job from it. False when no entry here
   * is that job's estimate.
   */
  async keepJobResult(job: string, result: Readonly<Record<string, unknown>> | object): Promise<boolean> {
    const rows = this.ctx.storage.sql.exec<{ id: string; entry: string }>("SELECT id, entry FROM pending").toArray();
    for (const row of rows) {
      const entry = JSON.parse(row.entry) as LedgerEntry;
      if (entry.charge.ownerType !== "job" || entry.charge.ownerId !== job || entry.charge.kind !== "estimate") continue;
      let found = false;
      const openWork = entry.openWork.map((work) => {
        if (work.kind !== "job_check") return work;
        found = true;
        return { ...work, detail: { ...(work.detail ?? {}), result } };
      });
      if (!found) return false;
      this.ctx.storage.sql.exec("UPDATE pending SET entry = ? WHERE id = ?", JSON.stringify({ ...entry, openWork }), row.id);
      return true;
    }
    return false;
  }

  /** How many entries wait. For tests and diagnostics. */
  async pendingCount(): Promise<number> {
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pending").one().n;
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    this.trim(now);
    const rows = this.ctx.storage.sql
      .exec<{ id: string; entry: string }>("SELECT id, entry FROM pending ORDER BY stored_at, id LIMIT ?", RETRY_BATCH)
      .toArray();
    if (rows.length === 0) {
      this.setDelay(0);
      return;
    }
    const entries = rows.map((row) => JSON.parse(row.entry) as LedgerEntry);
    try {
      await writeToLedger(this.env.DB, entries);
    } catch (error) {
      const delay = Math.min(MAX_RETRY_DELAY_MS, Math.max(FIRST_RETRY_DELAY_MS, this.delay() * 2));
      this.setDelay(delay);
      log("warn", "charge_store_retry_failed", { pending: rows.length, retryInMs: delay, error: errorFacts(error) });
      await this.ctx.storage.setAlarm(now + delay);
      return;
    }
    for (const row of rows) this.ctx.storage.sql.exec("DELETE FROM pending WHERE id = ?", row.id);
    log("info", "charge_store_written", { written: rows.length });
    this.setDelay(0);
    const left = await this.pendingCount();
    if (left > 0) await this.ctx.storage.setAlarm(Date.now());
  }

  /** Drops what is past the limits, oldest first, logging each in full. */
  private trim(now: number): void {
    const expired = this.ctx.storage.sql
      .exec<{ id: string; entry: string }>("SELECT id, entry FROM pending WHERE stored_at < ?", now - RETENTION_MS)
      .toArray();
    const count = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pending").one().n;
    const over = Math.max(0, count - expired.length - MAX_PENDING);
    const overflow =
      over === 0
        ? []
        : this.ctx.storage.sql
            .exec<{ id: string; entry: string }>(
              "SELECT id, entry FROM pending WHERE stored_at >= ? ORDER BY stored_at, id LIMIT ?",
              now - RETENTION_MS,
              over,
            )
            .toArray();
    for (const row of [...expired, ...overflow]) {
      logLostEntry(JSON.parse(row.entry) as LedgerEntry, new Error("The charge store gave up on this charge"));
      this.ctx.storage.sql.exec("DELETE FROM pending WHERE id = ?", row.id);
    }
  }

  private delay(): number {
    const row = this.ctx.storage.sql.exec<{ value: number }>("SELECT value FROM state WHERE key = 'delay'").toArray()[0];
    return row?.value ?? 0;
  }

  private setDelay(value: number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO state (key, value) VALUES ('delay', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      value,
    );
  }
}

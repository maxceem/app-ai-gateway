/**
 * One store per app for ledger writes that failed (plan section 4.2).
 *
 * It is used only when a D1 write fails, so it is never on the normal request
 * path. It keeps the whole entries (charge and open work), and open-work rows
 * that have no charge (a job's saved figure), and its alarm retries them in
 * batches, with the same `ON CONFLICT(id) DO NOTHING` write, until D1 takes
 * them. Writing one twice is harmless. Nothing kept here is ever edited.
 *
 * Limits (set in step 1c): it holds at most `MAX_PENDING` entries and rows
 * in all, across both tables, and keeps each for at most `RETENTION_MS` after
 * it arrived. Past either, the oldest are written to the logs in full
 * (`usage_record_failed`, `open_work_unrecorded`) and dropped; the console shows the gap. Nothing is lost silently: a logged
 * charge can still be written by hand.
 */
import { DurableObject } from "cloudflare:workers";
import { withDeadline } from "../core/background.ts";
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";
import { LEDGER_D1_DEADLINE_MS, logLostEntry, writeOpenWork, writeToLedger, type LedgerEntry, type OpenWorkRow } from "../ledger/write.ts";

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

/**
 * One retry of what the store holds: charges first, then open-work rows. Each
 * write has the ledger's deadline, so a stalled D1 batch rejects and the alarm
 * falls through to its backoff instead of hanging. Stable ids make a late
 * commit safe. `now` is the time of this retry: the ledger judges a late
 * charge by when it is written, not by when it was first kept
 * (`../ledger/late-booking.ts`).
 */
export async function retryStored(db: D1Database, entries: readonly LedgerEntry[], rows: readonly OpenWorkRow[], now: number): Promise<void> {
  await withDeadline(writeToLedger(db, entries, now), LEDGER_D1_DEADLINE_MS, "retrying stored charges");
  await withDeadline(writeOpenWork(db, rows), LEDGER_D1_DEADLINE_MS, "retrying stored open work");
}

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
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS pending_work (
        id TEXT PRIMARY KEY,
        row TEXT NOT NULL,
        stored_at INTEGER NOT NULL
      )`);
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

  /** Keeps open-work rows that have no charge, for retry. A row already kept is not kept twice, nor changed. */
  async keepWork(rows: readonly OpenWorkRow[]): Promise<void> {
    const now = Date.now();
    for (const row of rows) {
      this.ctx.storage.sql.exec(
        "INSERT INTO pending_work (id, row, stored_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
        row.id,
        JSON.stringify(row),
        now,
      );
    }
    this.trim(now);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now + FIRST_RETRY_DELAY_MS);
    }
  }

  /** How many entries and rows wait. For tests and diagnostics. */
  async pendingCount(): Promise<number> {
    const entries = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pending").one().n;
    return entries + this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pending_work").one().n;
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    this.trim(now);
    const rows = this.ctx.storage.sql
      .exec<{ id: string; entry: string }>("SELECT id, entry FROM pending ORDER BY stored_at, id LIMIT ?", RETRY_BATCH)
      .toArray();
    // Estimates first: a figure row waits for its estimate anyway.
    const work = this.ctx.storage.sql
      .exec<{ id: string; row: string }>("SELECT id, row FROM pending_work ORDER BY stored_at, id LIMIT ?", Math.max(0, RETRY_BATCH - rows.length))
      .toArray();
    if (rows.length === 0 && work.length === 0) {
      this.setDelay(0);
      return;
    }
    try {
      await retryStored(
        this.env.DB,
        rows.map((row) => JSON.parse(row.entry) as LedgerEntry),
        work.map((one) => JSON.parse(one.row) as OpenWorkRow),
        now,
      );
    } catch (error) {
      const delay = Math.min(MAX_RETRY_DELAY_MS, Math.max(FIRST_RETRY_DELAY_MS, this.delay() * 2));
      this.setDelay(delay);
      log("warn", "charge_store_retry_failed", { pending: rows.length + work.length, retryInMs: delay, error: errorFacts(error) });
      await this.ctx.storage.setAlarm(now + delay);
      return;
    }
    for (const row of rows) this.ctx.storage.sql.exec("DELETE FROM pending WHERE id = ?", row.id);
    for (const one of work) this.ctx.storage.sql.exec("DELETE FROM pending_work WHERE id = ?", one.id);
    // Processed, not necessarily written: a repeat whose first write committed is skipped by the ledger.
    log("info", "charge_store_written", { processed: rows.length + work.length });
    this.setDelay(0);
    const left = await this.pendingCount();
    if (left > 0) await this.ctx.storage.setAlarm(Date.now());
  }

  /**
   * Drops what is past the limits, logging each in full: anything older than
   * `RETENTION_MS`, then the oldest across both tables (entries and rows
   * without a charge) until at most `MAX_PENDING` are left.
   */
  private trim(now: number): void {
    const cutoff = now - RETENTION_MS;
    const sql = this.ctx.storage.sql;
    for (const row of sql.exec<{ id: string; entry: string }>("SELECT id, entry FROM pending WHERE stored_at < ?", cutoff).toArray()) {
      this.dropEntry(row.id, row.entry);
    }
    for (const one of sql.exec<{ id: string; row: string }>("SELECT id, row FROM pending_work WHERE stored_at < ?", cutoff).toArray()) {
      this.dropWork(one.id, one.row);
    }
    const count = sql.exec<{ n: number }>("SELECT (SELECT COUNT(*) FROM pending) + (SELECT COUNT(*) FROM pending_work) AS n").one().n;
    const over = Math.max(0, count - MAX_PENDING);
    if (over === 0) return;
    const oldest = sql
      .exec<{ kind: "entry" | "work"; id: string; body: string }>(
        `SELECT 'entry' AS kind, id, entry AS body, stored_at FROM pending
         UNION ALL SELECT 'work' AS kind, id, row AS body, stored_at FROM pending_work
         ORDER BY stored_at, id LIMIT ?`,
        over,
      )
      .toArray();
    for (const one of oldest) {
      if (one.kind === "entry") this.dropEntry(one.id, one.body);
      else this.dropWork(one.id, one.body);
    }
  }

  private dropEntry(id: string, entry: string): void {
    logLostEntry(JSON.parse(entry) as LedgerEntry, new Error("The charge store gave up on this charge"));
    this.ctx.storage.sql.exec("DELETE FROM pending WHERE id = ?", id);
  }

  private dropWork(id: string, row: string): void {
    log("error", "open_work_unrecorded", { work: id, row: JSON.parse(row) as Record<string, unknown> });
    this.ctx.storage.sql.exec("DELETE FROM pending_work WHERE id = ?", id);
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

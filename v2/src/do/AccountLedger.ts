/**
 * One ledger object per account (D21, plan section 8, step 8f): the records
 * of what happened in the account, in the object's own SQLite. Charges and
 * their rollups, sessions, open work, and sign-in and rejection events.
 * Settings and logins stay in D1.
 *
 * - **Statements** arrive with D1's shape (`../ledger/database.ts`), so the
 *   ledger code is the same as when it ran on D1. A batch runs in one
 *   `transactionSync`. The rollup trigger runs in here, as it did in D1.
 * - **Schema** changes run inside the object when it wakes, by version
 *   (`../ledger/schema.ts`), before any statement is taken.
 * - **Work** runs on the object's one alarm: the sweep of its open work when a
 *   row is due, and once a day, after `NIGHTLY_HOUR_UTC`, the nightly
 *   maintenance of its tables. A write that changes a row makes sure the
 *   alarm is set while work remains. A failing job is caught and logged; only
 *   a failure to set the next alarm is let through, so Cloudflare retries the
 *   handler.
 *
 * It is not `AccountLimiter`: that one exists only on hosted deployments and
 * answers before a request is served, while the ledger is on every deployment,
 * takes writes after the answer, and serves usage reads.
 */
import { DurableObject } from "cloudflare:workers";
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";
import { maintenanceRowLimit, maintenanceStatementBudget } from "../core/query-budget.ts";
import { runLedgerStatements, shapedLikeD1, type LedgerResult, type LedgerStatement } from "../ledger/database.ts";
import { LEDGER_SCHEMA } from "../ledger/schema.ts";
import { runSweep } from "../ledger/sweep.ts";
import { NIGHTLY_HOUR_UTC, runLedgerNightly } from "../maintenance/nightly.ts";

/** The shortest time between two runs of the alarm's work: a minute, as the sweep's cron ran. */
export const WORK_EVERY_MS = 60_000;

/** The object's own bookkeeping, apart from the ledger's tables. */
const META_TABLE = "CREATE TABLE IF NOT EXISTS ledger_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)";

/** Brings an object's database up to the last version of `schema`. Each version in its own transaction. */
export function migrateLedger(storage: DurableObjectStorage, schema: readonly (readonly string[])[] = LEDGER_SCHEMA): number {
  storage.sql.exec(META_TABLE);
  const from = Number(readMeta(storage, "schema_version") ?? "0");
  for (let version = from + 1; version <= schema.length; version += 1) {
    storage.transactionSync(() => {
      for (const statement of schema[version - 1]!) storage.sql.exec(statement);
      writeMeta(storage, "schema_version", String(version));
    });
  }
  return Math.max(from, schema.length);
}

function readMeta(storage: DurableObjectStorage, key: string): string | null {
  const row = storage.sql.exec<{ value: string }>("SELECT value FROM ledger_meta WHERE key = ?", key).toArray()[0];
  return row?.value ?? null;
}

function writeMeta(storage: DurableObjectStorage, key: string, value: string): void {
  storage.sql.exec("INSERT INTO ledger_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
}

/** The UTC day of a time, `YYYY-MM-DD`. */
function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** When the nightly maintenance is next due after `now`, given the day it last ran. */
export function nextNightly(now: number, lastDay: string | null): number {
  const today = new Date(now);
  const todayAt = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), NIGHTLY_HOUR_UTC);
  if (lastDay === utcDay(now)) return todayAt + 86_400_000;
  return Math.max(now, todayAt);
}

/** Whether the ledger holds anything the nightly maintenance looks after. */
const HOLDS_ROWS = `SELECT EXISTS (SELECT 1 FROM charge) OR EXISTS (SELECT 1 FROM usage_day) OR EXISTS (SELECT 1 FROM usage_month)
  OR EXISTS (SELECT 1 FROM budget_day) OR EXISTS (SELECT 1 FROM session) OR EXISTS (SELECT 1 FROM app_auth_event)
  OR EXISTS (SELECT 1 FROM app_rejection_event) OR EXISTS (SELECT 1 FROM open_work) AS held`;

/** The earliest work still being tried, through `open_work_due_pending` (schema version 2). */
export const NEXT_DUE_SQL = "SELECT MIN(due_at) AS due FROM open_work WHERE gave_up_at IS NULL";

export class AccountLedger extends DurableObject<Env> {
  /** When the alarm last ran in this instance: counts even when storing it failed. */
  private lastRunAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      migrateLedger(ctx.storage);
    });
  }

  /** Runs statements sent with D1's shape: one by one, or a batch as one transaction. */
  async query(statements: LedgerStatement[], transaction: boolean): Promise<LedgerResult[]> {
    const results = runLedgerStatements(this.ctx.storage, statements, transaction);
    if (results.some((result) => result.changes > 0)) {
      // The write has committed: a failure to set the alarm never turns it into a failed write.
      try {
        await this.planWork();
      } catch (error) {
        log("warn", "ledger_alarm_unset", { error: errorFacts(error) });
      }
    }
    return results;
  }

  /** The schema version this object is at. For tests and diagnostics. */
  async schemaVersion(): Promise<number> {
    return Number(readMeta(this.ctx.storage, "schema_version") ?? "0");
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    this.lastRunAt = now;
    try {
      // Kept in storage too: the object sleeps between runs, and the pause must outlast that.
      writeMeta(this.ctx.storage, "last_run_at", String(now));
    } catch (error) {
      log("warn", "ledger_run_unmarked", { error: errorFacts(error) });
    }
    const ledger = shapedLikeD1(async (statements, transaction) => runLedgerStatements(this.ctx.storage, statements, transaction));
    try {
      const kept: Promise<unknown>[] = [];
      try {
        await runSweep(this.env, ledger, { now, waitUntil: (work) => kept.push(work.catch(() => undefined)) });
      } catch (error) {
        log("error", "sweep_failed", { error: errorFacts(error) });
      }
      await Promise.all(kept);
      if (nextNightly(now, readMeta(this.ctx.storage, "nightly_day")) <= now) {
        // The clean-up first: on a full ledger whose writes fail, its deletes are what free the space.
        // Logs each job itself, and never throws.
        await runLedgerNightly(ledger, now, maintenanceStatementBudget(this.env), maintenanceRowLimit(this.env));
        try {
          writeMeta(this.ctx.storage, "nightly_day", utcDay(now));
        } catch (error) {
          // Run again on the next alarm, at least a minute away.
          log("warn", "ledger_nightly_unmarked", { error: errorFacts(error) });
        }
      }
    } finally {
      // Whatever failed above, the next run is set. Only a failure to set it is let through, so Cloudflare retries.
      await this.planWork(true);
    }
  }

  /**
   * Sets the alarm for the next work: the earliest open work still being
   * tried, and the next nightly maintenance while the ledger holds rows.
   * Never sooner than `WORK_EVERY_MS` after the alarm last ran, as the minute
   * cron was, so work that keeps failing never runs it in a loop, and a write
   * never pulls it into that pause. A write may bring an alarm set for later
   * (tonight's run) forward to work due sooner; it never moves one set
   * sooner. After a run (`fresh`) the alarm is set again from scratch.
   */
  private async planWork(fresh = false): Promise<void> {
    const sql = this.ctx.storage.sql;
    const due = sql.exec<{ due: number | null }>(NEXT_DUE_SQL).one().due;
    const held = sql.exec<{ held: number }>(HOLDS_ROWS).one().held === 1;
    const now = Date.now();
    const times = [...(due === null ? [] : [due]), ...(held ? [nextNightly(now, readMeta(this.ctx.storage, "nightly_day"))] : [])];
    if (times.length === 0) return;
    // The later of the stored time and this instance's own: a run whose write failed still counts.
    const lastRunAt = Math.max(this.lastRunAt, Number(readMeta(this.ctx.storage, "last_run_at") ?? "0"));
    const next = Math.max(now, lastRunAt + WORK_EVERY_MS, Math.min(...times));
    const current = fresh ? null : await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }
}

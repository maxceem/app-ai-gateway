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
  OR EXISTS (SELECT 1 FROM app_rejection_event) AS held`;

export class AccountLedger extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      migrateLedger(ctx.storage);
    });
  }

  /** Runs statements sent with D1's shape: one by one, or a batch as one transaction. */
  async query(statements: LedgerStatement[], transaction: boolean): Promise<LedgerResult[]> {
    const results = runLedgerStatements(this.ctx.storage, statements, transaction);
    if (results.some((result) => result.changes > 0)) await this.planWork();
    return results;
  }

  /** The schema version this object is at. For tests and diagnostics. */
  async schemaVersion(): Promise<number> {
    return Number(readMeta(this.ctx.storage, "schema_version") ?? "0");
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const ledger = shapedLikeD1(async (statements, transaction) => runLedgerStatements(this.ctx.storage, statements, transaction));
    const kept: Promise<unknown>[] = [];
    try {
      await runSweep(this.env, ledger, { now, waitUntil: (work) => kept.push(work.catch(() => undefined)) });
    } catch (error) {
      log("error", "sweep_failed", { error: errorFacts(error) });
    }
    await Promise.all(kept);
    if (nextNightly(now, readMeta(this.ctx.storage, "nightly_day")) <= now) {
      // Marked first: a run that fails part way is not repeated until the next night.
      writeMeta(this.ctx.storage, "nightly_day", utcDay(now));
      // Logs each job itself, and never throws.
      await runLedgerNightly(ledger, now, maintenanceStatementBudget(this.env), maintenanceRowLimit(this.env));
    }
    await this.planWork(true);
  }

  /**
   * Sets the alarm for the next work: the earliest open work still being
   * tried, and the next nightly maintenance while the ledger holds rows. An
   * alarm already set earlier is kept, unless `fresh` (the alarm just ran).
   */
  private async planWork(fresh = false): Promise<void> {
    const sql = this.ctx.storage.sql;
    const due = sql.exec<{ due: number | null }>("SELECT MIN(due_at) AS due FROM open_work WHERE gave_up_at IS NULL").one().due;
    const held = sql.exec<{ held: number }>(HOLDS_ROWS).one().held === 1;
    const now = Date.now();
    const times = [...(due === null ? [] : [due]), ...(held ? [nextNightly(now, readMeta(this.ctx.storage, "nightly_day"))] : [])];
    if (times.length === 0) return;
    const next = Math.max(now, Math.min(...times));
    const current = fresh ? null : await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }
}

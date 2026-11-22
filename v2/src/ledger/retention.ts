/**
 * Usage retention (plan section 4.2: "Usage rollups and retention carry over
 * from today"), run by the nightly maintenance (`../maintenance/nightly.ts`).
 *
 * The same windows as v1 (`src/usage/usage-retention.ts`):
 *
 * - **Detailed rows are kept 90 days.** Charges, and the session rows and
 *   budget totals that go with them, are deleted after that. The day rollup
 *   (`usage_day`) already holds their sums: its trigger adds each charge as
 *   it is written, and no trigger runs on delete, so deleting a charge
 *   changes no total. v1 had to sum its events into a rollup before deleting
 *   them; v2 does not.
 * - **Day rollups are kept 400 days**, then moved into month rows
 *   (`usage_month`), so the rollup stops growing too.
 *
 * A charge is never deleted while open work on it remains (plan section 4.2:
 * "Detailed rows are not compacted while open work on them remains"): work the
 * sweep has not finished or given up on, or a session not settled yet. Open
 * work ends within days (the sweep gives up after about three), well inside 90
 * days, so in practice nothing old is held back. Work given up is kept 90
 * days, so the console can show it, and is then deleted.
 *
 * A correction is deleted only once the charge it corrects is gone. So while
 * a charge is in the ledger, every correction of it is too, and a late
 * settlement works out its difference from all of them. Once the charge is
 * gone, nothing more is written against it (`./corrections.ts`).
 *
 * Every pass picks its rows straight from its rule, through an index, a chunk
 * at a time (`../core/chunked-delete.ts`). A row kept back is never picked, so
 * it never holds up the rows after it, and nothing is saved between runs.
 */
import { log } from "../core/log.ts";
import { errorFacts } from "../core/error-facts.ts";
import { CHUNK_ROWS, deleteInChunks, type ChunkedDeleteResult, type Deletable } from "../core/chunked-delete.ts";
import { QueryBudget, QueryBudgetExhausted } from "../core/query-budget.ts";

/** How long a charge, a session row and a budget total survive, as v1's usage events. */
export const USAGE_DETAIL_RETENTION_DAYS = 90;

/** How long a day rollup survives before it moves into its month, as v1. */
export const USAGE_DAY_RETENTION_DAYS = 400;

/** How long open work the sweep gave up on stays, so the console can show it. */
export const GAVE_UP_WORK_RETENTION_DAYS = 90;

const DAY_MS = 86_400_000;

/** The UTC day `days` before `now`, as `YYYY-MM-DD`. */
function dayBefore(now: number, days: number): string {
  return new Date(now - days * DAY_MS).toISOString().slice(0, 10);
}

/** Open work given up on before `?`. Served by `open_work_gave_up`. */
function gaveUpWork(cutoffMs: number): Deletable {
  return {
    table: "open_work",
    rowids: "SELECT rowid FROM open_work WHERE gave_up_at IS NOT NULL AND gave_up_at < ?",
    params: [cutoffMs],
  };
}

/**
 * Charges dated before `?`. Kept: a charge with open work the sweep has not
 * finished or given up on; a slice of a session not settled yet; and a
 * correction whose charge is still there. Served by `charge_usage_day`.
 */
function oldCharges(cutoffDay: string): Deletable {
  return {
    table: "charge",
    rowids: `SELECT c.rowid FROM charge AS c
      WHERE c.usage_day < ?
        AND NOT EXISTS (SELECT 1 FROM open_work AS w
                        WHERE w.owner_type = c.owner_type AND w.owner_id = c.owner_id AND w.gave_up_at IS NULL)
        AND NOT (c.owner_type = 'session'
                 AND EXISTS (SELECT 1 FROM session AS s WHERE s.id = c.owner_id AND s.settlement = 'open'))
        AND (c.corrects_charge_id IS NULL
             OR NOT EXISTS (SELECT 1 FROM charge AS o WHERE o.id = c.corrects_charge_id))`,
    params: [cutoffDay],
  };
}

/**
 * Session rows started before `?`, once settled (or left as an estimate),
 * with no open work and no charges left: the charges go first, and a session
 * that still has one keeps its row, which settlement and corrections read.
 * Served by `session_started`.
 */
function oldSessions(cutoffMs: number): Deletable {
  return {
    table: "session",
    rowids: `SELECT s.rowid FROM session AS s
      WHERE s.started_at < ? AND s.settlement != 'open'
        AND NOT EXISTS (SELECT 1 FROM open_work AS w
                        WHERE w.owner_type = 'session' AND w.owner_id = s.id AND w.gave_up_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM charge AS c WHERE c.owner_type = 'session' AND c.owner_id = s.id)`,
    params: [cutoffMs],
  };
}

/**
 * Budget totals of days before `?`. Budgets read only the current UTC month,
 * so an old day is never read again. A late correction for an old day writes
 * a new row with only its difference, deleted in its turn. Served by
 * `budget_day_day`.
 */
function oldBudgetDays(cutoffDay: string): Deletable {
  return { table: "budget_day", rowids: "SELECT rowid FROM budget_day WHERE day < ?", params: [cutoffDay] };
}

const ROLLUP_SUMS = [
  "charges",
  "unpriced_charges",
  "cost_nano",
  "input_tokens",
  "cached_input_tokens",
  "cache_write_tokens",
  "output_tokens",
  "units",
  "session_ms",
] as const;

/**
 * One chunk of day rollups, of whole months before `?1`, picked in a fixed
 * order (served by `usage_day_day`), so both statements of a chunk pick the
 * same rows.
 */
export const FOLD_PICK = "SELECT rowid FROM usage_day WHERE day < ?1 ORDER BY day, rowid LIMIT ?2";

/** The fold's two statements: add the chunk to its month rows, then delete it. */
const FOLD_STATEMENTS = 2;

/**
 * Moves day rollups of whole months past the window into their month rows, a
 * chunk at a time while `budget` lasts. `db` charges `budget`.
 *
 * A chunk is one batch, so one transaction: its days are added to their
 * month rows and deleted together, and a day is always in exactly one of the
 * two tables. The month rows add, rather than replace, so a month may move
 * over several chunks or nights, and a day rollup written late (a late
 * correction of an old charge) joins its month on a later night. A month's
 * total is always its `usage_month` row plus whatever of that month is still
 * in `usage_day`.
 */
async function foldMonths(db: D1Database, budget: QueryBudget, firstKeptDay: string, chunkRows: number): Promise<ChunkedDeleteResult> {
  const sums = ROLLUP_SUMS.join(", ");
  const keys = "account_id, app_id, substr(day, 1, 7), provider_type, provider_connection_id, model, outcome, unit";
  const add = db.prepare(
    `INSERT INTO usage_month (account_id, app_id, month, provider_type, provider_connection_id, model, outcome, unit, ${sums})
     SELECT ${keys}, ${ROLLUP_SUMS.map((column) => `SUM(${column})`).join(", ")}
     FROM usage_day
     WHERE rowid IN (${FOLD_PICK})
     GROUP BY ${keys}
     ON CONFLICT (account_id, app_id, month, provider_type, provider_connection_id, model, outcome, unit) DO UPDATE SET
       ${ROLLUP_SUMS.map((column) => `${column} = ${column} + excluded.${column}`).join(",\n       ")}`,
  );
  const remove = db.prepare(`DELETE FROM usage_day WHERE rowid IN (${FOLD_PICK})`);
  const result: ChunkedDeleteResult = { chunks: 0, deleted: 0, caughtUp: false };
  while (budget.affords(FOLD_STATEMENTS)) {
    const [, removed] = await db.batch([add.bind(firstKeptDay, chunkRows), remove.bind(firstKeptDay, chunkRows)]);
    const deleted = removed?.meta.changes ?? 0;
    result.chunks += 1;
    result.deleted += deleted;
    if (deleted < chunkRows) {
      result.caughtUp = true;
      break;
    }
  }
  return result;
}

/** The first day of the month of `now - days`: every day before it is in a month wholly past the window. */
function firstKeptMonthDay(now: number, days: number): string {
  return `${dayBefore(now, days).slice(0, 7)}-01`;
}

export interface UsageRetentionResult {
  gaveUpWork: ChunkedDeleteResult | null;
  charges: ChunkedDeleteResult | null;
  sessions: ChunkedDeleteResult | null;
  budgetDays: ChunkedDeleteResult | null;
  months: ChunkedDeleteResult | null;
}

/** The rows each delete pass picks at `now`, in the order the passes run. */
export function usageRetentionRules(now: number) {
  const detailDay = dayBefore(now, USAGE_DETAIL_RETENTION_DAYS);
  return {
    gaveUpWork: gaveUpWork(now - GAVE_UP_WORK_RETENTION_DAYS * DAY_MS),
    charges: oldCharges(detailDay),
    sessions: oldSessions(now - USAGE_DETAIL_RETENTION_DAYS * DAY_MS),
    budgetDays: oldBudgetDays(detailDay),
  } as const;
}

/** Runs one pass and logs what it did; a failure is logged and leaves the passes after it to run. */
async function pass(name: string, run: () => Promise<ChunkedDeleteResult>): Promise<ChunkedDeleteResult | null> {
  try {
    const value = await run();
    log("info", `usage_retention_${name}`, { ...value });
    return value;
  } catch (error) {
    if (error instanceof QueryBudgetExhausted) {
      log("warn", "maintenance_budget_exhausted", { sweep: `usage_retention_${name}`, limit: error.limit });
    } else {
      log("warn", `usage_retention_${name}_failed`, { error: errorFacts(error) });
    }
    return null;
  }
}

/**
 * Statements each pass may count on, however large the backlog of the passes
 * before it: two chunks each (the fold's chunk is two statements).
 */
const RESERVED = { charges: 2, sessions: 2, budgetDays: 2, months: 2 * FOLD_STATEMENTS } as const;

/**
 * Every usage retention pass, within `budget`. Each pass reports under its own
 * code, and a failure in one leaves the others to run.
 */
export async function runUsageRetention(
  db: D1Database,
  now: number,
  budget: QueryBudget,
  chunkRows: number = CHUNK_ROWS,
): Promise<UsageRetentionResult> {
  const rules = usageRetentionRules(now);
  /** What is left, less what the passes after this one are kept. */
  const share = (heldBack: number) => budget.limited(Math.max(0, budget.remaining - heldBack));
  const run = (heldBack: number, spec: Deletable) => () => {
    const own = share(heldBack);
    return deleteInChunks(own.database(db), own, spec, chunkRows);
  };

  // First, so the charges whose work was given up long ago are free to go.
  const gaveUp = pass(
    "gave_up_work",
    run(RESERVED.charges + RESERVED.sessions + RESERVED.budgetDays + RESERVED.months, rules.gaveUpWork),
  );
  const result: UsageRetentionResult = { gaveUpWork: await gaveUp, charges: null, sessions: null, budgetDays: null, months: null };
  result.charges = await pass("charges", run(RESERVED.sessions + RESERVED.budgetDays + RESERVED.months, rules.charges));
  result.sessions = await pass("sessions", run(RESERVED.budgetDays + RESERVED.months, rules.sessions));
  result.budgetDays = await pass("budget_days", run(RESERVED.months, rules.budgetDays));
  result.months = await pass("months", () =>
    foldMonths(budget.database(db), budget, firstKeptMonthDay(now, USAGE_DAY_RETENTION_DAYS), chunkRows),
  );
  return result;
}

/**
 * Usage retention (plan section 4.2: "Usage rollups and retention carry over
 * from today"), run by the nightly maintenance (`../maintenance/nightly.ts`).
 *
 * The same windows as v1 (`src/usage/usage-retention.ts`):
 *
 * - **Detailed rows are kept 90 days.** Charges, and the session rows and
 *   budget totals that go with them, are deleted after that. The day rollup
 *   (`usage_day`) already holds their sums: its trigger adds each charge as
 *   it is written, so deleting a charge changes no total. v1 had to sum its
 *   events into a rollup before deleting them; v2 does not.
 * - **Day rollups are kept 400 days**, then moved into month rows
 *   (`usage_month`), so the rollup stops growing too.
 *
 * A charge is never deleted while open work on it remains (plan section 4.2:
 * "Detailed rows are not compacted while open work on them remains"): work the
 * sweep has not finished or given up on, or a session not settled yet. So a
 * correction always has its original to read. Open work ends within days (the
 * sweep gives up after about three), well inside 90 days, so in practice
 * nothing old is held back. Work given up is kept 90 days, so the console can
 * show it, and is then deleted.
 *
 * None of these tables has an index on its date alone, and adding one would
 * cost a write on every charge. So each pass walks the table in row order
 * (`rowid`), a chunk of {@link CHUNK_ROWS} at a time, which is roughly the
 * order the rows were written in, and filters each chunk by date. A pass ends
 * for the night at the first chunk that still holds a row too new to delete:
 * the rows after it are newer still, except a few written late. Each chunk is
 * its own transaction and nothing is kept between runs: the next run starts
 * again from the oldest row left. A row kept back by open work does not stop
 * the walk; the pass steps over it to the rows after it.
 */
import { log } from "../core/log.ts";
import { errorFacts } from "../core/error-facts.ts";
import { QueryBudget, QueryBudgetExhausted } from "../core/query-budget.ts";

/** How long a charge, a session row and a budget total survive, as v1's usage events. */
export const USAGE_DETAIL_RETENTION_DAYS = 90;

/** How long a day rollup survives before it moves into its month, as v1. */
export const USAGE_DAY_RETENTION_DAYS = 400;

/** How long open work the sweep gave up on stays, so the console can show it. */
export const GAVE_UP_WORK_RETENTION_DAYS = 90;

/**
 * Rows per transaction, as v1: about a second of D1's single write lock. The
 * only writes it holds up are ledger inserts, which run after the response.
 */
export const CHUNK_ROWS = 5_000;

const DAY_MS = 86_400_000;

/** The UTC day `days` before `now`, as `YYYY-MM-DD`. */
function dayBefore(now: number, days: number): string {
  return new Date(now - days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * One table's walk: how a chunk is worked, and how to tell a row too new.
 *
 * `work` gets the chunk's rowid range as `?1` and `?2`, then `params`.
 * `tooNew` is a condition on one row, with `params` from `?3` on as well.
 */
interface Walk {
  readonly table: string;
  readonly work: readonly string[];
  readonly tooNew: string;
  readonly params: readonly (string | number)[];
}

export interface WalkResult {
  chunks: number;
  /** Rows changed by the chunks' first statement: deleted, or summed into month rows. */
  changed: number;
  /** Rows deleted. */
  deleted: number;
  /** Whether the walk reached rows too new to touch, or the end, rather than running out of budget. */
  caughtUp: boolean;
}

/** Statements a walk starts with: finding the oldest row. */
const START_STATEMENTS = 1;

/**
 * Walks `table` in rowid order, a chunk at a time, while the budget lasts.
 *
 * One chunk is one batch, so one transaction: the work, then whether a row too
 * new is left in the chunk, then where the next chunk starts. So a chunk is
 * all done or not done at all, and a run that stops midway leaves whole
 * chunks behind.
 */
async function walk(db: D1Database, spec: Walk, budget: QueryBudget, chunkRows: number): Promise<WalkResult> {
  const result: WalkResult = { chunks: 0, changed: 0, deleted: 0, caughtUp: false };
  const perChunk = spec.work.length + 2;
  if (!budget.affords(START_STATEMENTS + perChunk)) return result;
  let cursor = (await db.prepare(`SELECT MIN(rowid) AS id FROM ${spec.table}`).first<{ id: number | null }>())?.id ?? null;
  while (cursor !== null) {
    if (!budget.affords(perChunk)) return result;
    const end = cursor + chunkRows;
    const statements = [
      ...spec.work.map((sql) => db.prepare(sql).bind(cursor, end, ...spec.params)),
      db
        .prepare(`SELECT EXISTS (SELECT 1 FROM ${spec.table} WHERE rowid >= ?1 AND rowid < ?2 AND ${spec.tooNew}) AS newer`)
        .bind(cursor, end, ...spec.params),
      db.prepare(`SELECT MIN(rowid) AS id FROM ${spec.table} WHERE rowid >= ?`).bind(end),
    ];
    const results = await db.batch<Record<string, unknown>>(statements);
    result.chunks += 1;
    result.changed += results[0]?.meta.changes ?? 0;
    // The last statement of the work deletes the chunk's rows.
    result.deleted += results[spec.work.length - 1]?.meta.changes ?? 0;
    const newer = Number(results[spec.work.length]?.results[0]?.newer ?? 0) === 1;
    const next = (results[spec.work.length + 1]?.results[0]?.id as number | null | undefined) ?? null;
    if (newer || next === null) {
      result.caughtUp = true;
      return result;
    }
    cursor = next;
  }
  result.caughtUp = true;
  return result;
}

/**
 * Open work on an owner the sweep has not finished or given up on, or a
 * session not settled yet: either keeps the owner's charges. `c` is the charge.
 */
const CHARGE_KEPT = `(
  EXISTS (SELECT 1 FROM open_work AS w
          WHERE w.owner_type = c.owner_type AND w.owner_id = c.owner_id AND w.gave_up_at IS NULL)
  OR (c.owner_type = 'session'
      AND EXISTS (SELECT 1 FROM session AS s WHERE s.id = c.owner_id AND s.settlement = 'open'))
)`;

/** Charges past the window, a chunk at a time. `?3` is the first day kept. */
function chargeWalk(cutoffDay: string): Walk {
  return {
    table: "charge",
    work: [
      `DELETE FROM charge WHERE rowid IN (
         SELECT c.rowid FROM charge AS c
         WHERE c.rowid >= ?1 AND c.rowid < ?2 AND c.usage_day < ?3 AND NOT ${CHARGE_KEPT})`,
    ],
    tooNew: "usage_day >= ?3",
    params: [cutoffDay],
  };
}

/**
 * Session rows past the window, once settled (or left as an estimate), with no
 * open work and no charges left: the charges go first, and a session that
 * still has one keeps its row, which settlement and corrections read. `?3` is
 * the first moment kept.
 */
function sessionWalk(cutoffMs: number): Walk {
  return {
    table: "session",
    work: [
      `DELETE FROM session WHERE rowid IN (
         SELECT s.rowid FROM session AS s
         WHERE s.rowid >= ?1 AND s.rowid < ?2 AND s.started_at < ?3 AND s.settlement != 'open'
           AND NOT EXISTS (SELECT 1 FROM open_work AS w
                           WHERE w.owner_type = 'session' AND w.owner_id = s.id AND w.gave_up_at IS NULL)
           AND NOT EXISTS (SELECT 1 FROM charge AS c WHERE c.owner_type = 'session' AND c.owner_id = s.id))`,
    ],
    tooNew: "started_at >= ?3",
    params: [cutoffMs],
  };
}

/**
 * Budget totals past the window. Budgets read only the current UTC month, so
 * an old day is never read again. A late correction for an old day writes a
 * new row with only its difference; the walk deletes it in its turn.
 */
function budgetWalk(cutoffDay: string): Walk {
  return {
    table: "budget_day",
    work: ["DELETE FROM budget_day WHERE rowid >= ?1 AND rowid < ?2 AND day < ?3"],
    tooNew: "day >= ?3",
    params: [cutoffDay],
  };
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
 * Day rollups of whole months past the window, moved into their month rows.
 * `?3` is the first day of the first month kept, so a month is moved only
 * once every day of it is past the window. Moving and deleting are one
 * transaction, so a day is always in exactly one of the two tables. The
 * upsert adds: a chunk can hold some of a month's days and the next chunk the
 * rest.
 */
function foldWalk(firstKeptDay: string): Walk {
  const sums = ROLLUP_SUMS.join(", ");
  return {
    table: "usage_day",
    work: [
      `INSERT INTO usage_month (account_id, app_id, month, provider_type, provider_connection_id, model, outcome, unit, ${sums})
       SELECT account_id, app_id, substr(day, 1, 7), provider_type, provider_connection_id, model, outcome, unit,
              ${ROLLUP_SUMS.map((column) => `SUM(${column})`).join(", ")}
       FROM usage_day
       WHERE rowid >= ?1 AND rowid < ?2 AND day < ?3
       GROUP BY account_id, app_id, substr(day, 1, 7), provider_type, provider_connection_id, model, outcome, unit
       ON CONFLICT (account_id, app_id, month, provider_type, provider_connection_id, model, outcome, unit) DO UPDATE SET
         ${ROLLUP_SUMS.map((column) => `${column} = ${column} + excluded.${column}`).join(",\n         ")}`,
      "DELETE FROM usage_day WHERE rowid >= ?1 AND rowid < ?2 AND day < ?3",
    ],
    tooNew: "day >= ?3",
    params: [firstKeptDay],
  };
}

/** The first day of the month of `now - days`: every day before it is in a month wholly past the window. */
function firstKeptMonthDay(now: number, days: number): string {
  return `${dayBefore(now, days).slice(0, 7)}-01`;
}

/**
 * Statements held back for the passes after the charges, so a large charge
 * backlog cannot starve them: one chunk each, plus its start.
 */
const SESSION_RESERVE = START_STATEMENTS + 3;
const BUDGET_RESERVE = START_STATEMENTS + 3;
const FOLD_RESERVE = START_STATEMENTS + 4;

export interface UsageRetentionResult {
  gaveUpWork: number | null;
  charges: WalkResult | null;
  sessions: WalkResult | null;
  budgetDays: WalkResult | null;
  months: WalkResult | null;
}

/** Runs one pass and logs what it did; a failure is logged and leaves the passes after it to run. */
async function pass<T>(name: string, run: () => Promise<T>, facts: (value: T) => Record<string, unknown>): Promise<T | null> {
  try {
    const value = await run();
    log("info", `usage_retention_${name}`, facts(value));
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
 * Every usage retention pass, within `budget`. Each pass reports under its own
 * code, and a failure in one leaves the others to run.
 */
export async function runUsageRetention(
  db: D1Database,
  now: number,
  budget: QueryBudget,
  chunkRows: number = CHUNK_ROWS,
): Promise<UsageRetentionResult> {
  const detailDay = dayBefore(now, USAGE_DETAIL_RETENTION_DAYS);
  const detailMs = now - USAGE_DETAIL_RETENTION_DAYS * DAY_MS;
  const view = (share: QueryBudget) => share.database(db);

  // First: one statement, and it frees the charges whose work was given up long ago.
  const gaveUpWork = budget.affords(1)
    ? await pass(
        "gave_up_work",
        async () =>
          (
            await view(budget)
              .prepare("DELETE FROM open_work WHERE gave_up_at IS NOT NULL AND gave_up_at < ?")
              .bind(now - GAVE_UP_WORK_RETENTION_DAYS * DAY_MS)
              .run()
          ).meta.changes ?? 0,
        (deleted) => ({ deleted, retentionDays: GAVE_UP_WORK_RETENTION_DAYS }),
      )
    : null;

  const reserve = SESSION_RESERVE + BUDGET_RESERVE + FOLD_RESERVE;
  const walkFacts = (result: WalkResult) => ({ ...result });
  const charges = await pass(
    "charges",
    async () => {
      const share = budget.limited(Math.max(0, budget.remaining - reserve));
      return walk(view(share), chargeWalk(detailDay), share, chunkRows);
    },
    walkFacts,
  );
  const sessions = await pass(
    "sessions",
    async () => {
      const share = budget.limited(Math.max(0, budget.remaining - BUDGET_RESERVE - FOLD_RESERVE));
      return walk(view(share), sessionWalk(detailMs), share, chunkRows);
    },
    walkFacts,
  );
  const budgetDays = await pass(
    "budget_days",
    async () => {
      const share = budget.limited(Math.max(0, budget.remaining - FOLD_RESERVE));
      return walk(view(share), budgetWalk(detailDay), share, chunkRows);
    },
    walkFacts,
  );
  const months = await pass(
    "months",
    async () => walk(view(budget), foldWalk(firstKeptMonthDay(now, USAGE_DAY_RETENTION_DAYS)), budget, chunkRows),
    walkFacts,
  );
  return { gaveUpWork, charges, sessions, budgetDays, months };
}

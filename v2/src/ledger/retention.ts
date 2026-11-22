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
 * Charges go by owner (a call, a job or a session). An owner stops taking
 * bookings 60 days after its last charge, once it has no open work and is no
 * open session (`./freeze.ts`): no correction, and no open work that would
 * make it live again. Retention deletes it only at 90 days, by the same rule,
 * so nothing is ever booked against an owner retention has started on. Its
 * charges are then deleted in two plain, bounded passes: its corrections
 * first, then the rest once no correction is left. A correction always has
 * its charge's owner and usage date, and a session's total is a correction of
 * the session, so a reader between chunks never sees a charge's correction
 * without the charge.
 *
 * Between chunks, a reader of per-user detail may still see a partial total
 * for such an owner: an estimate without its settlement, or, for an owner with
 * several corrections (a pricing correction of +100 and a settlement of -80),
 * one of them without the other, even a negative cost. Only for months already
 * past the 90 days usage per user is kept, as documented. The day and month
 * rollups are never touched by deleting charges.
 *
 * Every pass picks its rows straight from its rule, through an index, a chunk
 * at a time, taking turns with the nightly run's other passes
 * (`../core/chunked-delete.ts`). A row kept back is never picked, so it never
 * holds up the rows after it, and nothing is saved between runs.
 */
import { log } from "../core/log.ts";
import { CHUNK_ROWS, deletePass, ROW_WRITES, runPasses, type ChunkedDeleteResult, type Deletable, type Pass } from "../core/chunked-delete.ts";
import type { QueryBudget } from "../core/query-budget.ts";
import { ownerLiveSql } from "./freeze.ts";

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

/** The first usage day still inside the window at `now`: a charge dated before it is past the window. */
export function detailCutoffDay(now: number): string {
  return dayBefore(now, USAGE_DETAIL_RETENTION_DAYS);
}

/**
 * Whether charge `c`'s owner may go: no longer live at `?1`, the retention
 * cutoff (`./freeze.ts`, the same rule bookings use, 30 days earlier).
 */
const FROZEN_OWNER = `NOT ${ownerLiveSql("c.owner_type", "c.owner_id", "?1")}`;

/** Corrections dated before `?1` of frozen owners. Served by `charge_correction_day`. */
function oldCorrections(cutoffDay: string): Deletable {
  return {
    table: "charge",
    rowids: `SELECT c.rowid FROM charge AS c
      WHERE c.kind = 'correction' AND c.usage_day < ?1
        AND ${FROZEN_OWNER}`,
    params: [cutoffDay],
  };
}

/**
 * Charges other than corrections, dated before `?1`, of frozen owners with no
 * correction left: an owner's corrections always go first. Served by
 * `charge_usage_day`, and `charge_owner` for the checks.
 */
function oldOriginals(cutoffDay: string): Deletable {
  return {
    table: "charge",
    rowids: `SELECT c.rowid FROM charge AS c
      WHERE c.usage_day < ?1 AND c.kind != 'correction'
        AND ${FROZEN_OWNER}
        AND NOT EXISTS (SELECT 1 FROM charge AS z
                        WHERE z.owner_type = c.owner_type AND z.owner_id = c.owner_id AND z.kind = 'correction')`,
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

/** The fold's three statements: look for totals near the integer limit, add the chunk to its month rows, delete it. */
const FOLD_STATEMENTS = 3;

/**
 * The key of a month row: the day rollup's key, with the month for the day.
 * The month row names the account; the day rollup's key does not, as an app id
 * is unique across accounts (its name plus a random suffix, `newAppId`). Two
 * accounts could only share a day row if one deleted an app and another made
 * one with the same name and the same random suffix, on a day the old app
 * still had charges: about one chance in two billion. A v1 import must keep
 * app ids unique across accounts for the same reason.
 */
const MONTH_KEY = ["account_id", "app_id", "month", "provider_type", "provider_connection_id", "model", "outcome", "unit"] as const;

/**
 * Where a total stops being summed exactly: 2^62, half of SQLite's largest
 * integer. Far beyond any real usage (4.6 billion dollars in nano-dollars for
 * one key in one month), but well short of the limit, so a sum of values
 * below it, with any partial sum on the way, can never overflow.
 */
const LARGE_TOTAL = "4611686018427387904.0";
const INT_MAX = "9223372036854775807";
const INT_MIN = "(-9223372036854775807 - 1)";

/**
 * The fold's statements. `?1` and `?2` are {@link FOLD_PICK}'s.
 *
 * SQLite's `SUM` stops the whole statement with an error once a sum passes
 * its largest integer, which would leave every month after it unmoved, night
 * after night. That is never worth it for a total no one can reach, so:
 *
 * - a key whose chunk adds up to {@link LARGE_TOTAL} or more, counted with
 *   `total()` over absolute values (a float sum that never fails), is added as
 *   that float sum cast to an integer, which stops at the largest integer;
 * - every other key is summed exactly, as before;
 * - adding to a month row that is already there stops at the largest (or
 *   smallest) integer instead of failing: SQLite turns an integer sum that
 *   overflows into a float, `min`/`max` bring it back in range, and the cast
 *   makes it an integer again (the column accepts integers only).
 *
 * The first statement counts the keys this chunk takes near the limit, so the
 * run can warn about it.
 */
function foldStatements(db: D1Database) {
  const sums = ROLLUP_SUMS.join(", ");
  const key = MONTH_KEY.join(", ");
  const chunk = `chunk AS (
    SELECT account_id, app_id, substr(day, 1, 7) AS month, provider_type, provider_connection_id, model, outcome, unit, ${sums}
    FROM usage_day WHERE rowid IN (${FOLD_PICK}))`;
  // `* 1.0` first: `abs` of SQLite's smallest integer is an error, of a float never.
  const sizes = `sizes AS (
    SELECT ${key}, ${ROLLUP_SUMS.map((column) => `total(abs(${column} * 1.0)) AS ${column}`).join(", ")}
    FROM chunk GROUP BY ${key})`;
  const large = (size: (column: string) => string) => `max(${ROLLUP_SUMS.map(size).join(", ")}) >= ${LARGE_TOTAL}`;
  const detect = db.prepare(
    `WITH ${chunk}, ${sizes}
     SELECT COUNT(*) AS large FROM sizes AS s LEFT JOIN usage_month AS m USING (${key})
     WHERE ${large((column) => `s.${column} + abs(coalesce(m.${column}, 0) * 1.0)`)}`,
  );
  const add = db.prepare(
    `WITH ${chunk}, ${sizes},
       big AS (SELECT ${key} FROM sizes WHERE ${large((column) => column)})
     INSERT INTO usage_month (${key}, ${sums})
     SELECT * FROM (
       SELECT ${key}, ${ROLLUP_SUMS.map((column) => `SUM(${column})`).join(", ")}
       FROM chunk WHERE (${key}) NOT IN (SELECT ${key} FROM big) GROUP BY ${key}
       UNION ALL
       SELECT ${key}, ${ROLLUP_SUMS.map((column) => `CAST(total(${column}) AS INTEGER)`).join(", ")}
       FROM chunk WHERE (${key}) IN (SELECT ${key} FROM big) GROUP BY ${key}
     ) WHERE true
     ON CONFLICT (${key}) DO UPDATE SET
       ${ROLLUP_SUMS.map((column) => `${column} = CAST(max(min(${column} + excluded.${column}, ${INT_MAX}), ${INT_MIN}) AS INTEGER)`).join(",\n       ")}`,
  );
  const remove = db.prepare(`DELETE FROM usage_day WHERE rowid IN (${FOLD_PICK})`);
  return { detect, add, remove };
}

/**
 * Moves day rollups of whole months past the window into their month rows, a
 * chunk per turn. `firstKeptDay` is the first day kept as a day rollup.
 *
 * A chunk is one batch, so one transaction: its days are added to their
 * month rows and deleted together, and a day is always in exactly one of the
 * two tables. The month rows add, rather than replace, so a month may move
 * over several chunks or nights, and a day rollup written late (a late
 * correction of an old charge) joins its month on a later night. A month's
 * total is always its `usage_month` row plus whatever of that month is still
 * in `usage_day`.
 */
function foldMonthsPass(firstKeptDay: string): Pass {
  let largeKeys = 0;
  return {
    name: "usage_retention_months",
    statements: FOLD_STATEMENTS,
    // Each day row deleted, and at most one month row written for it.
    rowWrites: ROW_WRITES.usage_day + ROW_WRITES.usage_month,
    async chunk(db, rows) {
      const { detect, add, remove } = foldStatements(db);
      const [found, , removed] = await db.batch([
        detect.bind(firstKeptDay, rows),
        add.bind(firstKeptDay, rows),
        remove.bind(firstKeptDay, rows),
      ]);
      largeKeys += Number((found?.results[0] as { large?: number } | undefined)?.large ?? 0);
      return removed?.meta.changes ?? 0;
    },
    finish() {
      // Once a run, so the monitor alerts: these totals may no longer be exact.
      if (largeKeys > 0) log("warn", "usage_month_total_too_large", { keys: largeKeys });
    },
  };
}

/** The first day of the month of `now - days`: every day before it is in a month wholly past the window. */
function firstKeptMonthDay(now: number, days: number): string {
  return `${dayBefore(now, days).slice(0, 7)}-01`;
}

/** The rows each delete pass picks at `now`, in the order the passes run. */
export function usageRetentionRules(now: number) {
  const detailDay = detailCutoffDay(now);
  return {
    gaveUpWork: gaveUpWork(now - GAVE_UP_WORK_RETENTION_DAYS * DAY_MS),
    corrections: oldCorrections(detailDay),
    charges: oldOriginals(detailDay),
    sessions: oldSessions(now - USAGE_DETAIL_RETENTION_DAYS * DAY_MS),
    budgetDays: oldBudgetDays(detailDay),
  } as const;
}

/**
 * The usage retention passes at `now`, in the order they take their turns:
 * open work given up long ago first (given-up work holds no charge back, so
 * this order is only tidiness); corrections before the charges they correct;
 * the charges before the sessions they belong to.
 */
export function usageRetentionPasses(now: number): Pass[] {
  const rules = usageRetentionRules(now);
  return [
    deletePass("usage_retention_gave_up_work", rules.gaveUpWork),
    deletePass("usage_retention_corrections", rules.corrections),
    deletePass("usage_retention_charges", rules.charges),
    deletePass("usage_retention_sessions", rules.sessions),
    deletePass("usage_retention_budget_days", rules.budgetDays),
    foldMonthsPass(firstKeptMonthDay(now, USAGE_DAY_RETENTION_DAYS)),
  ];
}

export interface UsageRetentionResult {
  gaveUpWork: ChunkedDeleteResult | null;
  corrections: ChunkedDeleteResult | null;
  charges: ChunkedDeleteResult | null;
  sessions: ChunkedDeleteResult | null;
  budgetDays: ChunkedDeleteResult | null;
  months: ChunkedDeleteResult | null;
}

/**
 * The usage retention passes on their own, within `statements` and
 * `rowLimit`. The nightly run runs them with the other passes instead
 * (`../maintenance/nightly.ts`).
 */
export async function runUsageRetention(
  db: D1Database,
  now: number,
  statements: QueryBudget,
  chunkRows: number = CHUNK_ROWS,
  rowLimit: number = Number.MAX_SAFE_INTEGER,
): Promise<UsageRetentionResult> {
  const results = await runPasses(db, statements, rowLimit, usageRetentionPasses(now), chunkRows);
  const of = (name: string) => results.get(`usage_retention_${name}`) ?? null;
  return {
    gaveUpWork: of("gave_up_work"),
    corrections: of("corrections"),
    charges: of("charges"),
    sessions: of("sessions"),
    budgetDays: of("budget_days"),
    months: of("months"),
  };
}

/** Statements {@link warnStuckSessions} issues. */
export const STUCK_SESSION_STATEMENTS = 1;

/**
 * Sessions started before the window that are still open with no open work
 * left: their settlement gave up (a D1 error on its last try, say), so their
 * row and slices are kept for good. Nothing is lost, but the monitor should
 * know: one `warn` with the count. Served by `session_started`.
 */
export async function warnStuckSessions(db: D1Database, now: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM session AS s
        WHERE s.started_at < ? AND s.settlement = 'open'
          AND NOT EXISTS (SELECT 1 FROM open_work AS w
                          WHERE w.owner_type = 'session' AND w.owner_id = s.id AND w.gave_up_at IS NULL)`,
    )
    .bind(now - USAGE_DETAIL_RETENTION_DAYS * DAY_MS)
    .first<{ n: number }>();
  const stuck = Number(row?.n ?? 0);
  if (stuck > 0) log("warn", "ledger_sessions_stuck_open", { sessions: stuck });
  return stuck;
}

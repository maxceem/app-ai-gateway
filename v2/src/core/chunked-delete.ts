/**
 * The nightly maintenance's passes, each deleting (or moving) old rows a
 * bounded chunk at a time, run in turns within two budgets.
 *
 * A pass's chunk picks at most a chunk of rows straight from the rule that
 * makes a row deletable, and deletes them. So:
 *
 * - no statement deletes more than a chunk, and a large backlog never makes
 *   one statement run into D1's time limit;
 * - a row kept back (by open work, say) is simply never picked, so it cannot
 *   hold up the rows after it;
 * - nothing is saved between runs: the next run picks up whatever is left.
 *
 * The passes take turns: each round gives every pass that has not caught up
 * one chunk, and rounds repeat until all have caught up or a budget runs out.
 * So a large backlog in one pass never keeps the others from running: every
 * pass gets its chunk in the first round. There are two budgets, both checked
 * before each chunk:
 *
 * - **statements** (`QueryBudget`): D1 allows a Worker invocation only so
 *   many queries;
 * - **rows written**: D1 counts every row a statement writes, each index
 *   entry included, and the Workers Free plan allows 100,000 a day for the
 *   whole account. The nightly run keeps to a small part of that, so the apps'
 *   own requests always have the rest. Within a round, each pass may use an
 *   equal part of the rows left for the passes still to go, and what one pass
 *   does not use is left to the passes after it.
 *
 * A pass has caught up only when a chunk finds nothing to delete. A short
 * chunk is not enough: another pass's deletes can make more of its rows
 * deletable (deleting a charge frees its corrections), so it gets another
 * turn in a later round, or the next night.
 *
 * When a budget runs out, the run warns with one `maintenance_backlog_left`,
 * naming the passes whose last chunk was full (or that never got one): those
 * very likely have rows left. A pass whose last chunk was short is very likely
 * done, and is not named. A pass that fails is logged and drops out; the
 * others go on.
 *
 * The rule's query must be served by an index, so a chunk costs about what it
 * deletes, and a night with nothing to delete costs one short index read.
 */
import { errorFacts } from "./error-facts.ts";
import { log } from "./log.ts";
import { QueryBudgetExhausted, type QueryBudget } from "./query-budget.ts";

/**
 * Rows per statement at most, as v1: about a second of D1's single write
 * lock. The only writes it holds up are ledger inserts, which run after the
 * response.
 */
export const CHUNK_ROWS = 5_000;

/**
 * Rows D1 counts as written when one row of a table is deleted: the row
 * itself and one entry in each of the table's indexes (`sqlite_autoindex_*`
 * of a text primary key included). A test checks each against the schema.
 */
export const ROW_WRITES = {
  // An upper bound: 5 for most rows; a sign-in that closed a claim wait has one
  // more, in `app_auth_event_claim_delay`.
  app_auth_event: 6,
  app_rejection_event: 5,
  // An upper bound: 5 for a given-up row; one more for a row still being tried, in `open_work_due_pending`.
  open_work: 6,
  // 9 for most charges; a correction has one more, in `charge_correction_day`.
  charge: 10,
  session: 4,
  budget_day: 3,
  usage_day: 4,
  usage_month: 3,
} as const;

export type MaintainedTable = keyof typeof ROW_WRITES;

/** The rows to delete: `SELECT rowid FROM <table> ... WHERE ...`, with its parameters. */
export interface Deletable {
  readonly table: MaintainedTable;
  readonly rowids: string;
  readonly params: readonly (string | number)[];
}

/** One kind of old row the nightly run deletes, a chunk at a time. */
export interface Pass {
  /** Names the pass in logs; a failure is logged as `<name>_failed`. */
  readonly name: string;
  /** Statements one chunk issues. */
  readonly statements: number;
  /** Rows D1 counts as written for each row a chunk handles. */
  readonly rowWrites: number;
  /** Handles at most `rows` rows (at least one), through `db`, and says how many it handled. */
  chunk(db: D1Database, rows: number): Promise<number>;
  /** Called once when the run is over, whatever became of the pass. */
  finish?(): void;
}

export interface ChunkedDeleteResult {
  chunks: number;
  deleted: number;
  /** Whether a chunk found nothing to delete, rather than a budget running out first. */
  caughtUp: boolean;
  /** Whether the last chunk handled every row it asked for: rows are very likely left. Null before the first chunk. */
  lastFull: boolean | null;
}

/** A pass deleting the rows `spec` picks, one statement a chunk. */
export function deletePass(name: string, spec: Deletable): Pass {
  return {
    name,
    statements: 1,
    rowWrites: ROW_WRITES[spec.table],
    async chunk(db, rows) {
      const statement = db.prepare(`DELETE FROM ${spec.table} WHERE rowid IN (${spec.rowids} LIMIT ?)`);
      return (await statement.bind(...spec.params, rows).run()).meta.changes ?? 0;
    },
  };
}

/**
 * Runs `passes` in turns until each has caught up or a budget runs out.
 * `statements` is charged for every statement; `rowLimit` is the rows the run
 * may write. Never throws. Returns each pass's result by name, or null where
 * it failed.
 */
export async function runPasses(
  db: D1Database,
  statements: QueryBudget,
  rowLimit: number,
  passes: readonly Pass[],
  chunkRows: number = CHUNK_ROWS,
): Promise<Map<string, ChunkedDeleteResult | null>> {
  const counted = statements.database(db);
  const results = new Map<string, ChunkedDeleteResult | null>(
    passes.map((pass) => [pass.name, { chunks: 0, deleted: 0, caughtUp: false, lastFull: null }]),
  );
  let rowsLeft = rowLimit;
  let active = [...passes];
  while (active.length > 0) {
    const next: Pass[] = [];
    let ran = false;
    for (const [index, pass] of active.entries()) {
      const result = results.get(pass.name)!;
      // An equal part of what is left for the passes still to go this round.
      const share = Math.floor(rowsLeft / (active.length - index));
      const rows = Math.min(chunkRows, Math.floor(share / pass.rowWrites));
      if (rows < 1 || !statements.affords(pass.statements)) {
        // Not this round; a later one may have more for it, once others are done.
        next.push(pass);
        continue;
      }
      ran = true;
      try {
        const handled = await pass.chunk(counted, rows);
        result.chunks += 1;
        result.deleted += handled;
        rowsLeft -= handled * pass.rowWrites;
        result.lastFull = handled >= rows;
        if (handled === 0) result.caughtUp = true;
        else next.push(pass);
      } catch (error) {
        if (error instanceof QueryBudgetExhausted) continue; // Left as backlog.
        log("warn", `${pass.name}_failed`, { error: errorFacts(error) });
        results.set(pass.name, null);
      }
    }
    active = next;
    // A round in which no pass could afford a chunk: the budgets are spent.
    if (!ran) break;
  }
  const left: string[] = [];
  for (const pass of passes) {
    pass.finish?.();
    const result = results.get(pass.name);
    if (result === null || result === undefined) continue;
    log("info", "maintenance_pass", { pass: pass.name, ...result });
    // A short last chunk: very likely done, so no alarm for it.
    if (!result.caughtUp && result.lastFull !== false) left.push(pass.name);
  }
  if (left.length > 0) {
    // So the monitor alerts: rows past their retention are still there, and will be until a night with room.
    log("warn", "maintenance_backlog_left", {
      passes: left,
      statementLimit: statements.limit,
      rowLimit,
    });
  }
  return results;
}

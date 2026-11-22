/**
 * Deleting old rows a bounded chunk at a time, for the nightly maintenance.
 *
 * Each statement picks at most one chunk of rows straight from the rule that
 * makes a row deletable, and deletes them. So:
 *
 * - no statement deletes more than a chunk, and a large backlog never makes
 *   one statement run into D1's time limit;
 * - a row kept back (by open work, say) is simply never picked, so it cannot
 *   hold up the rows after it;
 * - nothing is saved between runs: the next run picks up whatever is left.
 *
 * The rule's query must be served by an index, so a chunk costs about what it
 * deletes, and a night with nothing to delete costs one short index read.
 */
import type { QueryBudget } from "./query-budget.ts";

/**
 * Rows per statement, as v1: about a second of D1's single write lock. The
 * only writes it holds up are ledger inserts, which run after the response.
 */
export const CHUNK_ROWS = 5_000;

/** The rows to delete: `SELECT rowid FROM <table> ... WHERE ...`, with its parameters. */
export interface Deletable {
  readonly table: string;
  readonly rowids: string;
  readonly params: readonly (string | number)[];
}

export interface ChunkedDeleteResult {
  chunks: number;
  deleted: number;
  /** Whether no deletable row is left, rather than the budget running out first. */
  caughtUp: boolean;
}

/**
 * Deletes the rows `spec` picks, a chunk per statement, while `budget` lasts.
 * `db` must charge `budget` (`budget.database(...)`). Stops once a chunk
 * deletes fewer rows than a full chunk: then none is left.
 */
export async function deleteInChunks(
  db: D1Database,
  budget: QueryBudget,
  spec: Deletable,
  chunkRows: number = CHUNK_ROWS,
): Promise<ChunkedDeleteResult> {
  const result: ChunkedDeleteResult = { chunks: 0, deleted: 0, caughtUp: false };
  const statement = db.prepare(`DELETE FROM ${spec.table} WHERE rowid IN (${spec.rowids} LIMIT ?)`);
  while (budget.affords(1)) {
    const deleted = (await statement.bind(...spec.params, chunkRows).run()).meta.changes ?? 0;
    result.chunks += 1;
    result.deleted += deleted;
    if (deleted < chunkRows) {
      result.caughtUp = true;
      break;
    }
  }
  return result;
}

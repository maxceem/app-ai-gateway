/**
 * The account's ledger with D1's shape (plan section 8, step 8f): `prepare`,
 * `bind`, `first`, `all`, `run`, `raw` and `batch`, over the SQLite database
 * of the account's ledger object (`../do/AccountLedger.ts`). So the ledger
 * code and its tests, written for D1, carry over unchanged: they are handed
 * this instead of `env.DB`.
 *
 * - `ledgerDb(env, accountId)` sends each statement, or each batch, to the
 *   account's object in one call.
 * - `runLedgerStatements` runs them inside the object, a batch in one
 *   `transactionSync`, as D1 runs a batch in one transaction.
 *
 * Bound values follow D1: `undefined` is refused, a boolean is stored as 1 or
 * 0. `meta.changes` is the rows the statement wrote, the trigger's writes
 * included, as D1 counts them.
 */

import { withDeadline } from "../core/background.ts";
import { serviceUnavailable } from "../core/platform-errors.ts";

/** One statement as it travels to the object: its SQL and its bound values. */
export interface LedgerStatement {
  readonly sql: string;
  readonly params: readonly (string | number | null | ArrayBuffer)[];
}

/** What the object answers for one statement. */
export interface LedgerResult {
  /** Each row's values in column order, so two columns of one name both come through `raw`. */
  readonly values: unknown[][];
  readonly columns: string[];
  readonly changes: number;
  readonly rowsRead: number;
}

/** Runs statements: one by one, or as one transaction. */
export type LedgerRunner = (statements: readonly LedgerStatement[], transaction: boolean) => Promise<LedgerResult[]>;

/** The places a Durable Object may be asked to start in. */
const LOCATION_HINTS: ReadonlySet<string> = new Set(["wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"]);

/**
 * Where new ledger objects start: `LEDGER_LOCATION_HINT`, set on the hosted
 * deployment (`enam`, beside its D1) and unset for self-hosters, whose objects
 * start near their first request. A value Cloudflare does not know is ignored.
 */
export function ledgerLocationHint(env: Env): DurableObjectLocationHint | undefined {
  const hint = (env as { LEDGER_LOCATION_HINT?: unknown }).LEDGER_LOCATION_HINT;
  return typeof hint === "string" && LOCATION_HINTS.has(hint) ? (hint as DurableObjectLocationHint) : undefined;
}

/** The account's ledger object. An account's history lives only there (D21). */
export function ledgerObject(env: Env, accountId: string): DurableObjectStub<import("../do/AccountLedger.ts").AccountLedger> {
  const namespace = env.ACCOUNT_LEDGER;
  const hint = ledgerLocationHint(env);
  const id = namespace.idFromName(accountId);
  return hint === undefined ? namespace.get(id) : namespace.get(id, { locationHint: hint });
}

/**
 * How long one call to an account's ledger object may take, by default
 * (plan, step 8f: every call that crosses to another store has a deadline).
 * Past it the call rejects like any other failure, so the caller's fallback
 * and its warning run. A caller that needs another limit passes `deadlineMs`.
 */
export const LEDGER_CALL_DEADLINE_MS = 10_000;

/** The account's ledger, with D1's shape. Each statement or batch is one call to the object, through a fresh stub, under its deadline. */
export function ledgerDb(env: Env, accountId: string, options: { readonly deadlineMs?: number } = {}): D1Database {
  const deadlineMs = options.deadlineMs ?? LEDGER_CALL_DEADLINE_MS;
  // A fresh stub for every call: a stub broken by one failure stays broken, so a retry needs a new one.
  return shapedLikeD1((statements, transaction) =>
    withDeadline(ledgerObject(env, accountId).query(statements as LedgerStatement[], transaction), deadlineMs, "calling the account's ledger", ledgerTooSlow),
  );
}

/** A ledger call past its deadline: the route deadline's own error, so a route answers 503 `deadline_exceeded` with Retry-After. */
function ledgerTooSlow(message: string): Error {
  return serviceUnavailable("deadline_exceeded", "The gateway took too long to answer; retry shortly", new Error(message));
}

/** Runs statements on an object's own database. A transaction is one `transactionSync`. */
export function runLedgerStatements(storage: DurableObjectStorage, statements: readonly LedgerStatement[], transaction: boolean): LedgerResult[] {
  const one = (statement: LedgerStatement): LedgerResult => {
    const cursor = storage.sql.exec(statement.sql, ...statement.params);
    const values = [...cursor.raw()] as unknown[][];
    return { values, columns: cursor.columnNames, changes: cursor.rowsWritten, rowsRead: cursor.rowsRead };
  };
  return transaction ? storage.transactionSync(() => statements.map(one)) : statements.map(one);
}

/** A database with D1's shape whose statements `run` executes. */
export function shapedLikeD1(run: LedgerRunner): D1Database {
  const prepare = (sql: string): D1PreparedStatement => new Statement(run, sql, []) as unknown as D1PreparedStatement;
  const database = {
    prepare,
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      if (statements.length === 0) return [];
      const sent = statements.map((statement) => (statement as unknown as Statement).sent());
      const results = await run(sent, true);
      return results.map((result) => d1Result<T>(result));
    },
    async exec(): Promise<D1ExecResult> {
      throw new Error("The ledger takes prepared statements only");
    },
    withSession(): D1DatabaseSession {
      throw new Error("The ledger has no sessions");
    },
    async dump(): Promise<ArrayBuffer> {
      throw new Error("The ledger cannot be dumped");
    },
  };
  return database as unknown as D1Database;
}

/** Rows as objects, as D1 answers them: of two columns with one name, the last wins. */
function rowsOf(result: LedgerResult): Record<string, unknown>[] {
  return result.values.map((values) => Object.fromEntries(result.columns.map((column, index) => [column, values[index]])));
}

function d1Result<T>(result: LedgerResult): D1Result<T> {
  return {
    results: rowsOf(result) as T[],
    success: true,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: result.rowsRead,
      rows_written: result.changes,
      last_row_id: 0,
      changed_db: result.changes > 0,
      changes: result.changes,
    },
  } as D1Result<T>;
}

type Bound = string | number | null | ArrayBuffer;

function bound(value: unknown, index: number): Bound {
  if (value === undefined) throw new TypeError(`D1_TYPE_ERROR: Type 'undefined' not supported for value at index ${index}`);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === null || typeof value === "string" || typeof value === "number" || value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  throw new TypeError(`D1_TYPE_ERROR: Type '${typeof value}' not supported for value at index ${index}`);
}

class Statement {
  constructor(
    private readonly runner: LedgerRunner,
    private readonly sql: string,
    private readonly params: readonly Bound[],
  ) {}

  bind(...values: unknown[]): Statement {
    return new Statement(this.runner, this.sql, values.map(bound));
  }

  sent(): LedgerStatement {
    return { sql: this.sql, params: this.params };
  }

  private async one(): Promise<LedgerResult> {
    const [result] = await this.runner([this.sent()], false);
    return result!;
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = rowsOf(await this.one())[0];
    if (row === undefined) return null;
    if (column === undefined) return row as T;
    if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
    return (row[column] ?? null) as T | null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return d1Result<T>(await this.one());
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return d1Result<T>(await this.one());
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const result = await this.one();
    const rows = result.values as T[];
    return options?.columnNames === true ? [result.columns as T, ...rows] : rows;
  }
}

import { getTableColumns, sql, type InferInsertModel, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { SQLiteAsyncDialect, type BaseSQLiteDatabase, type SQLiteTable } from "drizzle-orm/sqlite-core";

/**
 * Statements that carry a guard are composed as drizzle `sql` templates, so
 * every parameter is bound where its value appears and a composed statement
 * cannot pair a placeholder with the wrong value. `sql.raw` is only for
 * constant trusted text — identifiers and keywords — never for a value.
 *
 * A template value must never be `undefined`: drizzle renders it as empty
 * text rather than a bound parameter. Pass `null` for an absent value.
 */

const dialect = new SQLiteAsyncDialect();

/** A composed statement as D1 takes it: SQLite text and its parameters in order. */
export function compileSql(chunk: SQL): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(chunk);
  return { sql: query.sql, params: query.params };
}

/**
 * A composed statement as a D1 prepared statement, which is how it joins a
 * batch beside statements that are already prepared.
 */
export function prepared(d1: D1Database, chunk: SQL): D1PreparedStatement {
  const query = compileSql(chunk);
  return d1.prepare(query.sql).bind(...query.params);
}

/**
 * Turns a condition cf-auth hands over already compiled —
 * `credentialAuthorityCondition` returns SQLite text with `?` placeholders
 * plus its parameters — back into a template, so it composes like any other.
 *
 * This is the seam for cf-auth's compiled form and for nothing else: a
 * condition written in this project is a template from the start. cf-auth
 * compiles through drizzle with every value bound, so a `?` in its text is
 * always a placeholder; a count that does not match is refused rather than
 * guessed at.
 */
export function fromCompiled(condition: { sql: string; params: unknown[] }): SQL {
  const segments = condition.sql.split("?");
  if (segments.length !== condition.params.length + 1) {
    throw new Error(
      `A compiled condition has ${segments.length - 1} placeholders for ${condition.params.length} parameters`,
    );
  }
  const chunk = sql.empty();
  segments.forEach((segment, index) => {
    chunk.append(sql.raw(segment));
    if (index < condition.params.length) chunk.append(sql`${condition.params[index]}`);
  });
  return chunk;
}

/**
 * One guarded write as a drizzle query builder: what a D1 batch can carry
 * beside other builders, and what cf-auth's operation engine takes into the
 * batch that completes an operation. D1's batch binds each item's parameters
 * through the statement its builder prepared, so a raw `db.run(sql)` with
 * parameters cannot join one.
 */
export type WriteStatement = BatchItem<"sqlite"> & { run(): Promise<D1Result> };

/**
 * An `INSERT ... SELECT ... WHERE <condition>` as a builder: the row is written
 * only if the condition holds when the statement runs, so the guard travels
 * with the write it protects.
 *
 * The same construction cf-auth exports as `guardedInsert`, kept here because
 * nothing but `src/auth/identity.ts` may load the library at runtime. The
 * columns are selected in the table's own order, which is the order drizzle
 * names them in; a column left out takes its default, or null.
 */
export function guardedInsert<Table extends SQLiteTable>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: BaseSQLiteDatabase<"async", any, any>,
  table: Table,
  values: Partial<InferInsertModel<Table>>,
  condition: SQL,
) {
  const columns = getTableColumns(table);
  for (const key of Object.keys(values)) {
    if (!Object.hasOwn(columns, key)) throw new Error(`guardedInsert: unknown column \`${key}\``);
  }
  const selected = Object.entries(columns).map(([key, column]) => {
    const value = (values as Record<string, unknown>)[key];
    if (value === undefined) {
      if (column.default === undefined) return sql`null`;
      return typeof column.default === "object" && column.default !== null && "getSQL" in column.default
        ? (column.default as SQL)
        : sql.param(column.default, column);
    }
    if (value === null) return sql`null`;
    // Through the column, so a Date, a boolean or a JSON value is stored
    // exactly as drizzle would store it from `.values()`.
    return sql.param(value, column);
  });
  return db.insert(table).select(sql`select ${sql.join(selected, sql`, `)} where ${condition}`);
}

import { sql, type SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";

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

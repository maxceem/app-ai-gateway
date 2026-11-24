/**
 * What a migration run writes, and the checks it runs before writing it.
 *
 * - The rows as SQL INSERT statements, one per row, for
 *   `wrangler d1 execute --file`. Plain INSERTs: a row that already exists
 *   stops the import instead of being overwritten, so the target must be an
 *   empty v2 database.
 * - Before that, the rows go into a fresh database built from v2's own
 *   migrations, here in memory. A row the v2 tables refuse stops the run.
 *   Then each moved app is judged by the console's save checks
 *   (`checkAppConfig`), against the moved connections. An app they refuse is
 *   still moved (it served in v1), and the report says why it would not save
 *   unchanged.
 * - The report, as Markdown for people and JSON for tools.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { checkAppConfig } from "../../src/admin/apps.ts";
import { TABLE_ORDER, type MigrationResult, type ReportLine, type Row, type V2Rows } from "./settings.ts";

/** A SQL literal for one value. */
function literal(value: Row[string]): string {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("a row holds a number SQL cannot write");
    return String(value);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

/** Every row as INSERT statements, table by table in `TABLE_ORDER`. */
export function insertStatements(rows: V2Rows): string[] {
  return TABLE_ORDER.flatMap((table) =>
    rows[table].map((row) => {
      const columns = Object.keys(row);
      return `INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map((column) => literal(row[column]!)).join(", ")});`;
    }),
  );
}

/** A fresh, empty v2 database, built from v2's migrations. */
export function emptyV2Database(migrationsDir: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }
  return db;
}

/** Just enough of D1 for the admin checks: `prepare().bind().first()` and `.all()`, read only. */
function d1Reader(db: DatabaseSync): D1Database {
  const statement = (sql: string, values: SQLInputValue[]) => ({
    bind: (...next: SQLInputValue[]) => statement(sql, next),
    first: async (column?: string) => {
      const row = db.prepare(sql).get(...values) as Record<string, unknown> | undefined;
      if (row === undefined) return null;
      return column === undefined ? row : row[column];
    },
    all: async () => ({ results: db.prepare(sql).all(...values), success: true, meta: {} }),
  });
  return { prepare: (sql: string) => statement(sql, []) } as unknown as D1Database;
}

/**
 * Writes the statements into a fresh v2 database, then judges every moved
 * app there. Throws when a row does not fit the v2 tables; returns the
 * report lines for apps v2's save checks would refuse.
 */
export async function checkAgainstV2(result: MigrationResult, statements: readonly string[], migrationsDir: string): Promise<ReportLine[]> {
  const db = emptyV2Database(migrationsDir);
  for (const sql of statements) {
    try {
      db.exec(sql);
    } catch (error) {
      throw new Error(`a row does not fit v2's tables (${(error as Error).message}): ${sql.slice(0, sql.indexOf(" VALUES"))}`, { cause: error });
    }
  }
  const lines: ReportLine[] = [];
  const reader = d1Reader(db);
  for (const [id, app] of result.apps) {
    try {
      await checkAppConfig(reader, app.accountId, app.config);
    } catch (error) {
      lines.push({
        kind: "check",
        subject: `app ${id}`,
        what: `Moved as it was, but the console would refuse to save it unchanged: ${(error as Error).message}. Its calls are served by v2's rules as they stand; fix it before its next edit.`,
      });
    }
  }
  db.close();
  return lines;
}

const HEADINGS: Record<ReportLine["kind"], string> = {
  left_out: "Not moved",
  changed: "Moved, but changed",
  check: "Moved, worth a look",
};

/** The report as Markdown: counts first, then each line by kind and subject. */
export function reportMarkdown(rows: V2Rows, report: readonly ReportLine[], moment: Date): string {
  const lines = [`# v1 to v2 settings migration`, "", `Run at ${moment.toISOString()}.`, "", "## Rows written", "", "| Table | Rows |", "| --- | --- |"];
  for (const table of TABLE_ORDER) lines.push(`| ${table} | ${rows[table].length} |`);
  for (const kind of ["left_out", "changed", "check"] as const) {
    const matching = report.filter((line) => line.kind === kind);
    lines.push("", `## ${HEADINGS[kind]} (${matching.length})`, "");
    if (matching.length === 0) lines.push("Nothing.");
    for (const line of [...matching].sort((a, b) => a.subject.localeCompare(b.subject))) lines.push(`- **${line.subject}:** ${line.what}`);
  }
  return `${lines.join("\n")}\n`;
}

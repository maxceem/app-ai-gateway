/**
 * The settings half of the v1-to-v2 migration (plan section 9.1). It reads a
 * v1 database export and writes the v2 rows as SQL, with a report of
 * everything left out or changed. It never connects to either deployment.
 *
 *   node --experimental-strip-types scripts/migrate-settings.ts \
 *     --from <v1 export.sql> --out <folder> \
 *     --v1-vault <file> --v2-vault <file> [--now <ISO time>]
 *
 * - `--from` is what `wrangler d1 export` writes for v1's database.
 * - `--v1-vault` and `--v2-vault` are each a file in the format of
 *   `.dev.vars` with that deployment's vault settings: `SECRET_VAULT_MODE`
 *   and its local keys or cf-kms settings. Provider keys and gateway tokens
 *   are opened with v1's and sealed with v2's, in memory only. Neither file
 *   is printed or copied.
 * - `--out` gets three files: `settings.sql` (readable by this user only:
 *   it holds sealed keys, password hashes and key hashes), `report.md` and
 *   `report.json`. Each is replaced if it is there.
 * - Before writing, every row is put into a fresh v2 database built from
 *   v2's migrations, so a row that does not fit stops the run here, not
 *   halfway through an import. Then each app is judged by the console's
 *   save checks; a refusal is a line in the report.
 *
 * Then, on an empty v2 database:
 *
 *   pnpm exec wrangler d1 execute DB --remote -c <config> --file <folder>/settings.sql
 *
 * The history half (usage, events, stored conversations) is step 13's.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkAgainstV2, insertStatements, reportMarkdown } from "./migrate/output.ts";
import { migrateSettings } from "./migrate/settings.ts";
import { loadV1Export, readV1Settings } from "./migrate/v1-rows.ts";
import { readVaultFile, vaultResealer } from "./migrate/vault.ts";

const USAGE = "usage: migrate-settings.ts --from <v1 export.sql> --out <folder> --v1-vault <file> --v2-vault <file> [--now <ISO time>]";

/** The v2 folder, where the migrations are. */
const V2_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
/** The folder the command was run in (`pnpm run` moves to the package's own; `INIT_CWD` keeps the caller's). */
const CALLER_DIR = process.env.INIT_CWD ?? process.cwd();

function stop(message: string): never {
  console.error(message);
  process.exit(1);
}

let values: Record<string, string | undefined>;
try {
  ({ values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== "--"),
    options: {
      from: { type: "string" },
      out: { type: "string" },
      "v1-vault": { type: "string" },
      "v2-vault": { type: "string" },
      now: { type: "string" },
    },
    strict: true,
  }) as { values: Record<string, string | undefined> });
} catch (error) {
  stop(`${(error as Error).message}\n${USAGE}`);
}
const from = values.from;
const out = values.out;
const v1VaultFile = values["v1-vault"];
const v2VaultFile = values["v2-vault"];
if (from === undefined || out === undefined || v1VaultFile === undefined || v2VaultFile === undefined) stop(USAGE);
const now = values.now === undefined ? new Date() : new Date(values.now);
if (Number.isNaN(now.getTime())) stop("--now: not a time");

const path = (value: string) => resolve(CALLER_DIR, value);
let reseal;
try {
  reseal = vaultResealer(readVaultFile(path(v1VaultFile)), readVaultFile(path(v2VaultFile)));
} catch (error) {
  // The vault's own messages name a setting, never its value.
  stop(`A vault file does not work: ${(error as Error).message}`);
}

let v1;
try {
  v1 = readV1Settings(loadV1Export(readFileSync(path(from), "utf8")));
} catch (error) {
  stop(`The v1 export does not load: ${(error as Error).message}`);
}
const result = await migrateSettings(v1, { now, reseal });
const statements = insertStatements(result.rows);
let judged;
try {
  judged = await checkAgainstV2(result, statements, join(V2_DIR, "migrations"));
} catch (error) {
  stop(`Nothing was written: ${(error as Error).message}`);
}
const report = [...result.report, ...judged];

const folder = path(out);
mkdirSync(folder, { recursive: true });
const sqlFile = join(folder, "settings.sql");
writeFileSync(sqlFile, `${statements.join("\n")}\n`, { mode: 0o600 });
// A file that was there before keeps its mode: set it.
chmodSync(sqlFile, 0o600);
writeFileSync(join(folder, "report.md"), reportMarkdown(result.rows, report, now));
writeFileSync(join(folder, "report.json"), `${JSON.stringify({ ran_at: now.toISOString(), rows: Object.fromEntries(Object.entries(result.rows).map(([table, rows]) => [table, rows.length])), report }, null, 2)}\n`);

const counts = (kind: string) => report.filter((line) => line.kind === kind).length;
console.log(`Wrote ${statements.length} rows to ${sqlFile}.`);
console.log(`Report: ${join(folder, "report.md")} (${counts("left_out")} not moved, ${counts("changed")} changed, ${counts("check")} worth a look).`);

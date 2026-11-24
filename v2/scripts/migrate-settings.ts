/**
 * The settings half of the v1-to-v2 migration (plan section 9.1). It reads a
 * v1 database export and writes the v2 rows as SQL, with a report of
 * everything left out or changed. It never connects to either deployment.
 *
 *   node --experimental-strip-types scripts/migrate-settings.ts \
 *     --from <v1 export.sql> --out <folder> \
 *     --v1-vault <file> --v2-vault <file> [--now <ISO time>]
 *
 * - `--from` is what `wrangler d1 export` writes for v1's database. It is read
 *   a piece at a time, so its size is not limited by memory.
 * - `--v1-vault` and `--v2-vault` are each a file in the format of
 *   `.dev.vars` with that deployment's vault settings. Provider keys and
 *   gateway tokens are opened with v1's and sealed with v2's, in memory only.
 *   Neither file is printed or copied.
 * - `--out` gets three files, each written to a new file only this user can
 *   read and then renamed into place: `settings.sql` (it holds sealed keys,
 *   password hashes and key hashes), `report.md` and `report.json`.
 * - Before writing, every row is put into a fresh v2 database built from
 *   v2's migrations, so a row that does not fit stops the run here, not
 *   halfway through an import. Then each app is judged by the console's save
 *   checks; a refusal is a line in the report. A key that does not open is
 *   its row's problem, and a line in the report; a vault that cannot be
 *   reached stops the run, and nothing is written.
 *
 * Running it on production:
 *
 * 1. Export v1's database, from a v1 checkout:
 *
 *      node scripts/wrangler.mjs --profile <name> d1 export DB --remote --output v1-export.sql
 *
 *    The export holds every secret v1 has. Provider keys and gateway tokens
 *    are sealed, and passwords and keys are hashes, but console session
 *    tokens and Google's sign-in tokens are in plain text. Keep it, the
 *    vault files and `--out` in a folder only you can read, and delete all of
 *    them once the import is done. While it runs, the script keeps a copy of
 *    the export in a private temporary folder, and deletes it when it ends,
 *    stops, or is interrupted.
 * 2. Write the two vault files, each with `SECRET_VAULT_MODE` and that mode's
 *    names, copied from the deployment's own secrets:
 *    - `local`: `SECRET_VAULT_LOCAL_KEK_V1`, every other
 *      `SECRET_VAULT_LOCAL_KEK_V<n>` the deployment has, and
 *      `SECRET_VAULT_LOCAL_KEK_CURRENT_VERSION` when it is not 1;
 *    - `kms`: `SECRET_VAULT_KMS_URL` and `SECRET_VAULT_KMS_TOKEN`.
 *    In `kms` mode the script calls both cf-kms services, v1's to open and
 *    v2's to seal, once per key and token.
 * 3. Run the script. Running it is the dry run: it writes only to `--out`,
 *    and it can be run again as often as needed.
 * 4. Read `report.md`, starting with "Read before applying": every row left
 *    out, every access that widens, and every change that makes an installed
 *    app fail. Fix what can be fixed in v1 first, and run it again.
 * 5. Apply `settings.sql` to an empty v2 database: v2's migrations applied,
 *    and nothing else in it yet, no sign-up included.
 *
 *      pnpm exec wrangler d1 execute DB --remote -c <v2 config> --file <out>/settings.sql
 *
 *    Wrangler runs the file as one import: if a row fails, none of the file
 *    stays (rehearsed on the test deployment, where a failing third row left
 *    neither of the two before it).
 * 6. To undo a finished import, restore the database to a time before it
 *    with D1 Time Travel (`wrangler d1 time-travel restore`), or start again
 *    from a new, empty database.
 *
 * The history half (usage, events, stored conversations) is step 13's.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkAgainstV2, insertStatements, readFirst, reportMarkdown } from "./migrate/output.ts";
import { migrateSettings } from "./migrate/settings.ts";
import { openV1Export, readV1Settings } from "./migrate/v1-rows.ts";
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

let exported;
try {
  exported = await openV1Export(path(from));
} catch (error) {
  stop(`The v1 export does not load: ${(error as Error).message}`);
}
// The copy holds the export's secrets: it goes whatever ends the run, an interrupt included.
const { close } = exported;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    close();
    process.exit(130);
  });
}
let result;
let statements;
let judged;
try {
  result = await migrateSettings(readV1Settings(exported.db), { now, reseal });
  statements = insertStatements(result.rows);
  judged = await checkAgainstV2(result, statements, join(V2_DIR, "migrations"));
} catch (error) {
  close();
  stop(`Nothing was written: ${(error as Error).message}`);
}
close();
const report = [...result.report, ...judged];

/** Writes `text` to a new file only this user can read, then renames it over `name`, so no reader ever sees a part, or a wider mode. */
function writePrivately(folder: string, name: string, text: string): string {
  const target = join(folder, name);
  const temporary = join(folder, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return target;
}

const folder = path(out);
mkdirSync(folder, { recursive: true, mode: 0o700 });
const sqlFile = writePrivately(folder, "settings.sql", `${statements.map((statement) => statement.sql).join("\n")}\n`);
const reportFile = writePrivately(folder, "report.md", reportMarkdown(result.rows, report, now));
writePrivately(
  folder,
  "report.json",
  `${JSON.stringify({ ran_at: now.toISOString(), rows: Object.fromEntries(Object.entries(result.rows).map(([table, rows]) => [table, rows.length])), report: report.map((line) => ({ ...line, read_first: readFirst(line) })) }, null, 2)}\n`,
);

const counts = (kind: string) => report.filter((line) => line.kind === kind).length;
console.log(`Wrote ${statements.length} rows to ${sqlFile}.`);
console.log(`Read before applying: ${report.filter(readFirst).length} lines, at the top of ${reportFile}.`);
console.log(`In all: ${counts("left_out")} not moved, ${counts("changed")} changed, ${counts("check")} worth a look.`);

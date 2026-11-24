/**
 * Gives a person their way back into a v2 deployment (v1's `recover-access`,
 * ported): a new password, and owner of an account they are a member of.
 *
 *   node --experimental-strip-types scripts/recover-access.ts --email <email> \
 *     (--local [--persist-to <dir>] | --remote -c <wrangler config>) \
 *     [--password-stdin] [--promote-owner --account <id>] [--dry-run] [--yes]
 *
 * - It acts only on the database the operator names: `--local`, or `--remote`
 *   with the Wrangler config of that deployment. There is no default.
 * - It first reads what is there and shows what it will change. `--dry-run`
 *   stops there and changes nothing. Otherwise it asks before changing
 *   anything; `--yes` answers for a run with no terminal.
 * - The new password comes from stdin: typed at a hidden prompt, or piped in.
 *   It is never an argument and never printed. Only its hash reaches the
 *   database, in a temporary file only this user can read, deleted after.
 */
import { spawnSync } from "node:child_process";
import { randomBytes, scrypt } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const USAGE = `usage: recover-access.ts --email <email> (--local [--persist-to <dir>] | --remote -c <config>)
       [--password-stdin] [--promote-owner --account <id>] [--dry-run] [--yes]`;

/** The v2 folder, where Wrangler finds the migrations and the config. */
const V2_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** The shortest password the sign-in library takes. */
const MIN_PASSWORD_LENGTH = 8;

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const flag = (name: string): boolean => args.includes(name);

function stop(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * A password hash as the sign-in library writes it (Better Auth's scrypt:
 * N 16384, r 16, p 1, 64 bytes, the hex salt as the salt, `salt:key` in hex).
 */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = await new Promise<Buffer>((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, 64, { N: 16384, r: 16, p: 1, maxmem: 128 * 16384 * 16 * 2 }, (error, derived) =>
      error ? reject(error) : resolve(derived),
    ),
  );
  return `${salt}:${key.toString("hex")}`;
}

/** Reads a line from a terminal without showing it. */
async function hiddenPrompt(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const finish = (answer: string | null) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (answer === null) stop("Cancelled; nothing was changed.");
      resolve(answer);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish(value);
        if (char === "\u0003") return finish(null);
        value = char === "\u007f" ? value.slice(0, -1) : value + char;
      }
    };
    stdin.on("data", onData);
  });
}

const email = option("--email")?.trim().toLowerCase();
const local = flag("--local");
const remote = flag("--remote");
const config = option("-c");
const persistTo = option("--persist-to");
const promote = flag("--promote-owner");
const accountId = option("--account")?.trim();
const wantsPassword = flag("--password-stdin");
const dryRun = flag("--dry-run");

if (flag("--help")) stop(USAGE, 0);
if (!email) stop(`--email is required\n${USAGE}`, 2);
if (local === remote) stop("Name the database: --local, or --remote with -c <the deployment's Wrangler config>", 2);
if (remote && config === undefined) stop("--remote needs -c <the deployment's Wrangler config>, so the deployment is named, never assumed", 2);
if (persistTo !== undefined && !local) stop("--persist-to goes with --local only", 2);
if (!wantsPassword && !promote) stop("Nothing to do: ask for --password-stdin, --promote-owner, or both", 2);
if (promote && !accountId) stop("--promote-owner needs --account <id>", 2);

/** The Wrangler arguments that name the database, the same for every command. */
const target = [
  "DB",
  local ? "--local" : "--remote",
  ...(persistTo === undefined ? [] : ["--persist-to", persistTo]),
  ...(config === undefined ? [] : ["-c", config]),
];

function wrangler(extra: string[]): string {
  const result = spawnSync("pnpm", ["exec", "wrangler", "d1", "execute", ...target, ...extra], {
    cwd: V2_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) stop("Wrangler could not reach the database; nothing was changed.");
  return result.stdout;
}

let password: string | undefined;
if (wantsPassword) {
  password = process.stdin.isTTY
    ? await hiddenPrompt("New password: ")
    : readFileSync(0, "utf8").replace(/[\r\n]+$/u, "");
  if (password.length < MIN_PASSWORD_LENGTH) stop(`The new password needs at least ${MIN_PASSWORD_LENGTH} characters; nothing was changed.`);
}

// What is there now, so the plan says exactly what changes.
const found = JSON.parse(
  wrangler([
    "--json",
    "--command",
    `SELECT u.id AS user_id,
       (SELECT count(*) FROM mgmt_user_account a WHERE a.user_id = u.id AND a.provider_id = 'credential') AS passwords,
       ${promote ? `(SELECT m.role FROM mgmt_organization_user m WHERE m.user_id = u.id AND m.organization_id = ${sqlText(accountId!)})` : "NULL"} AS role,
       ${promote ? `(SELECT o.name FROM mgmt_organization o WHERE o.id = ${sqlText(accountId!)})` : "NULL"} AS account_name
     FROM mgmt_user u WHERE u.kind = 'human' AND u.email = ${sqlText(email)} COLLATE NOCASE;`,
  ]),
) as { results: { user_id: string; passwords: number; role: string | null; account_name: string | null }[] }[];
const person = found[0]?.results[0];
if (person === undefined) stop(`No person signs in with ${email} on this deployment; nothing was changed.`);

const where = local ? `the local database${persistTo === undefined ? "" : ` in ${persistTo}`}` : `the remote database of the Worker in ${config}`;
const plan: string[] = [];
const statements: string[] = [];
if (password !== undefined) {
  if (person.passwords === 0) {
    stop(`${email} has no password sign-in to reset (they sign in another way, such as Google); nothing was changed.`);
  }
  plan.push(`Set a new password for ${email}. Their sessions stay signed in.`);
  statements.push(
    `UPDATE mgmt_user_account SET password = ${sqlText(await hashPassword(password))}, updated_at = ${Date.now()}
       WHERE provider_id = 'credential' AND user_id = ${sqlText(person.user_id)};`,
  );
}
if (promote) {
  if (person.role === null) stop(`${email} is not a member of the account ${accountId}; nothing was changed.`);
  const account = `${person.account_name ?? accountId} (${accountId})`;
  if (person.role === "owner") {
    plan.push(`${email} is already an owner of ${account}: no change there.`);
  } else {
    plan.push(`Make ${email} an owner of ${account}; they are ${person.role === "admin" ? "an admin" : "a member"} now.`);
    statements.push(
      `UPDATE mgmt_organization_user SET role = 'owner'
         WHERE organization_id = ${sqlText(accountId!)} AND user_id = ${sqlText(person.user_id)};`,
    );
  }
}

console.error(`On ${where}:`);
for (const line of plan) console.error(`- ${line}`);
if (statements.length === 0) stop("Nothing to change.", 0);
if (dryRun) stop("Dry run: nothing was changed.", 0);

if (!flag("--yes")) {
  if (!process.stdin.isTTY) stop("Nothing was changed: there is no terminal to ask. Review the plan with --dry-run, then run again with --yes.");
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await prompt.question("Type yes to make these changes: ");
  prompt.close();
  if (answer.trim().toLowerCase() !== "yes") stop("Nothing was changed.");
}

const folder = mkdtempSync(join(tmpdir(), "agw-recover-"));
try {
  const file = join(folder, "recover.sql");
  writeFileSync(file, statements.join("\n"), { mode: 0o600 });
  wrangler(["--file", file]);
} finally {
  rmSync(folder, { recursive: true, force: true });
}
console.error("Done. Sign in to check.");

/**
 * Gives a person their way back into a v2 deployment (v1's `recover-access`,
 * ported): a new password, and owner of an account they are a member of.
 *
 *   node --experimental-strip-types scripts/recover-access.ts --email <email> \
 *     (--local [--persist-to <dir>] | --remote) [-c <wrangler config>] [--env <name>] \
 *     [--password-stdin] [--promote-owner --account <id>] [--dry-run] [--yes]
 *
 * - It acts only on the database the operator names. `--local` or `--remote`
 *   is required, and `--remote` needs `-c`. The `DB` binding is resolved from
 *   that config (and `--env`, which the config must define) to its database,
 *   which the preview names. With `CLOUDFLARE_ENV` set, `--env` is required.
 *   The rest of the operator's shell and `.env` settings are theirs to keep
 *   right. Paths are taken from the folder the command was run in.
 * - It reads first and shows what it will change. `--dry-run` stops there.
 *   Otherwise it asks before changing anything; `--yes` answers for a run with
 *   no terminal.
 * - A new password also signs the person out everywhere: their CLI and MCP
 *   connections are revoked and their browser sessions deleted (v1 left
 *   them). Making someone an owner touches neither.
 * - Every change is in one file that Wrangler runs as one all-or-nothing
 *   batch, as in v1 (remotely, through D1's import, which pauses the database
 *   briefly; accepted for a manual recovery). A change someone else makes in
 *   the seconds between the preview and the yes is accepted too.
 * - The new password comes from a hidden prompt, typed twice, or a pipe;
 *   never an argument, and never printed. Only its hash reaches the
 *   database, in a temporary file only this user can read, deleted whatever
 *   happens, an interrupt included. Wrangler runs with its logs sanitized,
 *   and its error text is shown only for the read, which holds only the email.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, scrypt } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const USAGE = `usage: recover-access.ts --email <email> (--local [--persist-to <dir>] | --remote) [-c <config>] [--env <name>]
       [--password-stdin] [--promote-owner --account <id>] [--dry-run] [--yes]`;

/** The v2 folder, where Wrangler runs and finds the migrations and the default config. */
const V2_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
/** The folder the command was run in (`pnpm run` moves to the package's own; `INIT_CWD` keeps the caller's). */
const CALLER_DIR = process.env.INIT_CWD ?? process.cwd();

/** The password lengths the sign-in library takes. */
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

function stop(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

let parsed: ReturnType<typeof readArgs>;
function readArgs() {
  return parseArgs({
    // `pnpm run <script> -- …` passes its `--` on.
    args: process.argv.slice(process.argv[2] === "--" ? 3 : 2),
    strict: true,
    allowPositionals: false,
    options: {
      email: { type: "string" },
      local: { type: "boolean" },
      remote: { type: "boolean" },
      config: { type: "string", short: "c" },
      env: { type: "string" },
      "persist-to": { type: "string" },
      "password-stdin": { type: "boolean" },
      "promote-owner": { type: "boolean" },
      account: { type: "string" },
      "dry-run": { type: "boolean" },
      yes: { type: "boolean" },
      help: { type: "boolean" },
    },
  }).values;
}
try {
  parsed = readArgs();
} catch (error) {
  stop(`${(error as Error).message}\n${USAGE}`, 2);
}
if (parsed.help) stop(USAGE, 0);
for (const name of ["email", "config", "env", "persist-to", "account"] as const) {
  if (parsed[name] !== undefined && parsed[name].trim() === "") stop(`--${name} needs a value\n${USAGE}`, 2);
}
const email = parsed.email?.trim().toLowerCase();
const local = parsed.local === true;
const remote = parsed.remote === true;
const envName = parsed.env;
const persistTo = parsed["persist-to"] === undefined ? undefined : resolve(CALLER_DIR, parsed["persist-to"]);
const promote = parsed["promote-owner"] === true;
const accountId = parsed.account?.trim();
const wantsPassword = parsed["password-stdin"] === true;

if (!email) stop(`--email is required\n${USAGE}`, 2);
if (local === remote) stop("Name the database: --local, or --remote with -c <the deployment's Wrangler config>", 2);
if (remote && parsed.config === undefined) stop("--remote needs -c <the deployment's Wrangler config>, so the deployment is named, never assumed", 2);
if (persistTo !== undefined && !local) stop("--persist-to goes with --local only", 2);
if (!wantsPassword && !promote) stop("Nothing to do: ask for --password-stdin, --promote-owner, or both", 2);
if (promote && !accountId) stop("--promote-owner needs --account <id>", 2);
const shellEnv = process.env.CLOUDFLARE_ENV;
if (shellEnv !== undefined && shellEnv !== "" && envName === undefined) {
  stop(`CLOUDFLARE_ENV is set (${shellEnv}): name the environment with --env, so the deployment is never taken from the shell`, 2);
}

// The deployment, as the config (and --env) resolve it: its Worker and its DB database.
const configPath = parsed.config === undefined ? join(V2_DIR, "wrangler.jsonc") : resolve(CALLER_DIR, parsed.config);
const { experimental_readRawConfig, unstable_readConfig } = await import("wrangler");
if (envName !== undefined) {
  const raw = experimental_readRawConfig({ config: configPath }) as { rawConfig: { env?: Record<string, unknown> } };
  if (raw.rawConfig.env?.[envName] === undefined) stop(`${configPath} defines no environment ${envName}; nothing was read or changed.`, 2);
}
/** What of the resolved config this reads. */
interface Deployment {
  name?: string;
  d1_databases: { binding: string; database_name?: string; database_id?: string }[];
}
const config = unstable_readConfig({ config: configPath, ...(envName === undefined ? {} : { env: envName }) }, { hideWarnings: true }) as Deployment;
const database = config.d1_databases.find((binding) => binding.binding === "DB");
if (database === undefined) stop(`${configPath} binds no DB database${envName === undefined ? "" : ` in the environment ${envName}`}; nothing was read or changed.`);

const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * A password hash as the sign-in library writes it (Better Auth's scrypt:
 * N 16384, r 16, p 1, 64 bytes, the hex salt as the salt, `salt:key` in hex).
 */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = await new Promise<Buffer>((done, fail) =>
    scrypt(password.normalize("NFKC"), salt, 64, { N: 16384, r: 16, p: 1, maxmem: 128 * 16384 * 16 * 2 }, (error, derived) =>
      error ? fail(error) : done(derived),
    ),
  );
  return `${salt}:${key.toString("hex")}`;
}

/** Reads a line from a terminal without showing it. Control characters, such as an arrow key's, are ignored. */
async function hiddenPrompt(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((done) => {
    let value = "";
    /** Inside an escape sequence (an arrow key sends ESC [ A): skipped up to its final letter. */
    let escape = false;
    const finish = (answer: string | null) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (answer === null) stop("Cancelled; nothing was changed.");
      done(answer);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (escape) {
          if (/[A-Za-z~]/u.test(char)) escape = false;
          continue;
        }
        if (char === "\r" || char === "\n") return finish(value);
        if (char === "\u0003") return finish(null);
        if (char === "\u001b") escape = true;
        else if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    stdin.on("data", onData);
  });
}

let password: string | undefined;
if (wantsPassword) {
  if (process.stdin.isTTY) {
    password = await hiddenPrompt("New password: ");
    if ((await hiddenPrompt("The same again: ")) !== password) stop("The two passwords differ; nothing was changed.");
  } else {
    password = readFileSync(0, "utf8").replace(/[\r\n]+$/u, "");
  }
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    stop(`The new password needs ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters; nothing was changed.`);
  }
}

/** The environment Wrangler runs with: the shell's, without CLOUDFLARE_ENV (--env says it), its logs sanitized. */
const { CLOUDFLARE_ENV: _ignored, ...shell } = process.env;
const wranglerEnv = { ...shell, WRANGLER_LOG_SANITIZE: "true" };
const wranglerArgs = (extra: string[]) => [
  "exec", "wrangler", "d1", "execute", "DB", local ? "--local" : "--remote",
  ...(persistTo === undefined ? [] : ["--persist-to", persistTo]),
  "-c", configPath,
  ...(envName === undefined ? [] : ["--env", envName]),
  ...(remote ? ["--yes"] : []),
  ...extra,
];

interface Found {
  user_id: string;
  passwords: number;
  sessions: number;
  connections: number;
  role: string | null;
  account_name: string | null;
}

// What is there now, so the plan says exactly what changes. Its errors hold only the email, so they are shown.
const read = `SELECT u.id AS user_id,
     (SELECT count(*) FROM mgmt_user_account a WHERE a.user_id = u.id AND a.provider_id = 'credential') AS passwords,
     (SELECT count(*) FROM mgmt_user_session s WHERE s.user_id = u.id) AS sessions,
     (SELECT count(*) FROM mgmt_api_key k WHERE k.user_id = u.id AND k.credential_type = 'oauth' AND k.revoked_at IS NULL) AS connections,
     (SELECT m.role FROM mgmt_organization_user m WHERE m.user_id = u.id AND m.organization_id = ${sqlText(accountId ?? "")}) AS role,
     (SELECT o.name FROM mgmt_organization o WHERE o.id = ${sqlText(accountId ?? "")}) AS account_name
   FROM mgmt_user u WHERE u.kind = 'human' AND u.email = ${sqlText(email)} COLLATE NOCASE`;
const lookup = spawnSync("pnpm", wranglerArgs(["--json", "--command", read]), { cwd: V2_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: wranglerEnv });
let person: Found | undefined;
try {
  if (lookup.error || lookup.status !== 0) throw new Error("failed");
  person = (JSON.parse(lookup.stdout) as { results: Found[] }[])[0]?.results[0];
} catch {
  stop(`The database could not be read; nothing was changed.\n${lookup.stderr?.trim() ?? ""}`);
}
if (person === undefined) stop(`No person signs in with ${email} on this deployment; nothing was changed.`);

const where = `the ${local ? "local" : "remote"} DB database ${database.database_name ?? ""}${remote && database.database_id ? ` (${database.database_id})` : ""} of the Worker ${config.name} (${configPath}${envName === undefined ? "" : `, environment ${envName}`})${persistTo === undefined ? "" : `, kept in ${persistTo}`}`;
const plan: string[] = [];
const statements: string[] = [];
const user = sqlText(person.user_id);
const now = Date.now();
if (password !== undefined && person.passwords === 0) {
  stop(`${email} has no password sign-in to reset (they sign in another way, such as Google); nothing was changed.`);
}
if (promote && person.role === null) stop(`${email} is not a member of the account ${accountId}; nothing was changed.`);
if (password !== undefined) {
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  plan.push(`Set a new password for ${email}.`);
  plan.push(
    `Sign ${email} out of all browser sessions and CLI/MCP connections: ${count(person.sessions, "session")} and ${count(person.connections, "connection")}.`,
  );
  statements.push(
    `UPDATE mgmt_api_key SET enabled = 0, revoked_at = ${now} WHERE user_id = ${user} AND credential_type = 'oauth' AND revoked_at IS NULL;`,
    `DELETE FROM mgmt_oauth_token WHERE api_key_id IN (SELECT id FROM mgmt_api_key WHERE user_id = ${user} AND credential_type = 'oauth');`,
    `DELETE FROM mgmt_user_session WHERE user_id = ${user};`,
  );
}
if (promote) {
  const account = `${person.account_name} (${accountId})`;
  if (person.role === "owner") {
    plan.push(`${email} is already an owner of ${account}: no change there.`);
  } else {
    plan.push(`Make ${email} an owner of ${account}; they are ${person.role === "admin" ? "an admin" : "a member"} now.`);
    statements.push(`UPDATE mgmt_organization_user SET role = 'owner' WHERE organization_id = ${sqlText(accountId!)} AND user_id = ${user};`);
  }
}
if (password !== undefined) {
  statements.push(
    `UPDATE mgmt_user_account SET password = ${sqlText(await hashPassword(password))}, updated_at = ${now} WHERE provider_id = 'credential' AND user_id = ${user};`,
  );
}

console.error(`On ${where}:`);
for (const line of plan) console.error(`- ${line}`);
if (statements.length === 0) stop("Nothing to change.", 0);
if (parsed["dry-run"]) stop("Dry run: nothing was changed.", 0);

if (!parsed.yes) {
  if (!process.stdin.isTTY) stop("Nothing was changed: there is no terminal to ask. Review the plan with --dry-run, then run again with --yes.");
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await prompt.question("Type yes to make these changes: ");
  prompt.close();
  if (answer.trim().toLowerCase() !== "yes") stop("Nothing was changed.");
}

// One file, run as one batch. Wrangler runs while this process waits, so an interrupt can stop it and remove the file.
const folder = mkdtempSync(join(tmpdir(), "agw-recover-"));
let child: ChildProcess | undefined;
const interrupted = (signal: NodeJS.Signals, code: number) => () => {
  child?.kill(signal);
  rmSync(folder, { recursive: true, force: true });
  console.error(`Interrupted: ${remote ? "the change may or may not have gone through; sign in to check" : "the change may not have run"}.`);
  process.exit(code);
};
process.once("SIGINT", interrupted("SIGINT", 130));
process.once("SIGTERM", interrupted("SIGTERM", 143));
let status: number | null = null;
try {
  const file = join(folder, "recover.sql");
  writeFileSync(file, statements.join("\n"), { mode: 0o600 });
  status = await new Promise<number | null>((done) => {
    child = spawn("pnpm", wranglerArgs(["--file", file]), { cwd: V2_DIR, stdio: ["ignore", "ignore", "ignore"], env: wranglerEnv });
    child.on("error", () => done(null));
    child.on("close", (code) => done(code));
  });
} finally {
  rmSync(folder, { recursive: true, force: true });
}
if (status !== 0) {
  stop(
    remote
      ? "Wrangler did not finish cleanly: the change may or may not have gone through. Sign in to check, and run again if it did not."
      : "Nothing was changed: Wrangler could not run the change.",
  );
}
console.error("Done. Sign in to check.");

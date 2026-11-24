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
 *   that config (and `--env`) to its database, which the preview names, and
 *   only that database is used. With `CLOUDFLARE_ENV` set in the shell, it
 *   stops unless `--env` names the environment.
 * - It reads first and shows what it will change. `--dry-run` stops there.
 *   Otherwise it asks before changing anything; `--yes` answers for a run with
 *   no terminal.
 * - A new password also signs the person out everywhere: their browser
 *   sessions are deleted and their CLI and MCP connections revoked (v1 left
 *   them). Making someone an owner touches neither.
 * - The changes run as one batch that first checks the rows it changes are
 *   still there, so it changes everything or nothing.
 * - The new password comes from a hidden prompt or a pipe, never an argument,
 *   and is never printed. Its hash never becomes a process argument either:
 *   locally it goes to Wrangler in a temporary file only this user can read,
 *   deleted after; remotely it goes in the body of one call to D1's query API
 *   (`CLOUDFLARE_API_TOKEN`, from the environment only).
 */
import { spawnSync } from "node:child_process";
import { randomBytes, scrypt } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const USAGE = `usage: recover-access.ts --email <email> (--local [--persist-to <dir>] | --remote) [-c <config>] [--env <name>]
       [--password-stdin] [--promote-owner --account <id>] [--dry-run] [--yes]`;

/** The v2 folder, where Wrangler finds the migrations and the default config. */
const V2_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** The password lengths the sign-in library takes. */
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

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
  const key = await new Promise<Buffer>((done, fail) =>
    scrypt(password.normalize("NFKC"), salt, 64, { N: 16384, r: 16, p: 1, maxmem: 128 * 16384 * 16 * 2 }, (error, derived) =>
      error ? fail(error) : done(derived),
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
  return new Promise((done) => {
    let value = "";
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
const configArg = option("-c");
const envName = option("--env");
const persistTo = option("--persist-to");
const promote = flag("--promote-owner");
const accountId = option("--account")?.trim();
const wantsPassword = flag("--password-stdin");
const dryRun = flag("--dry-run");

if (flag("--help")) stop(USAGE, 0);
if (!email) stop(`--email is required\n${USAGE}`, 2);
if (local === remote) stop("Name the database: --local, or --remote with -c <the deployment's Wrangler config>", 2);
if (remote && configArg === undefined) stop("--remote needs -c <the deployment's Wrangler config>, so the deployment is named, never assumed", 2);
if (persistTo !== undefined && !local) stop("--persist-to goes with --local only", 2);
if (!wantsPassword && !promote) stop("Nothing to do: ask for --password-stdin, --promote-owner, or both", 2);
if (promote && !accountId) stop("--promote-owner needs --account <id>", 2);
const shellEnv = process.env.CLOUDFLARE_ENV;
if (shellEnv !== undefined && shellEnv !== "" && envName === undefined) {
  stop(`CLOUDFLARE_ENV is set (${shellEnv}): name the environment with --env, so the deployment is never taken from the shell`, 2);
}

// The deployment, as the config (and --env) resolve it: its Worker and its DB database.
const configPath = resolve(configArg ?? join(V2_DIR, "wrangler.jsonc"));
const { unstable_readConfig } = await import("wrangler");
/** What of the resolved config this reads. */
interface Deployment {
  name?: string;
  account_id?: string;
  d1_databases: { binding: string; database_name?: string; database_id?: string }[];
}
const config = unstable_readConfig({ config: configPath, ...(envName === undefined ? {} : { env: envName }) }, { hideWarnings: true }) as Deployment;
const database = config.d1_databases.find((binding) => binding.binding === "DB");
if (database === undefined) stop(`${configPath} binds no DB database${envName === undefined ? "" : ` in the environment ${envName}`}; nothing was read or changed.`);
if (remote && (database.database_id === undefined || database.database_id === "")) {
  stop(`${configPath} gives the DB database no database_id; nothing was read or changed.`);
}
const accountOfDeployment = config.account_id ?? process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
if (remote && (accountOfDeployment === undefined || accountOfDeployment === "")) {
  stop("--remote needs the Cloudflare account: account_id in the config, or CLOUDFLARE_ACCOUNT_ID");
}
if (remote && (apiToken === undefined || apiToken === "")) {
  stop("--remote needs CLOUDFLARE_API_TOKEN in the environment (a token that can edit this D1 database)");
}

let password: string | undefined;
if (wantsPassword) {
  password = process.stdin.isTTY ? await hiddenPrompt("New password: ") : readFileSync(0, "utf8").replace(/[\r\n]+$/u, "");
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    stop(`The new password needs ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters; nothing was changed.`);
  }
}

/** The environment Wrangler runs with: the shell's, without CLOUDFLARE_ENV, since --env says it. */
const { CLOUDFLARE_ENV: _ignored, ...wranglerEnv } = process.env;

/** Runs Wrangler against the local database the config names. Throws on failure, so the caller always cleans up. */
function localD1(extra: string[]): string {
  const result = spawnSync(
    "pnpm",
    [
      "exec", "wrangler", "d1", "execute", "DB", "--local",
      ...(persistTo === undefined ? [] : ["--persist-to", persistTo]),
      "-c", configPath,
      ...(envName === undefined ? [] : ["--env", envName]),
      ...extra,
    ],
    { cwd: V2_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: wranglerEnv },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim().split("\n").at(-1) ?? "Wrangler failed");
  return result.stdout;
}

/** One call to D1's query API for the remote database the config names. Throws on failure. */
async function remoteD1(body: { sql: string; params?: string[] }): Promise<{ results: Record<string, unknown>[] }[]> {
  const base = process.env.CLOUDFLARE_API_BASE_URL ?? "https://api.cloudflare.com/client/v4";
  const response = await fetch(`${base}/accounts/${accountOfDeployment}/d1/database/${database!.database_id}/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const answer = (await response.json().catch(() => null)) as { success?: boolean; result?: { results: Record<string, unknown>[] }[]; errors?: { message?: string }[] } | null;
  if (!response.ok || answer?.success !== true || answer.result === undefined) {
    throw new Error(answer?.errors?.[0]?.message ?? `D1 answered ${response.status}`);
  }
  return answer.result;
}

interface Found {
  user_id: string;
  passwords: number;
  sessions: number;
  connections: number;
  role: string | null;
  account_name: string | null;
}

// What is there now, so the plan says exactly what changes.
const read = `SELECT u.id AS user_id,
     (SELECT count(*) FROM mgmt_user_account a WHERE a.user_id = u.id AND a.provider_id = 'credential') AS passwords,
     (SELECT count(*) FROM mgmt_user_session s WHERE s.user_id = u.id) AS sessions,
     (SELECT count(*) FROM mgmt_api_key k WHERE k.user_id = u.id AND k.credential_type = 'oauth' AND k.revoked_at IS NULL) AS connections,
     (SELECT m.role FROM mgmt_organization_user m WHERE m.user_id = u.id AND m.organization_id = ?2) AS role,
     (SELECT o.name FROM mgmt_organization o WHERE o.id = ?2) AS account_name
   FROM mgmt_user u WHERE u.kind = 'human' AND u.email = ?1 COLLATE NOCASE`;
let person: Found | undefined;
try {
  person = remote
    ? ((await remoteD1({ sql: read, params: [email, accountId ?? ""] }))[0]?.results[0] as Found | undefined)
    : (JSON.parse(localD1(["--json", "--command", read.replaceAll("?1", sqlText(email)).replaceAll("?2", sqlText(accountId ?? ""))])) as { results: Found[] }[])[0]
        ?.results[0];
} catch (error) {
  stop(`The database could not be read (${(error as Error).message}); nothing was changed.`);
}
if (person === undefined) stop(`No person signs in with ${email} on this deployment; nothing was changed.`);

const where = local
  ? `the local DB database ${database.database_name} of the Worker ${config.name} (${configPath}${envName === undefined ? "" : `, environment ${envName}`})${persistTo === undefined ? "" : `, kept in ${persistTo}`}`
  : `the remote DB database ${database.database_name} (${database.database_id}) of the Worker ${config.name} (${configPath}${envName === undefined ? "" : `, environment ${envName}`})`;
const plan: string[] = [];
/** Checks that fail the batch, before anything in it changes, when a row the plan relies on is gone. */
const guards: string[] = [];
const statements: string[] = [];
const user = sqlText(person.user_id);
const failUnless = (condition: string, gone: string) =>
  `SELECT json(CASE WHEN ${condition} THEN '1' ELSE ${sqlText(`${gone} since the preview`)} END);`;
const now = Date.now();
if (password !== undefined) {
  if (person.passwords === 0) {
    stop(`${email} has no password sign-in to reset (they sign in another way, such as Google); nothing was changed.`);
  }
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  plan.push(`Set a new password for ${email}.`);
  plan.push(
    `Sign ${email} out of all browser sessions and CLI/MCP connections: ${count(person.sessions, "session")} and ${count(person.connections, "connection")}.`,
  );
  guards.push(failUnless(`EXISTS (SELECT 1 FROM mgmt_user_account WHERE provider_id = 'credential' AND user_id = ${user})`, "the password sign-in is gone"));
  statements.push(
    `UPDATE mgmt_user_account SET password = ${sqlText(await hashPassword(password))}, updated_at = ${now} WHERE provider_id = 'credential' AND user_id = ${user};`,
    `DELETE FROM mgmt_user_session WHERE user_id = ${user};`,
    `DELETE FROM mgmt_oauth_token WHERE api_key_id IN (SELECT id FROM mgmt_api_key WHERE user_id = ${user} AND credential_type = 'oauth');`,
    `UPDATE mgmt_api_key SET enabled = 0, revoked_at = ${now} WHERE user_id = ${user} AND credential_type = 'oauth' AND revoked_at IS NULL;`,
  );
}
if (promote) {
  if (person.role === null) stop(`${email} is not a member of the account ${accountId}; nothing was changed.`);
  const account = `${person.account_name ?? accountId} (${accountId})`;
  if (person.role === "owner") {
    plan.push(`${email} is already an owner of ${account}: no change there.`);
  } else {
    plan.push(`Make ${email} an owner of ${account}; they are ${person.role === "admin" ? "an admin" : "a member"} now.`);
    const membership = `organization_id = ${sqlText(accountId!)} AND user_id = ${user}`;
    guards.push(failUnless(`EXISTS (SELECT 1 FROM mgmt_organization_user WHERE ${membership})`, "the membership is gone"));
    statements.push(`UPDATE mgmt_organization_user SET role = 'owner' WHERE ${membership};`);
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

// One batch: the checks first, so a row gone since the preview stops it before anything changes.
const batch = [...guards, ...statements].join("\n");
let failure: Error | null = null;
if (remote) {
  try {
    await remoteD1({ sql: batch });
  } catch (error) {
    failure = error as Error;
  }
} else {
  const folder = mkdtempSync(join(tmpdir(), "agw-recover-"));
  try {
    const file = join(folder, "recover.sql");
    writeFileSync(file, batch, { mode: 0o600 });
    localD1(["--file", file]);
  } catch (error) {
    failure = error as Error;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
if (failure !== null) stop(`Nothing was changed: the change did not go through (${failure.message}).`);
console.error("Done. Sign in to check.");

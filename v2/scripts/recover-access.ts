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
 *   which the preview names, and only that database is used. It stops when
 *   `CLOUDFLARE_ENV` is set and `--env` is not given, and when the shell
 *   points Cloudflare's API elsewhere (`CLOUDFLARE_API_BASE_URL`,
 *   `WRANGLER_API_ENVIRONMENT`).
 * - It reads first and shows what it will change. `--dry-run` stops there.
 *   Otherwise it asks before changing anything; `--yes` answers for a run with
 *   no terminal.
 * - A new password also signs the person out everywhere: their CLI and MCP
 *   connections are revoked and their browser sessions deleted (v1 left
 *   them). Making someone an owner touches neither.
 * - First it checks the rows it changes are still there. Then the changes go
 *   in an order where stopping part-way is safe and each change is safe to
 *   repeat: sign-outs first, then the owner change, the password last. A run
 *   that stops part-way leaves the person signed out with the old password,
 *   and running it again completes it. A local run is also one transaction.
 * - The new password comes from a hidden prompt or a pipe, never an argument,
 *   and is never printed; nor is its hash, nor a database's own error text.
 *   Locally the hash goes to Wrangler in a temporary file only this user can
 *   read, deleted after; remotely it is a bound parameter of D1's query API
 *   (`CLOUDFLARE_API_TOKEN`, from the environment only).
 *
 * `--test-api-base <http://127.0.0.1:port/...>` points the remote calls at a
 * stand-in on this machine, for the script's own tests; nothing else.
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
const testApiBase = option("--test-api-base");

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
for (const name of ["CLOUDFLARE_API_BASE_URL", "WRANGLER_API_ENVIRONMENT"]) {
  if ((process.env[name] ?? "") !== "") stop(`${name} is set: this script talks only to Cloudflare's own API. Unset it and run again.`, 2);
}
if (testApiBase !== undefined && !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\//u.test(testApiBase)) {
  stop("--test-api-base is for the script's own tests: a stand-in on this machine only", 2);
}

// The deployment, as the config (and --env) resolve it: its Worker and its DB database.
const configPath = resolve(configArg ?? join(V2_DIR, "wrangler.jsonc"));
const { experimental_readRawConfig, unstable_readConfig } = await import("wrangler");
if (envName !== undefined) {
  const raw = experimental_readRawConfig({ config: configPath }) as { rawConfig: { env?: Record<string, unknown> } };
  if (raw.rawConfig.env?.[envName] === undefined) stop(`${configPath} defines no environment ${envName}; nothing was read or changed.`, 2);
}
/** What of the resolved config this reads. */
interface Deployment {
  name?: string;
  account_id?: string;
  d1_databases: { binding: string; database_name?: string; database_id?: string }[];
}
const config = unstable_readConfig({ config: configPath, ...(envName === undefined ? {} : { env: envName }) }, { hideWarnings: true }) as Deployment;
const databases = config.d1_databases.filter((binding) => binding.binding === "DB");
const database = databases[0];
if (database === undefined) stop(`${configPath} binds no DB database${envName === undefined ? "" : ` in the environment ${envName}`}; nothing was read or changed.`);
// Wrangler finds a local database by its binding or by its name, so another database named DB would make "DB" ambiguous.
if (local && (databases.length > 1 || config.d1_databases.some((binding) => binding.binding !== "DB" && binding.database_name === "DB"))) {
  stop(`${configPath} has more than one database Wrangler could take for DB; nothing was read or changed.`);
}
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

/** A failure described in words this script chose: never a database's own text, which can quote a statement. */
class Failed extends Error {}

/** The environment Wrangler runs with: the shell's, without CLOUDFLARE_ENV (--env says it), its logs sanitized. */
const { CLOUDFLARE_ENV: _ignored, ...shell } = process.env;
const wranglerEnv = { ...shell, WRANGLER_LOG_SANITIZE: "true" };

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
  if (result.error) throw new Failed("Wrangler could not be started");
  if (result.status !== 0) throw new Failed(`Wrangler stopped with status ${result.status}`);
  return result.stdout;
}

/** The outcome of a remote call that was sent but not answered: it may or may not have run. */
class Unknown extends Error {}

/**
 * One statement through D1's query API for the remote database the config
 * names. Answers its rows, or throws: `Failed` when D1 refused it (its error
 * code only), `Unknown` when no usable answer came back after sending it.
 */
async function remoteD1(sql: string, params: string[]): Promise<Record<string, unknown>[]> {
  const base = testApiBase ?? "https://api.cloudflare.com/client/v4/";
  const url = new URL(`accounts/${accountOfDeployment}/d1/database/${database!.database_id}/query`, base.endsWith("/") ? base : `${base}/`);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ sql, params }),
    });
  } catch {
    throw new Unknown("no answer came back");
  }
  const answer = (await response.json().catch(() => null)) as {
    success?: unknown;
    result?: { success?: unknown; results?: unknown }[];
    errors?: { code?: unknown }[];
  } | null;
  if (answer === null) throw new Unknown(`an unreadable answer came back (HTTP ${response.status})`);
  if (answer.success !== true) {
    const code = answer.errors?.[0]?.code;
    throw new Failed(`D1 refused it (HTTP ${response.status}${typeof code === "number" ? `, code ${code}` : ""})`);
  }
  const [statement] = answer.result ?? [];
  if (answer.result?.length !== 1 || statement?.success !== true || !Array.isArray(statement.results)) {
    throw new Unknown("D1's answer did not confirm it ran");
  }
  return statement.results as Record<string, unknown>[];
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

/** A statement with `?N` parameters, as SQL with the values written in, for Wrangler's local file. */
const inline = (sql: string, params: string[]) =>
  params.reduceRight((text, value, index) => text.replaceAll(`?${index + 1}`, sqlText(value)), sql);

let person: Found | undefined;
try {
  const params = [email, accountId ?? ""];
  person = remote
    ? ((await remoteD1(read, params))[0] as Found | undefined)
    : (JSON.parse(localD1(["--json", "--command", inline(read, params)])) as { results: Found[] }[])[0]?.results[0];
} catch (error) {
  stop(`The database could not be read (${error instanceof Failed || error instanceof Unknown ? error.message : "an unexpected error"}); nothing was changed.`);
}
if (person === undefined) stop(`No person signs in with ${email} on this deployment; nothing was changed.`);

const where = local
  ? `the local DB database ${database.database_name} of the Worker ${config.name} (${configPath}${envName === undefined ? "" : `, environment ${envName}`})${persistTo === undefined ? "" : `, kept in ${persistTo}`}`
  : `the remote DB database ${database.database_name} (${database.database_id}) of the Worker ${config.name} (${configPath}${envName === undefined ? "" : `, environment ${envName}`})`;

/** A row the plan relies on, checked before anything changes. */
interface Guard {
  condition: string;
  params: string[];
  gone: string;
}
/** One change, safe to repeat, with what it does in words. */
interface Change {
  what: string;
  sql: string;
  params: string[];
}
const plan: string[] = [];
const guards: Guard[] = [];
const changes: Change[] = [];
const user = person.user_id;
const now = String(Date.now());
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
  guards.push({
    condition: "EXISTS (SELECT 1 FROM mgmt_user_account WHERE provider_id = 'credential' AND user_id = ?1)",
    params: [user],
    gone: "the password sign-in is gone since the preview",
  });
  changes.push(
    {
      what: "revoke the CLI/MCP connections",
      sql: "UPDATE mgmt_api_key SET enabled = 0, revoked_at = ?2 WHERE user_id = ?1 AND credential_type = 'oauth' AND revoked_at IS NULL",
      params: [user, now],
    },
    {
      what: "delete the CLI/MCP connections' tokens",
      sql: "DELETE FROM mgmt_oauth_token WHERE api_key_id IN (SELECT id FROM mgmt_api_key WHERE user_id = ?1 AND credential_type = 'oauth')",
      params: [user],
    },
    { what: "delete the browser sessions", sql: "DELETE FROM mgmt_user_session WHERE user_id = ?1", params: [user] },
  );
}
if (promote) {
  const account = `${person.account_name ?? accountId} (${accountId})`;
  if (person.role === "owner") {
    plan.push(`${email} is already an owner of ${account}: no change there.`);
  } else {
    plan.push(`Make ${email} an owner of ${account}; they are ${person.role === "admin" ? "an admin" : "a member"} now.`);
    guards.push({
      condition: "EXISTS (SELECT 1 FROM mgmt_organization_user WHERE organization_id = ?1 AND user_id = ?2)",
      params: [accountId!, user],
      gone: "the membership is gone since the preview",
    });
    changes.push({
      what: "make them an owner",
      sql: "UPDATE mgmt_organization_user SET role = 'owner' WHERE organization_id = ?1 AND user_id = ?2",
      params: [accountId!, user],
    });
  }
}
if (password !== undefined) {
  // Last: a run that stops before it leaves the old password, which a rerun replaces.
  changes.push({
    what: "set the new password",
    sql: "UPDATE mgmt_user_account SET password = ?2, updated_at = ?3 WHERE provider_id = 'credential' AND user_id = ?1",
    params: [user, await hashPassword(password), now],
  });
}

console.error(`On ${where}:`);
for (const line of plan) console.error(`- ${line}`);
if (changes.length === 0) stop("Nothing to change.", 0);
if (dryRun) stop("Dry run: nothing was changed.", 0);

if (!flag("--yes")) {
  if (!process.stdin.isTTY) stop("Nothing was changed: there is no terminal to ask. Review the plan with --dry-run, then run again with --yes.");
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await prompt.question("Type yes to make these changes: ");
  prompt.close();
  if (answer.trim().toLowerCase() !== "yes") stop("Nothing was changed.");
}

if (local) {
  // One file, one transaction: the checks first, so a row gone since the preview stops it before anything changes.
  const failUnless = (guard: Guard) => `SELECT json(CASE WHEN ${inline(guard.condition, guard.params)} THEN '1' ELSE ${sqlText(guard.gone)} END);`;
  const batch = [...guards.map(failUnless), ...changes.map((change) => `${inline(change.sql, change.params)};`)].join("\n");
  const folder = mkdtempSync(join(tmpdir(), "agw-recover-"));
  let failure: string | null = null;
  try {
    const file = join(folder, "recover.sql");
    writeFileSync(file, batch, { mode: 0o600 });
    localD1(["--file", file]);
  } catch (error) {
    failure = error instanceof Failed ? error.message : "an unexpected error";
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  if (failure !== null) stop(`Nothing was changed: the change did not go through (${failure}, or a row was gone since the preview).`);
} else {
  for (const guard of guards) {
    let rows: Record<string, unknown>[];
    try {
      rows = await remoteD1(`SELECT ${guard.condition} AS still_there`, guard.params);
    } catch (error) {
      stop(`Nothing was changed: the check before it did not go through (${error instanceof Error ? error.message : "an unexpected error"}).`);
    }
    if (rows[0]?.still_there !== 1) stop(`Nothing was changed: ${guard.gone}.`);
  }
  const done: string[] = [];
  for (const change of changes) {
    try {
      await remoteD1(change.sql, change.params);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "an unexpected error";
      const before = done.length === 0 ? "Nothing before it was changed." : `Done before it: ${done.join(", ")}.`;
      stop(
        error instanceof Unknown
          ? `The outcome of "${change.what}" is unknown (${reason}). ${before} Run the same command again to complete it.`
          : `Stopped at "${change.what}" (${reason}). ${before} Run the same command again to complete it.`,
      );
    }
    done.push(change.what);
  }
}
console.error("Done. Sign in to check.");

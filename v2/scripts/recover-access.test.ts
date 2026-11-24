/**
 * `recover-access.ts`, never against a real deployment:
 *
 * - locally, against a throwaway local database (Wrangler's local D1 in a
 *   temporary folder, with v2's migrations), seeded and read here directly so
 *   only the script under test starts Wrangler;
 * - remotely, against a stand-in config and a stand-in of D1's query API on
 *   this machine (`CLOUDFLARE_API_BASE_URL`), which records each call.
 *
 * It names what it will change, changes nothing on a dry run or without a
 * yes, changes everything or nothing, and otherwise sets a password the
 * sign-in library accepts, signs the person out everywhere and makes them an
 * owner.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
// A test of the hash's format only: the script never imports the library.
import { verifyPassword } from "better-auth/crypto";

const V2_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(V2_DIR, "scripts", "recover-access.ts");
const PASSWORD = "a new password for the recovery test";
const OLD_HASH = "old-salt:old-key";
const API_TOKEN = "dummy-api-token-for-the-recovery-test";

let persist = "";
let scratch = "";

function wrangler(...extra: string[]): string {
  const result = spawnSync("pnpm", ["exec", "wrangler", "d1", ...extra], { cwd: V2_DIR, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/** The local database's own file. */
function databaseFile(): string {
  const folder = join(persist, "v3", "d1", "miniflare-D1DatabaseObject");
  const file = readdirSync(folder).find((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite");
  assert.ok(file, "Wrangler made no local database");
  return join(folder, file);
}

function query<T>(sql: string, ...params: string[]): T {
  const db = new DatabaseSync(databaseFile());
  try {
    return db.prepare(sql).get(...params) as T;
  } finally {
    db.close();
  }
}

/** What the database holds for a person: password hash, role in acct1, sessions, live CLI/MCP connections and their tokens. */
function state(userId: string): { password: string | null; role: string | null; sessions: number; connections: number; tokens: number } {
  const row = query<Record<string, string | number | null>>(
    `SELECT (SELECT password FROM mgmt_user_account WHERE user_id = ?1 AND provider_id = 'credential') AS password,
            (SELECT role FROM mgmt_organization_user WHERE user_id = ?1 AND organization_id = 'acct1') AS role,
            (SELECT count(*) FROM mgmt_user_session WHERE user_id = ?1) AS sessions,
            (SELECT count(*) FROM mgmt_api_key WHERE user_id = ?1 AND credential_type = 'oauth' AND revoked_at IS NULL AND enabled = 1) AS connections,
            (SELECT count(*) FROM mgmt_oauth_token t JOIN mgmt_api_key k ON k.id = t.api_key_id WHERE k.user_id = ?1) AS tokens`,
    userId,
  );
  return {
    password: row.password as string | null,
    role: row.role as string | null,
    sessions: Number(row.sessions),
    connections: Number(row.connections),
    tokens: Number(row.tokens),
  };
}

interface Run {
  code: number | null;
  output: string;
}

/** Runs the script; `env` is added to this process's. */
function recover(args: string[], input = "", env: Record<string, string> = {}): Run {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
    cwd: V2_DIR,
    encoding: "utf8",
    input,
    env: { ...process.env, CLOUDFLARE_ENV: "", ...env },
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

/** The same, without blocking this process, so a stand-in server here can answer the script. */
function recoverAsync(args: string[], input: string, env: Record<string, string>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
      cwd: V2_DIR,
      env: { ...process.env, CLOUDFLARE_ENV: "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
    child.stdin.end(input);
  });
}

const local = () => ["--local", "--persist-to", persist];

before(() => {
  persist = mkdtempSync(join(tmpdir(), "agw-recover-test-"));
  scratch = mkdtempSync(join(tmpdir(), "agw-recover-scratch-"));
  wrangler("migrations", "apply", "DB", "--local", "--persist-to", persist);
  const db = new DatabaseSync(databaseFile());
  const person = (id: string, name: string, email: string) =>
    `INSERT INTO mgmt_user (id, name, email, kind, email_verified, created_at, updated_at) VALUES ('${id}', '${name}', '${email}', 'human', 1, 1, 1);`;
  const membership = (id: string, user: string, role: string) =>
    `INSERT INTO mgmt_organization_user (id, organization_id, user_id, role, status, joined_at) VALUES ('${id}', 'acct1', '${user}', '${role}', 'active', 'x');`;
  const session = (id: string, user: string) =>
    `INSERT INTO mgmt_user_session (id, expires_at, token, created_at, updated_at, user_id) VALUES ('${id}', 9999999999999, '${id}', 1, 1, '${user}');`;
  const connection = (id: string, user: string) => [
    `INSERT INTO mgmt_api_key (id, user_id, organization_id, name, token_hash, token_hint, created_at, credential_type) VALUES ('${id}', '${user}', 'acct1', 'agw', 'h-${id}', 'x', 1, 'oauth');`,
    `INSERT INTO mgmt_oauth_token (id, api_key_id, generation, access_token_hash, access_expires_at, refresh_token_hash, created_at) VALUES ('t-${id}', '${id}', 1, 'a-${id}', 9999999999999, 'r-${id}', 1);`,
  ];
  db.exec(
    [
      person("u_ada", "Ada", "ada@example.test"),
      person("u_bob", "Bob", "bob@example.test"),
      person("u_cat", "Cat", "cat@example.test"),
      `INSERT INTO mgmt_user_account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES ('a_ada', 'u_ada', 'credential', 'u_ada', '${OLD_HASH}', 1, 1);`,
      `INSERT INTO mgmt_user_account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES ('a_cat', 'u_cat', 'credential', 'u_cat', '${OLD_HASH}', 1, 1);`,
      "INSERT INTO mgmt_user_account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ('a_bob', 'g-123', 'google', 'u_bob', 1, 1);",
      "INSERT INTO mgmt_organization (id, name, created_by_user_id, created_at, updated_at) VALUES ('acct1', 'Acme', 'u_bob', 'x', 'x');",
      membership("m_ada", "u_ada", "member"),
      membership("m_bob", "u_bob", "owner"),
      membership("m_cat", "u_cat", "member"),
      // Two sessions of Ada's (say one is someone else's), one of Bob's, one of Cat's.
      session("s_ada1", "u_ada"),
      session("s_ada2", "u_ada"),
      session("s_bob", "u_bob"),
      session("s_cat", "u_cat"),
      // A CLI or MCP connection of Ada's, and one of Bob's.
      ...connection("k_ada", "u_ada"),
      ...connection("k_bob", "u_bob"),
    ].join("\n"),
  );
  db.close();
});

after(() => {
  rmSync(persist, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

test("refuses to run without a named database, or with nothing to do, before reading anything", () => {
  const cases: [string[], RegExp][] = [
    [["--email", "ada@example.test", "--password-stdin"], /Name the database/u],
    [["--email", "ada@example.test", "--password-stdin", "--local", "--remote", "-c", "wrangler.jsonc"], /Name the database/u],
    [["--email", "ada@example.test", "--password-stdin", "--remote"], /--remote needs -c/u],
    [["--email", "ada@example.test", "--password-stdin", "--remote", "-c", "wrangler.jsonc", "--persist-to", "x"], /--persist-to goes with --local only/u],
    [["--email", "ada@example.test", "--local"], /Nothing to do/u],
    [["--email", "ada@example.test", "--local", "--promote-owner"], /needs --account/u],
    [["--local", "--password-stdin"], /--email is required/u],
  ];
  for (const [args, message] of cases) {
    const { code, output } = recover(args);
    assert.equal(code, 2, output);
    assert.match(output, message);
  }
  // An environment set in the shell is never taken as the target.
  const shell = recover(["--email", "ada@example.test", ...local(), "--password-stdin"], "", { CLOUDFLARE_ENV: "staging" });
  assert.equal(shell.code, 2);
  assert.match(shell.output, /CLOUDFLARE_ENV is set \(staging\): name the environment with --env/u);
  // A password outside the sign-in library's limits is refused before the database is read.
  for (const password of ["short", "x".repeat(129)]) {
    const refused = recover(["--email", "ada@example.test", "--local", "--persist-to", "/nonexistent", "--password-stdin"], `${password}\n`);
    assert.equal(refused.code, 1);
    assert.match(refused.output, /needs 8 to 128 characters/u);
  }
});

test("shows the plan and changes nothing on a dry run, or without a yes and no terminal to ask", () => {
  const ask = ["--email", "Ada@Example.test", ...local(), "--password-stdin", "--promote-owner", "--account", "acct1"];
  const dry = recover([...ask, "--dry-run"], `${PASSWORD}\n`);
  assert.equal(dry.code, 0, dry.output);
  // The database, as the config resolves it.
  assert.match(dry.output, /On the local DB database app-ai-gateway-v2 of the Worker app-ai-gateway-v2 /u);
  assert.match(dry.output, /Set a new password for ada@example\.test/u);
  assert.match(dry.output, /Sign ada@example\.test out of all browser sessions and CLI\/MCP connections: 2 sessions and 1 connection\./u);
  assert.match(dry.output, /Make ada@example\.test an owner of Acme \(acct1\); they are a member now\./u);
  assert.match(dry.output, /Dry run: nothing was changed\./u);
  // Making someone an owner alone signs nobody out.
  const ownerOnly = recover(["--email", "ada@example.test", ...local(), "--promote-owner", "--account", "acct1", "--dry-run"]);
  assert.equal(ownerOnly.code, 0, ownerOnly.output);
  assert.match(ownerOnly.output, /Make ada@example\.test an owner/u);
  assert.doesNotMatch(ownerOnly.output, /Sign .* out/u);
  const unasked = recover(ask, `${PASSWORD}\n`);
  assert.equal(unasked.code, 1);
  assert.match(unasked.output, /no terminal to ask/u);
  for (const output of [dry.output, unasked.output]) assert.ok(!output.includes(PASSWORD), "the password was printed");
  assert.deepEqual(state("u_ada"), { password: OLD_HASH, role: "member", sessions: 2, connections: 1, tokens: 1 });
});

test("refuses a person it cannot help, and changes nothing", () => {
  const unknown = recover(["--email", "nobody@example.test", ...local(), "--password-stdin", "--yes"], `${PASSWORD}\n`);
  assert.equal(unknown.code, 1);
  assert.match(unknown.output, /No person signs in with nobody@example\.test/u);
  // Bob signs in with Google: there is no password to reset.
  const google = recover(["--email", "bob@example.test", ...local(), "--password-stdin", "--yes"], `${PASSWORD}\n`);
  assert.equal(google.code, 1);
  assert.match(google.output, /has no password sign-in to reset/u);
  // Not a member of the account named: refused, even on a dry run.
  const outside = recover(["--email", "ada@example.test", ...local(), "--promote-owner", "--account", "acct2", "--dry-run"]);
  assert.equal(outside.code, 1);
  assert.match(outside.output, /not a member of the account acct2/u);
  assert.deepEqual(state("u_ada"), { password: OLD_HASH, role: "member", sessions: 2, connections: 1, tokens: 1 });
  assert.deepEqual(state("u_bob"), { password: null, role: "owner", sessions: 1, connections: 1, tokens: 1 });
});

test("changes nothing, keeps no file and says nothing is done when a row is gone between the preview and the change", () => {
  // A `pnpm` in front of the real one: after the script's read, it takes Cat out of the account.
  const real = spawnSync("sh", ["-c", "command -v pnpm"], { encoding: "utf8" }).stdout.trim();
  const bin = join(scratch, "bin");
  const temp = join(scratch, "tmp");
  for (const dir of [bin, temp]) spawnSync("mkdir", ["-p", dir]);
  writeFileSync(
    join(bin, "pnpm"),
    `#!/bin/sh\n"${real}" "$@"; status=$?\ncase " $* " in *" --json "*) "${process.execPath}" -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.env.AGW_TEST_DB); db.exec(\\"DELETE FROM mgmt_organization_user WHERE id = 'm_cat'\\"); db.close();" ;; esac\nexit $status\n`,
  );
  chmodSync(join(bin, "pnpm"), 0o755);
  const run = recover(["--email", "cat@example.test", ...local(), "--password-stdin", "--promote-owner", "--account", "acct1", "--yes"], `${PASSWORD}\n`, {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    TMPDIR: temp,
    AGW_TEST_DB: databaseFile(),
  });
  assert.equal(run.code, 1, run.output);
  assert.match(run.output, /Nothing was changed: the change did not go through/u);
  assert.doesNotMatch(run.output, /Done/u);
  // The password and the sessions are as they were: the whole batch stopped.
  assert.deepEqual(state("u_cat"), { password: OLD_HASH, role: null, sessions: 1, connections: 0, tokens: 0 });
  // The temporary file holding the hash is gone.
  assert.deepEqual(readdirSync(temp).filter((name) => name.startsWith("agw-recover-")), []);
});

test("with a yes, sets a password the sign-in library accepts, signs the person out everywhere and makes them an owner", async () => {
  const run = recover(["--email", "ada@example.test", ...local(), "--password-stdin", "--promote-owner", "--account", "acct1", "--yes"], `${PASSWORD}\n`);
  assert.equal(run.code, 0, run.output);
  assert.match(run.output, /Done\./u);
  assert.ok(!run.output.includes(PASSWORD), "the password was printed");
  const after = state("u_ada");
  assert.equal(after.role, "owner");
  assert.notEqual(after.password, OLD_HASH);
  assert.equal(await verifyPassword({ hash: after.password!, password: PASSWORD }), true);
  // Signed out of every browser session and CLI/MCP connection.
  assert.deepEqual([after.sessions, after.connections, after.tokens], [0, 0, 0]);
  // Nobody else is signed out.
  assert.deepEqual(state("u_bob"), { password: null, role: "owner", sessions: 1, connections: 1, tokens: 1 });
});

/** A stand-in of D1's query API on this machine, answering `answer` and recording every call. */
async function d1Stand(answer: (call: { sql: string; params: string[] }) => { status: number; body: unknown }) {
  const calls: { url: string; authorization: string | undefined; body: { sql: string; params: string[] } }[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    let text = "";
    request.on("data", (chunk: Buffer) => (text += chunk.toString()));
    request.on("end", () => {
      const body = JSON.parse(text) as { sql: string; params: string[] };
      calls.push({ url: request.url!, authorization: request.headers.authorization, body });
      const { status, body: reply } = answer(body);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(typeof reply === "string" ? reply : JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { calls, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4/`, close: () => server.close() };
}

/** D1's answer to one statement that ran. */
const ran = (results: Record<string, unknown>[] = []) => ({ status: 200, body: { success: true, errors: [], result: [{ success: true, results, meta: {} }] } });

test("remotely, uses exactly the database the config and --env name, one statement at a time, in an order safe to stop and repeat", async () => {
  // A stand-in config: the Worker, its account, and a DB database per environment.
  const config = join(scratch, "wrangler.stand-in.jsonc");
  const worker = { main: join(V2_DIR, "src", "index.ts"), compatibility_date: "2026-01-01" };
  writeFileSync(
    config,
    JSON.stringify({
      name: "stand-in-worker",
      ...worker,
      account_id: "acc-123",
      d1_databases: [{ binding: "DB", database_name: "prod-db", database_id: "db-prod" }],
      env: { staging: { name: "stand-in-staging", d1_databases: [{ binding: "DB", database_name: "staging-db", database_id: "db-staging" }] } },
    }),
  );
  const noDb = join(scratch, "wrangler.no-db.jsonc");
  writeFileSync(noDb, JSON.stringify({ name: "bare", ...worker }));

  /** How the stand-in answers each kind of statement in the current case. */
  let mode: "ok" | "gone" | "refuse-password" | "lose-sessions" | "empty" = "ok";
  const stand = await d1Stand((call) => {
    if (call.sql.startsWith("SELECT u.id")) {
      return ran([{ user_id: "u_remote", passwords: 1, sessions: 3, connections: 2, role: "member", account_name: "Remote Co" }]);
    }
    if (call.sql.includes("AS still_there")) return ran([{ still_there: mode === "gone" && call.sql.includes("mgmt_organization_user") ? 0 : 1 }]);
    if (mode === "refuse-password" && call.sql.includes("SET password")) {
      // D1's own error text can quote what it was sent: it must never be printed.
      return { status: 400, body: { success: false, errors: [{ code: 7500, message: `SQLITE_ERROR near ${JSON.stringify(call.params)}` }], result: [] } };
    }
    if (mode === "lose-sessions" && call.sql.includes("mgmt_user_session")) return { status: 502, body: "<html>bad gateway</html>" };
    if (mode === "empty") return { status: 200, body: { success: true, errors: [], result: [] } };
    return ran();
  });
  const api = ["--test-api-base", stand.base];
  const env = { CLOUDFLARE_API_TOKEN: API_TOKEN };
  const ask = ["--email", "dee@example.test", "--remote", "-c", config, ...api, "--password-stdin", "--promote-owner", "--account", "acct9"];
  const changes = () => stand.calls.filter((call) => /^(UPDATE|DELETE)/u.test(call.body.sql));
  try {
    // Refused before any call: no DB binding, no token, an environment the config lacks, an API pointed elsewhere.
    const refusals: [string[], Record<string, string>, RegExp][] = [
      [["--email", "dee@example.test", "--remote", "-c", noDb, ...api, "--promote-owner", "--account", "a", "--dry-run"], env, /binds no DB database/u],
      [[...ask, "--dry-run"], { CLOUDFLARE_API_TOKEN: "" }, /needs CLOUDFLARE_API_TOKEN/u],
      [[...ask, "--env", "nope", "--dry-run"], env, /defines no environment nope/u],
      [[...ask, "--dry-run"], { ...env, CLOUDFLARE_API_BASE_URL: stand.base }, /CLOUDFLARE_API_BASE_URL is set/u],
      [["--email", "dee@example.test", "--remote", "-c", config, "--test-api-base", "https://api.example.com/", "--promote-owner", "--account", "a"], env, /stand-in on this machine only/u],
    ];
    for (const [args, extra, message] of refusals) {
      const run = await recoverAsync(args, `${PASSWORD}\n`, extra);
      assert.notEqual(run.code, 0, run.output);
      assert.match(run.output, message);
    }
    assert.equal(stand.calls.length, 0);

    // The environment named: its own Worker and database, in the preview and in the call.
    const dry = await recoverAsync([...ask, "--env", "staging", "--dry-run"], `${PASSWORD}\n`, { ...env, CLOUDFLARE_ENV: "staging" });
    assert.equal(dry.code, 0, dry.output);
    assert.match(dry.output, /On the remote DB database staging-db \(db-staging\) of the Worker stand-in-staging /u);
    assert.match(dry.output, /3 sessions and 2 connections/u);
    assert.equal(stand.calls.length, 1);
    assert.equal(stand.calls[0]!.url, "/client/v4/accounts/acc-123/d1/database/db-staging/query");
    assert.equal(stand.calls[0]!.authorization, `Bearer ${API_TOKEN}`);
    assert.deepEqual(stand.calls[0]!.body.params, ["dee@example.test", "acct9"]);

    // A row gone since the preview: nothing is changed.
    mode = "gone";
    const gone = await recoverAsync([...ask, "--yes"], `${PASSWORD}\n`, env);
    assert.equal(gone.code, 1);
    assert.match(gone.output, /Nothing was changed: the membership is gone since the preview\./u);
    assert.equal(changes().length, 0);

    // Everything: the checks, then each change on its own, sign-outs first and the password last.
    mode = "ok";
    stand.calls.length = 0;
    const done = await recoverAsync([...ask, "--yes"], `${PASSWORD}\n`, env);
    assert.equal(done.code, 0, done.output);
    assert.match(done.output, /Done\./u);
    assert.deepEqual(
      stand.calls.map((call) => call.body.sql.split(" ").slice(0, 3).join(" ")),
      ["SELECT u.id AS", "SELECT EXISTS (SELECT", "SELECT EXISTS (SELECT", "UPDATE mgmt_api_key SET", "DELETE FROM mgmt_oauth_token", "DELETE FROM mgmt_user_session", "UPDATE mgmt_organization_user SET", "UPDATE mgmt_user_account SET"],
    );
    for (const call of stand.calls) assert.equal(call.url, "/client/v4/accounts/acc-123/d1/database/db-prod/query");
    // The hash is a bound value, never part of the SQL.
    const passwordCall = stand.calls.at(-1)!;
    const hash = passwordCall.body.params[1]!;
    assert.match(hash, /^[0-9a-f]{32}:[0-9a-f]{128}$/u);
    assert.ok(!passwordCall.body.sql.includes(hash));
    assert.equal(await verifyPassword({ hash, password: PASSWORD }), true);

    // The password refused, last: the sign-outs stand, the rerun completes it, and nothing of D1's text is printed.
    mode = "refuse-password";
    stand.calls.length = 0;
    const refused = await recoverAsync([...ask, "--yes"], `${PASSWORD}\n`, env);
    assert.equal(refused.code, 1);
    assert.match(refused.output, /Stopped at "set the new password" \(D1 refused it \(HTTP 400, code 7500\)\)\. Done before it: revoke the CLI\/MCP connections, delete the CLI\/MCP connections' tokens, delete the browser sessions, make them an owner\. Run the same command again to complete it\./u);
    assert.ok(!refused.output.includes(stand.calls.at(-1)!.body.params[1]!), "the hash was printed");
    assert.doesNotMatch(refused.output, /SQLITE_ERROR|Done\. Sign in/u);

    // An answer lost after sending: its outcome is unknown, and a rerun completes it.
    mode = "lose-sessions";
    const lost = await recoverAsync([...ask, "--yes"], `${PASSWORD}\n`, env);
    assert.equal(lost.code, 1);
    assert.match(lost.output, /The outcome of "delete the browser sessions" is unknown \(an unreadable answer came back \(HTTP 502\)\)\. Done before it: revoke the CLI\/MCP connections, delete the CLI\/MCP connections' tokens\. Run the same command again/u);

    // An answer without a result for the statement is no proof it ran.
    mode = "empty";
    const empty = await recoverAsync([...ask, "--yes"], `${PASSWORD}\n`, env);
    assert.equal(empty.code, 1);
    assert.match(empty.output, /did not confirm it ran/u);
    assert.doesNotMatch(empty.output, /Done\. Sign in/u);

    for (const output of [dry.output, gone.output, done.output, refused.output, lost.output, empty.output]) {
      assert.ok(!output.includes(PASSWORD) && !output.includes(API_TOKEN), "a secret was printed");
    }
  } finally {
    stand.close();
  }
});

test("locally, refuses an environment the config lacks and a DB Wrangler could resolve two ways, before reading", () => {
  const unknownEnv = recover(["--email", "ada@example.test", ...local(), "--env", "nope", "--promote-owner", "--account", "acct1", "--dry-run"]);
  assert.equal(unknownEnv.code, 2);
  assert.match(unknownEnv.output, /defines no environment nope/u);
  const ambiguous = join(scratch, "wrangler.ambiguous.jsonc");
  writeFileSync(
    ambiguous,
    JSON.stringify({
      name: "ambiguous",
      main: join(V2_DIR, "src", "index.ts"),
      compatibility_date: "2026-01-01",
      d1_databases: [{ binding: "DB", database_name: "main-db" }, { binding: "OTHER", database_name: "DB" }],
    }),
  );
  const twoWays = recover(["--email", "ada@example.test", "--local", "--persist-to", persist, "-c", ambiguous, "--promote-owner", "--account", "acct1", "--dry-run"]);
  assert.equal(twoWays.code, 1);
  assert.match(twoWays.output, /more than one database Wrangler could take for DB/u);
});

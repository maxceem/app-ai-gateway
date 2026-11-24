/**
 * `recover-access.ts`, never against a real deployment:
 *
 * - locally, against a throwaway local database (Wrangler's local D1 in a
 *   temporary folder, with v2's migrations), seeded and read here directly so
 *   only the script under test starts Wrangler;
 * - with stand-in configs, for the refusals made before anything is read.
 *   No test reaches a remote database.
 *
 * It names what it will change, changes nothing on a dry run or without a
 * yes, changes everything or nothing, and otherwise sets a password the
 * sign-in library accepts, signs the person out everywhere and makes them an
 * owner.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from "node:fs";
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

test("reads its arguments strictly: an unknown flag, a missing or empty value, or an environment the config lacks is refused", () => {
  const base = ["--email", "ada@example.test", ...local(), "--promote-owner", "--account", "acct1", "--dry-run"];
  const cases: [string[], number, RegExp][] = [
    [[...base, "-e", "staging"], 2, /Unknown option '-e'/u],
    [[...base, "--env"], 2, /--env <value>' argument missing/u],
    [[...base, "--env", ""], 2, /--env needs a value/u],
    [[...base, "--env=staging"], 2, /defines no environment staging/u],
    [[...base, "--env", "staging"], 2, /defines no environment staging/u],
    [[...base, "--nope"], 2, /Unknown option '--nope'/u],
  ];
  for (const [args, code, message] of cases) {
    const run = recover(args);
    assert.equal(run.code, code, run.output);
    assert.match(run.output, message);
  }
});

test("takes -c from the folder the command was run in, and refuses a config without DB before reading", () => {
  writeFileSync(join(scratch, "wrangler.no-db.jsonc"), JSON.stringify({ name: "bare", main: join(V2_DIR, "src", "index.ts"), compatibility_date: "2026-01-01" }));
  // As `pnpm run` starts it: in the package's folder, with the caller's in INIT_CWD.
  const run = recover(["--email", "ada@example.test", "--remote", "-c", "wrangler.no-db.jsonc", "--promote-owner", "--account", "acct1", "--dry-run"], "", { INIT_CWD: scratch });
  assert.equal(run.code, 1, run.output);
  assert.match(run.output, new RegExp(`${join(scratch, "wrangler.no-db.jsonc").replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")} binds no DB database`, "u"));
});

test("an interrupt while Wrangler runs stops it, removes the temporary file, and exits with the signal's code", async () => {
  // A stand-in Wrangler: it answers the read, and for the change it notes its pid and waits.
  const bin = join(scratch, "waiting-bin");
  const temp = join(scratch, "waiting-tmp");
  mkdirSync(bin, { recursive: true });
  mkdirSync(temp, { recursive: true });
  const mark = join(scratch, "waiting.pid");
  const person = JSON.stringify([{ results: [{ user_id: "u_x", passwords: 1, sessions: 0, connections: 0, role: null, account_name: null }], success: true }]);
  writeFileSync(
    join(bin, "pnpm"),
    `#!/bin/sh\ncase " $* " in\n  *" --json "*) printf '%s' '${person}' ;;\n  *" --file "*) echo $$ > "${mark}.part"; mv "${mark}.part" "${mark}"; exec sleep 30 ;;\nesac\n`,
  );
  chmodSync(join(bin, "pnpm"), 0o755);
  const child = spawn(process.execPath, ["--experimental-strip-types", SCRIPT, "--email", "x@example.test", "--local", "--password-stdin", "--yes"], {
    cwd: V2_DIR,
    env: { ...process.env, CLOUDFLARE_ENV: "", PATH: `${bin}:${process.env.PATH ?? ""}`, TMPDIR: temp },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  child.stdin.end(`${PASSWORD}\n`);
  // Wait for the stand-in to start: a file event, no timer.
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(scratch, () => {
      if (existsSync(mark)) {
        watcher.close();
        resolve();
      }
    });
    if (existsSync(mark)) {
      watcher.close();
      resolve();
    }
    void closed.then(() => reject(new Error(`the script ended first: ${output}`)));
  });
  const pid = Number(readFileSync(mark, "utf8"));
  child.kill("SIGTERM");
  assert.equal(await closed, 143, output);
  assert.match(output, /Interrupted: the change may not have run\./u);
  // Gone, or ended and waiting only to be collected.
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  assert.ok(state === "" || state.startsWith("Z"), `the stand-in Wrangler still runs (${state})`);
  assert.deepEqual(readdirSync(temp).filter((name) => name.startsWith("agw-recover-")), []);
});

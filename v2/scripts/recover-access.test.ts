/**
 * `recover-access.ts` against a throwaway local database (Wrangler's local
 * D1 in a temporary folder, with v2's migrations): it names what it will
 * change, changes nothing on a dry run or without a yes, and otherwise sets a
 * password the sign-in library accepts and makes the person an owner. It is
 * never run against a remote database here.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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

function wrangler(...extra: string[]): string {
  const result = spawnSync("pnpm", ["exec", "wrangler", "d1", ...extra], { cwd: V2_DIR, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/**
 * The local database's own file, opened directly: seeding and reading it
 * this way starts no Wrangler, so only the script under test does.
 */
function database(): DatabaseSync {
  const folder = join(persist, "v3", "d1", "miniflare-D1DatabaseObject");
  const file = readdirSync(folder).find((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite");
  assert.ok(file, "Wrangler made no local database");
  return new DatabaseSync(join(folder, file));
}

/** What the database holds for a person: their password hash, their role in acct1, and how many sessions they have. */
function state(userId: string): { password: string | null; role: string | null; sessions: number } {
  const db = database();
  try {
    const row = db
      .prepare(
        `SELECT (SELECT password FROM mgmt_user_account WHERE user_id = ? AND provider_id = 'credential') AS password,
                (SELECT role FROM mgmt_organization_user WHERE user_id = ? AND organization_id = 'acct1') AS role,
                (SELECT count(*) FROM mgmt_user_session WHERE user_id = ?) AS sessions`,
      )
      .get(userId, userId, userId) as { password: string | null; role: string | null; sessions: number };
    return { password: row.password, role: row.role, sessions: Number(row.sessions) };
  } finally {
    db.close();
  }
}

function recover(args: string[], input = ""): { code: number | null; output: string } {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], { cwd: V2_DIR, encoding: "utf8", input });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

const local = () => ["--local", "--persist-to", persist];

before(() => {
  persist = mkdtempSync(join(tmpdir(), "agw-recover-test-"));
  wrangler("migrations", "apply", "DB", "--local", "--persist-to", persist);
  const db = database();
  db.exec([
    "INSERT INTO mgmt_user (id, name, email, kind, email_verified, created_at, updated_at) VALUES ('u_ada', 'Ada', 'ada@example.test', 'human', 1, 1, 1);",
    "INSERT INTO mgmt_user (id, name, email, kind, email_verified, created_at, updated_at) VALUES ('u_bob', 'Bob', 'bob@example.test', 'human', 1, 1, 1);",
    `INSERT INTO mgmt_user_account (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES ('a_ada', 'u_ada', 'credential', 'u_ada', '${OLD_HASH}', 1, 1);`,
    "INSERT INTO mgmt_user_account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ('a_bob', 'g-123', 'google', 'u_bob', 1, 1);",
    "INSERT INTO mgmt_organization (id, name, created_by_user_id, created_at, updated_at) VALUES ('acct1', 'Acme', 'u_bob', 'x', 'x');",
    "INSERT INTO mgmt_organization_user (id, organization_id, user_id, role, status, joined_at) VALUES ('m_ada', 'acct1', 'u_ada', 'member', 'active', 'x');",
    "INSERT INTO mgmt_organization_user (id, organization_id, user_id, role, status, joined_at) VALUES ('m_bob', 'acct1', 'u_bob', 'owner', 'active', 'x');",
    // Two sessions of Ada's, say one of them someone else's, and one of Bob's.
    "INSERT INTO mgmt_user_session (id, expires_at, token, created_at, updated_at, user_id) VALUES ('s_ada1', 9999999999999, 't1', 1, 1, 'u_ada');",
    "INSERT INTO mgmt_user_session (id, expires_at, token, created_at, updated_at, user_id) VALUES ('s_ada2', 9999999999999, 't2', 1, 1, 'u_ada');",
    "INSERT INTO mgmt_user_session (id, expires_at, token, created_at, updated_at, user_id) VALUES ('s_bob', 9999999999999, 't3', 1, 1, 'u_bob');",
  ].join("\n"));
  db.close();
});

after(() => rmSync(persist, { recursive: true, force: true }));

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
  // A short password is refused before the database is read.
  const short = recover(["--email", "ada@example.test", "--local", "--persist-to", "/nonexistent", "--password-stdin"], "short\n");
  assert.equal(short.code, 1);
  assert.match(short.output, /at least 8 characters/u);
});

test("shows the plan and changes nothing on a dry run, or without a yes and no terminal to ask", () => {
  const ask = ["--email", "Ada@Example.test", ...local(), "--password-stdin", "--promote-owner", "--account", "acct1"];
  const dry = recover([...ask, "--dry-run"], `${PASSWORD}\n`);
  assert.equal(dry.code, 0, dry.output);
  assert.match(dry.output, /Set a new password for ada@example\.test/u);
  assert.match(dry.output, /Sign ada@example\.test out everywhere: delete their 2 sessions/u);
  assert.match(dry.output, /Make ada@example\.test an owner of Acme \(acct1\); they are a member now\./u);
  assert.match(dry.output, /Dry run: nothing was changed\./u);
  // Making someone an owner alone leaves their sessions as they are.
  const ownerOnly = recover(["--email", "ada@example.test", ...local(), "--promote-owner", "--account", "acct1", "--dry-run"]);
  assert.equal(ownerOnly.code, 0, ownerOnly.output);
  assert.match(ownerOnly.output, /Make ada@example\.test an owner/u);
  assert.doesNotMatch(ownerOnly.output, /out everywhere/u);
  const unasked = recover(ask, `${PASSWORD}\n`);
  assert.equal(unasked.code, 1);
  assert.match(unasked.output, /no terminal to ask/u);
  for (const output of [dry.output, unasked.output]) assert.ok(!output.includes(PASSWORD), "the password was printed");
  assert.deepEqual(state("u_ada"), { password: OLD_HASH, role: "member", sessions: 2 });
});

test("refuses a person it cannot help, and changes nothing", () => {
  const unknown = recover(["--email", "nobody@example.test", ...local(), "--password-stdin", "--yes"], `${PASSWORD}\n`);
  assert.equal(unknown.code, 1);
  assert.match(unknown.output, /No person signs in with nobody@example\.test/u);
  // Bob signs in with Google: there is no password to reset.
  const google = recover(["--email", "bob@example.test", ...local(), "--password-stdin", "--yes"], `${PASSWORD}\n`);
  assert.equal(google.code, 1);
  assert.match(google.output, /has no password sign-in to reset/u);
  assert.deepEqual(state("u_ada"), { password: OLD_HASH, role: "member", sessions: 2 });
  assert.deepEqual(state("u_bob"), { password: null, role: "owner", sessions: 1 });
});

test("with a yes, sets a password the sign-in library accepts and makes the person an owner", async () => {
  const run = recover(["--email", "ada@example.test", ...local(), "--password-stdin", "--promote-owner", "--account", "acct1", "--yes"], `${PASSWORD}\n`);
  assert.equal(run.code, 0, run.output);
  assert.match(run.output, /Done\./u);
  assert.ok(!run.output.includes(PASSWORD), "the password was printed");
  const after = state("u_ada");
  assert.equal(after.role, "owner");
  // Signed out everywhere; nobody else's sessions are touched.
  assert.equal(after.sessions, 0);
  assert.equal(state("u_bob").sessions, 1);
  assert.notEqual(after.password, OLD_HASH);
  assert.equal(await verifyPassword({ hash: after.password!, password: PASSWORD }), true);
  // Not a member of the account named: refused, even on a dry run.
  const outside = recover(["--email", "ada@example.test", ...local(), "--promote-owner", "--account", "acct2", "--dry-run"]);
  assert.equal(outside.code, 1);
  assert.match(outside.output, /not a member of the account acct2/u);
});

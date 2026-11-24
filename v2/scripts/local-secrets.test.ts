/**
 * `setup-local-secrets.ts` and `upload-local-secrets.ts`, in temporary
 * folders: the setup fills only empty secrets, in a file only its owner can
 * read, and prints no value; the upload hands every set value to Wrangler on
 * stdin for the Worker a config names. Wrangler is a stand-in here (a `pnpm`
 * on the PATH that records what it got), so nothing is uploaded anywhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const V2_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function script(name: string, args: string[], env: NodeJS.ProcessEnv = process.env): { code: number | null; output: string } {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", join(V2_DIR, "scripts", name), ...args], { cwd: V2_DIR, encoding: "utf8", env });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

function withFolder(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "agw-secrets-test-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the setup makes each missing secret in .dev.vars, readable only by its owner, and prints no value", () => {
  withFolder((dir) => {
    const first = script("setup-local-secrets.ts", ["--dir", dir]);
    assert.equal(first.code, 0, first.output);
    assert.match(first.output, /Made BETTER_AUTH_SECRET, JWT_SECRET, SECRET_VAULT_LOCAL_KEK_V1 in \.dev\.vars\./u);
    assert.match(first.output, /Back up SECRET_VAULT_LOCAL_KEK_V1/u);
    const path = join(dir, ".dev.vars");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const values = parseEnv(readFileSync(path, "utf8"));
    assert.ok(values.JWT_SECRET!.length >= 43);
    assert.ok(values.BETTER_AUTH_SECRET!.length >= 43);
    assert.equal(Buffer.from(values.SECRET_VAULT_LOCAL_KEK_V1!, "base64").length, 32);
    for (const value of Object.values(values)) assert.ok(!first.output.includes(value!), "a value was printed");
    // Run again: everything is there, and nothing changes.
    const second = script("setup-local-secrets.ts", ["--dir", dir]);
    assert.match(second.output, /nothing changed/u);
    assert.deepEqual(parseEnv(readFileSync(path, "utf8")), values);
  });
});

test("the setup keeps a value already set and fills only the empty ones", () => {
  withFolder((dir) => {
    const path = join(dir, ".dev.vars");
    writeFileSync(path, "JWT_SECRET=mine-and-long-enough-for-the-test-0123456789\nBETTER_AUTH_SECRET=\nOTHER=kept\n");
    const run = script("setup-local-secrets.ts", ["--dir", dir]);
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, /Made BETTER_AUTH_SECRET, SECRET_VAULT_LOCAL_KEK_V1 in \.dev\.vars\./u);
    const values = parseEnv(readFileSync(path, "utf8"));
    assert.equal(values.JWT_SECRET, "mine-and-long-enough-for-the-test-0123456789");
    assert.equal(values.OTHER, "kept");
    assert.ok(values.BETTER_AUTH_SECRET!.length >= 43);
  });
});

test("the setup reads the file as a dotenv parser does: spaced and quoted values count, and no key is defined twice", () => {
  withFolder((dir) => {
    const path = join(dir, ".dev.vars");
    writeFileSync(path, 'JWT_SECRET = "spaced-and-quoted-0123456789"\nexport BETTER_AUTH_SECRET = ""\nSECRET_VAULT_LOCAL_KEK_V1=\n');
    const run = script("setup-local-secrets.ts", ["--dir", dir]);
    assert.equal(run.code, 0, run.output);
    // The spaced, quoted value is set; the quoted empty one and the bare empty one are filled in place.
    assert.match(run.output, /Made BETTER_AUTH_SECRET, SECRET_VAULT_LOCAL_KEK_V1 in \.dev\.vars\./u);
    const text = readFileSync(path, "utf8");
    const values = parseEnv(text);
    assert.equal(values.JWT_SECRET, "spaced-and-quoted-0123456789");
    assert.ok(values.BETTER_AUTH_SECRET!.length >= 43);
    for (const name of ["JWT_SECRET", "BETTER_AUTH_SECRET", "SECRET_VAULT_LOCAL_KEK_V1"]) {
      assert.equal(text.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`, "gmu"))?.length, 1, `${name} is defined more than once`);
    }
  });
});

test("the upload needs the Worker's config, and sends every set value to Wrangler on stdin, never as an argument", () => {
  withFolder((dir) => {
    // A stand-in `pnpm` that records its arguments and its stdin.
    writeFileSync(join(dir, "pnpm"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(dir, "args")}"\nprintf '%s' "$WRANGLER_LOG_SANITIZE" > "${join(dir, "sanitize")}"\ncat > "${join(dir, "stdin")}"\n`);
    chmodSync(join(dir, "pnpm"), 0o755);
    writeFileSync(join(dir, ".dev.vars"), "JWT_SECRET=jwt-value-0123456789\nBETTER_AUTH_SECRET=auth-value-0123456789\nSECRET_VAULT_LOCAL_KEK_V1=\n");
    // A shell that asks Wrangler for its unsanitized logs.
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}`, WRANGLER_LOG_SANITIZE: "false" };

    const unnamed = script("upload-local-secrets.ts", ["--dir", dir], env);
    assert.equal(unnamed.code, 2);
    assert.match(unnamed.output, /-c <the Worker's Wrangler config>/u);

    const run = script("upload-local-secrets.ts", ["-c", "wrangler.example.jsonc", "--dir", dir], env);
    assert.equal(run.code, 0, run.output);
    assert.equal(readFileSync(join(dir, "args"), "utf8"), "exec\nwrangler\nsecret\nbulk\n-c\nwrangler.example.jsonc\n");
    // Wrangler's logs stay sanitized all the same.
    assert.equal(readFileSync(join(dir, "sanitize"), "utf8"), "true");
    // The empty value is left out, so it does not clear the Worker's own.
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "stdin"), "utf8")), { JWT_SECRET: "jwt-value-0123456789", BETTER_AUTH_SECRET: "auth-value-0123456789" });
    assert.match(run.output, /Uploaded BETTER_AUTH_SECRET, JWT_SECRET to the Worker in wrangler\.example\.jsonc\./u);
    assert.ok(!run.output.includes("jwt-value") && !run.output.includes("auth-value"), "a value was printed");
  });
});

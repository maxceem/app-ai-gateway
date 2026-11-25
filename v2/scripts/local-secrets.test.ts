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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    assert.match(first.output, /Made BETTER_AUTH_SECRET, JWT_SECRET in \.dev\.vars\./u);
    assert.match(first.output, /Made SECRET_VAULT_LOCAL_KEK_V1 in vault\/\.dev\.vars\./u);
    assert.match(first.output, /Back up SECRET_VAULT_LOCAL_KEK_V1/u);
    const path = join(dir, ".dev.vars");
    const vaultPath = join(dir, "vault", ".dev.vars");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(vaultPath).mode & 0o777, 0o600);
    const values = parseEnv(readFileSync(path, "utf8"));
    const vaultValues = parseEnv(readFileSync(vaultPath, "utf8"));
    assert.ok(values.JWT_SECRET!.length >= 43);
    assert.ok(values.BETTER_AUTH_SECRET!.length >= 43);
    // The vault's key is only the vault's: never in the gateway Worker's file (plan step 8i).
    assert.equal(values.SECRET_VAULT_LOCAL_KEK_V1, undefined);
    assert.equal(Buffer.from(vaultValues.SECRET_VAULT_LOCAL_KEK_V1!, "base64").length, 32);
    for (const value of [...Object.values(values), ...Object.values(vaultValues)]) assert.ok(!first.output.includes(value!), "a value was printed");
    // Run again: everything is there, and nothing changes.
    const second = script("setup-local-secrets.ts", ["--dir", dir]);
    assert.match(second.output, /nothing changed/u);
    assert.deepEqual(parseEnv(readFileSync(path, "utf8")), values);
    assert.deepEqual(parseEnv(readFileSync(vaultPath, "utf8")), vaultValues);
  });
});

test("the setup keeps a value already set and fills only the empty ones", () => {
  withFolder((dir) => {
    const path = join(dir, ".dev.vars");
    writeFileSync(path, "JWT_SECRET=mine-and-long-enough-for-the-test-0123456789\nBETTER_AUTH_SECRET=\nOTHER=kept\n");
    const run = script("setup-local-secrets.ts", ["--dir", dir]);
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, /Made BETTER_AUTH_SECRET in \.dev\.vars\./u);
    const values = parseEnv(readFileSync(path, "utf8"));
    assert.equal(values.JWT_SECRET, "mine-and-long-enough-for-the-test-0123456789");
    assert.equal(values.OTHER, "kept");
    assert.ok(values.BETTER_AUTH_SECRET!.length >= 43);
  });
});

test("the setup reads the file as a dotenv parser does: spaced and quoted values count, and no key is defined twice", () => {
  withFolder((dir) => {
    const path = join(dir, ".dev.vars");
    writeFileSync(path, 'JWT_SECRET = "spaced-and-quoted-0123456789"\nexport BETTER_AUTH_SECRET = ""\n');
    mkdirSync(join(dir, "vault"));
    const vaultPath = join(dir, "vault", ".dev.vars");
    writeFileSync(vaultPath, "SECRET_VAULT_LOCAL_KEK_V1=\n");
    const run = script("setup-local-secrets.ts", ["--dir", dir]);
    assert.equal(run.code, 0, run.output);
    // The spaced, quoted value is set; the quoted empty one and the bare empty one are filled in place.
    assert.match(run.output, /Made BETTER_AUTH_SECRET in \.dev\.vars\./u);
    assert.match(run.output, /Made SECRET_VAULT_LOCAL_KEK_V1 in vault\/\.dev\.vars\./u);
    const text = readFileSync(path, "utf8");
    const vaultText = readFileSync(vaultPath, "utf8");
    const values = parseEnv(text);
    assert.equal(values.JWT_SECRET, "spaced-and-quoted-0123456789");
    assert.ok(values.BETTER_AUTH_SECRET!.length >= 43);
    for (const [name, file] of [["JWT_SECRET", text], ["BETTER_AUTH_SECRET", text], ["SECRET_VAULT_LOCAL_KEK_V1", vaultText]] as const) {
      assert.equal(file.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`, "gmu"))?.length, 1, `${name} is defined more than once`);
    }
  });
});

test("the setup refuses a listed secret defined twice or over several lines, and changes nothing", () => {
  withFolder((dir) => {
    const path = join(dir, ".dev.vars");
    const cases: [string, RegExp][] = [
      ["JWT_SECRET=first-0123456789\nexport JWT_SECRET = \n", /JWT_SECRET is defined 2 times in \.dev\.vars/u],
      ['BETTER_AUTH_SECRET="first line\nsecond line"\n', /BETTER_AUTH_SECRET spans several lines in \.dev\.vars/u],
    ];
    for (const [text, message] of cases) {
      writeFileSync(path, text);
      const run = script("setup-local-secrets.ts", ["--dir", dir]);
      assert.equal(run.code, 1, run.output);
      assert.match(run.output, message);
      assert.match(run.output, /Nothing changed\./u);
      assert.equal(readFileSync(path, "utf8"), text);
    }
    // A problem in the vault's file stops both: the gateway's file is left as it was.
    rmSync(path);
    mkdirSync(join(dir, "vault"));
    const vaultText = "SECRET_VAULT_LOCAL_KEK_V1=a\nSECRET_VAULT_LOCAL_KEK_V1=b\n";
    writeFileSync(join(dir, "vault", ".dev.vars"), vaultText);
    const run = script("setup-local-secrets.ts", ["--dir", dir]);
    assert.equal(run.code, 1, run.output);
    assert.match(run.output, /SECRET_VAULT_LOCAL_KEK_V1 is defined 2 times in vault\/\.dev\.vars/u);
    assert.throws(() => readFileSync(path));
    assert.equal(readFileSync(join(dir, "vault", ".dev.vars"), "utf8"), vaultText);
  });
});

test("the upload needs the Worker's config, and sends every set value to Wrangler on stdin, never as an argument", () => {
  withFolder((dir) => {
    // A stand-in `pnpm` that records its arguments and its stdin, and a stand-in config with a staging environment.
    writeFileSync(join(dir, "pnpm"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(dir, "args")}"\nprintf '%s' "$WRANGLER_LOG_SANITIZE" > "${join(dir, "sanitize")}"\ncat > "${join(dir, "stdin")}"\n`);
    chmodSync(join(dir, "pnpm"), 0o755);
    writeFileSync(join(dir, "wrangler.stand-in.jsonc"), JSON.stringify({ name: "stand-in", main: "index.ts", compatibility_date: "2026-01-01", env: { staging: {} } }));
    const config = join(dir, "wrangler.stand-in.jsonc");
    writeFileSync(join(dir, ".dev.vars"), "JWT_SECRET=jwt-value-0123456789\nBETTER_AUTH_SECRET=auth-value-0123456789\nEMPTY_ONE=\n");
    // A shell that asks Wrangler for its unsanitized logs; `pnpm run` starts the script in its own folder, the caller's in INIT_CWD.
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}`, WRANGLER_LOG_SANITIZE: "false", INIT_CWD: dir, CLOUDFLARE_ENV: "" };

    // Refused, and nothing reaches Wrangler: no config, an environment from the shell, arguments it cannot read, an environment the config lacks.
    const refusals: [string[], NodeJS.ProcessEnv, RegExp][] = [
      [["--dir", dir], env, /-c <the Worker's Wrangler config>/u],
      [["-c", config, "--dir", dir], { ...env, CLOUDFLARE_ENV: "staging" }, /CLOUDFLARE_ENV is set \(staging\): name the environment with --env/u],
      [["-c", config, "-e", "staging"], env, /Unknown option '-e'/u],
      [["-c", config, "--env"], env, /--env <value>' argument missing/u],
      [["-c", config, "--env", ""], env, /--env needs a value/u],
      [["-c", config, "--env", "production"], env, /defines no environment production; nothing was uploaded/u],
    ];
    for (const [args, runEnv, message] of refusals) {
      const run = script("upload-local-secrets.ts", args, runEnv);
      assert.equal(run.code, 2, run.output);
      assert.match(run.output, message);
    }
    assert.throws(() => readFileSync(join(dir, "args")));

    // The config is taken from the caller's folder, and the environment named on the command line is what Wrangler is given.
    const run = script("upload-local-secrets.ts", ["-c", "wrangler.stand-in.jsonc", "--env=staging", "--dir", "."], { ...env, CLOUDFLARE_ENV: "staging" });
    assert.equal(run.code, 0, run.output);
    assert.equal(readFileSync(join(dir, "args"), "utf8"), `exec\nwrangler\nsecret\nbulk\n-c\n${config}\n--env\nstaging\n`);
    // Wrangler's logs stay sanitized all the same.
    assert.equal(readFileSync(join(dir, "sanitize"), "utf8"), "true");
    // The empty value is left out, so it does not clear the Worker's own.
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "stdin"), "utf8")), { JWT_SECRET: "jwt-value-0123456789", BETTER_AUTH_SECRET: "auth-value-0123456789" });
    assert.ok(run.output.includes(`Uploaded BETTER_AUTH_SECRET, JWT_SECRET to the Worker in ${config}, environment staging.`), run.output);
    assert.ok(!run.output.includes("jwt-value") && !run.output.includes("auth-value"), "a value was printed");
  });
});

test("the setup takes a quoted value with a comment after it, and makes an existing file readable only by its owner", () => {
  withFolder((dir) => {
    const path = join(dir, ".dev.vars");
    writeFileSync(path, 'JWT_SECRET="quoted-and-long-enough-0123456789" # mine\n', { mode: 0o644 });
    chmodSync(path, 0o644);
    const run = script("setup-local-secrets.ts", ["--dir", dir]);
    assert.equal(run.code, 0, run.output);
    assert.match(run.output, /Made BETTER_AUTH_SECRET in \.dev\.vars\./u);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(parseEnv(readFileSync(path, "utf8")).JWT_SECRET, "quoted-and-long-enough-0123456789");
  });
});

test("the upload leaves the vault's settings out for any Worker but the vault, and sends them to the vault", () => {
  withFolder((dir) => {
    writeFileSync(join(dir, "pnpm"), `#!/bin/sh\ncat > "${join(dir, "stdin")}"\n`);
    chmodSync(join(dir, "pnpm"), 0o755);
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}`, INIT_CWD: dir, CLOUDFLARE_ENV: "" };
    // An old gateway .dev.vars that still holds the vault key.
    writeFileSync(join(dir, ".dev.vars"), "JWT_SECRET=jwt-value-0123456789\nSECRET_VAULT_LOCAL_KEK_V1=kek-value-0123456789\nSECRET_VAULT_KMS_TOKEN=kms-value-0123456789\n");
    writeFileSync(join(dir, "wrangler.gateway.jsonc"), JSON.stringify({ name: "gateway", main: "src/index.ts", compatibility_date: "2026-01-01" }));
    const gateway = script("upload-local-secrets.ts", ["-c", "wrangler.gateway.jsonc", "--dir", "."], env);
    assert.equal(gateway.code, 0, gateway.output);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "stdin"), "utf8")), { JWT_SECRET: "jwt-value-0123456789" });
    assert.match(gateway.output, /Left out SECRET_VAULT_KMS_TOKEN, SECRET_VAULT_LOCAL_KEK_V1: only the vault Worker holds the vault's settings\./u);
    assert.ok(!gateway.output.includes("kek-value") && !gateway.output.includes("kms-value"), "a value was printed");

    // The vault's own config (it runs vault/src/index.js) gets them.
    const vaultConfig = join(dir, "wrangler.vault.jsonc");
    writeFileSync(vaultConfig, JSON.stringify({ name: "vault", main: join(V2_DIR, "vault", "src", "index.js"), compatibility_date: "2026-01-01" }));
    writeFileSync(join(dir, ".dev.vars"), "SECRET_VAULT_LOCAL_KEK_V1=kek-value-0123456789\n");
    const vault = script("upload-local-secrets.ts", ["-c", vaultConfig, "--dir", "."], env);
    assert.equal(vault.code, 0, vault.output);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "stdin"), "utf8")), { SECRET_VAULT_LOCAL_KEK_V1: "kek-value-0123456789" });
    assert.doesNotMatch(vault.output, /Left out/u);
  });
});

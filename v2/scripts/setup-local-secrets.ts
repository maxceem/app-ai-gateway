/**
 * Fills the v2 Worker's local secrets in `.dev.vars` (v1's
 * `setup-local-secrets`, ported): each secret `.dev.vars.example` lists that
 * has no value yet gets a fresh random one. A value already there is kept.
 *
 *   node --experimental-strip-types scripts/setup-local-secrets.ts [--dir <folder>]
 *
 * - It writes only `.dev.vars` in the v2 folder (or `--dir`), which git
 *   ignores, readable only by this user. Nothing is committed or uploaded.
 * - It prints the names of the secrets it made, never their values.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const V2_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** How each secret is made: what `.dev.vars.example` asks of it. */
const MAKERS: Readonly<Record<string, () => string>> = {
  // At least 32 bytes.
  JWT_SECRET: () => randomBytes(48).toString("base64url"),
  BETTER_AUTH_SECRET: () => randomBytes(48).toString("base64url"),
  // Exactly 32 bytes, base64.
  SECRET_VAULT_LOCAL_KEK_V1: () => randomBytes(32).toString("base64"),
};

const at = process.argv.indexOf("--dir");
const dir = at === -1 ? V2_DIR : process.argv[at + 1];
if (dir === undefined) {
  console.error("usage: setup-local-secrets.ts [--dir <folder>]");
  process.exit(2);
}

const example = readFileSync(join(V2_DIR, ".dev.vars.example"), "utf8");
const path = join(dir, ".dev.vars");
let contents = existsSync(path) ? readFileSync(path, "utf8") : example;

/** The names `.dev.vars.example` lists, in its order. */
const names = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gmu)].map((match) => match[1]!);

const made: string[] = [];
for (const name of names) {
  const line = new RegExp(`^${name}=(.*)$`, "mu");
  if ((line.exec(contents)?.[1]?.trim() ?? "") !== "") continue;
  const maker = MAKERS[name];
  if (maker === undefined) continue;
  const value = maker();
  contents = line.test(contents) ? contents.replace(line, `${name}=${value}`) : `${contents.trimEnd()}\n${name}=${value}\n`;
  made.push(name);
}

writeFileSync(path, contents, { mode: 0o600 });
chmodSync(path, 0o600);
if (made.length === 0) {
  console.log(".dev.vars already holds every secret; nothing changed.");
} else {
  console.log(`Made ${made.join(", ")} in .dev.vars.`);
  if (made.includes("SECRET_VAULT_LOCAL_KEK_V1")) {
    console.log("Back up SECRET_VAULT_LOCAL_KEK_V1 before you store provider keys: without it, they cannot be opened.");
  }
}

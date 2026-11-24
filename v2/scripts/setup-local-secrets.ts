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
import { parseEnv } from "node:util";

const V2_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** How each secret is made: what `.dev.vars.example` asks of it. */
const MAKERS: Readonly<Record<string, () => string>> = {
  // At least 32 bytes.
  JWT_SECRET: () => randomBytes(48).toString("base64url"),
  BETTER_AUTH_SECRET: () => randomBytes(48).toString("base64url"),
  // Exactly 32 bytes, base64.
  SECRET_VAULT_LOCAL_KEK_V1: () => randomBytes(32).toString("base64"),
};

function refuse(message: string): never {
  console.error(message);
  process.exit(1);
}

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
const names = Object.keys(parseEnv(example));

/** A line that defines `name`, with or without `export` and spaces. */
const definition = (name: string) => new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=(.*)$`, "gmu");

// A listed secret defined twice, or over several lines, is for a person to sort out: this script would
// otherwise rewrite one definition while another is the one read.
for (const name of names) {
  if (MAKERS[name] === undefined) continue;
  const found = [...contents.matchAll(definition(name))];
  if (found.length > 1) refuse(`${name} is defined ${found.length} times in .dev.vars; keep one and run again. Nothing changed.`);
  const value = found[0]?.[1]?.trim() ?? "";
  const quote = value[0];
  if ((quote === '"' || quote === "'" || quote === "`") && (value.length < 2 || !value.endsWith(quote))) {
    refuse(`${name} spans several lines in .dev.vars; put it on one line and run again. Nothing changed.`);
  }
}

const made: string[] = [];
const unchanged: string[] = [];
const generated: Record<string, string> = {};
for (const name of names) {
  const maker = MAKERS[name];
  if (maker === undefined) continue;
  // Whether it is set, as a dotenv parser reads the file: spaces around `=`,
  // quotes and `export` are the parser's to judge, not a pattern's.
  const current = parseEnv(contents)[name];
  if (current !== undefined && current.trim() !== "") continue;
  const value = maker();
  if (current === undefined) {
    contents = `${contents.trimEnd()}\n${name}=${value}\n`;
  } else {
    // Defined but empty: that one definition is replaced, never joined by a second.
    const line = new RegExp(definition(name).source, "mu");
    if (!line.test(contents)) {
      unchanged.push(name);
      continue;
    }
    contents = contents.replace(line, `${name}=${value}`);
  }
  generated[name] = value;
  made.push(name);
}

// Read back as a dotenv parser reads it: every value made is there exactly, or nothing is written.
const reread = parseEnv(contents);
for (const [name, value] of Object.entries(generated)) {
  if (reread[name] !== value) refuse(`.dev.vars would not read back ${name} as made; nothing changed. Check the file by hand.`);
}
writeFileSync(path, contents, { mode: 0o600 });
chmodSync(path, 0o600);
for (const name of unchanged) console.log(`${name} is defined but empty in a form this script does not rewrite; set it by hand.`);
if (made.length === 0) {
  console.log(".dev.vars already holds every secret; nothing changed.");
} else {
  console.log(`Made ${made.join(", ")} in .dev.vars.`);
  if (made.includes("SECRET_VAULT_LOCAL_KEK_V1")) {
    console.log("Back up SECRET_VAULT_LOCAL_KEK_V1 before you store provider keys: without it, they cannot be opened.");
  }
}

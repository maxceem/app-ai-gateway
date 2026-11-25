/**
 * Fills the local secrets of the v2 Workers (v1's `setup-local-secrets`,
 * ported): each secret an example file lists that has no value yet gets a
 * fresh random one. A value already there is kept.
 *
 * - The gateway Worker's, in `.dev.vars`, from `.dev.vars.example`.
 * - The vault Worker's, in `vault/.dev.vars`, from `vault/.dev.vars.example`:
 *   the vault's key lives only there, never in the gateway's file (step 8i).
 *
 *   node --experimental-strip-types scripts/setup-local-secrets.ts [--dir <folder>]
 *
 * - It writes only those two files under the v2 folder (or `--dir`), which git
 *   ignores, readable only by this user. Nothing is committed or uploaded.
 * - It prints the names of the secrets it made, never their values.
 * - If either file has a problem, neither is changed.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";

const V2_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** How each secret is made: what `.dev.vars.example` asks of it. */
const MAKERS: Readonly<Record<string, () => string>> = {
  // At least 32 bytes.
  JWT_SECRET: () => randomBytes(48).toString("base64url"),
  BETTER_AUTH_SECRET: () => randomBytes(48).toString("base64url"),
  // The vault Worker's key: exactly 32 bytes, base64.
  SECRET_VAULT_LOCAL_KEK_V1: () => randomBytes(32).toString("base64"),
};

function refuse(message: string): never {
  console.error(message);
  process.exit(1);
}

let given: { dir?: string };
try {
  given = parseArgs({ // `pnpm run <script> -- …` passes its `--` on.
    args: process.argv.slice(process.argv[2] === "--" ? 3 : 2), strict: true, allowPositionals: false, options: { dir: { type: "string" } } }).values;
} catch (error) {
  console.error(`${(error as Error).message}\nusage: setup-local-secrets.ts [--dir <folder>]`);
  process.exit(2);
}
if (given.dir !== undefined && given.dir.trim() === "") {
  console.error("--dir needs a value");
  process.exit(2);
}
// From the folder the command was run in (`pnpm run` moves to the package's own; `INIT_CWD` keeps the caller's).
const dir = given.dir === undefined ? V2_DIR : resolve(process.env.INIT_CWD ?? process.cwd(), given.dir);

/** A line that defines `name`, with or without `export` and spaces. */
const definition = (name: string) => new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=(.*)$`, "gmu");

interface SecretsFile {
  /** How it is named in messages. */
  readonly label: string;
  readonly path: string;
  /** The names its example lists, in its order. */
  readonly names: readonly string[];
  contents: string;
  readonly made: string[];
}

function secretsFile(label: string, example: string, path: string): SecretsFile {
  const text = readFileSync(example, "utf8");
  return { label, path, names: Object.keys(parseEnv(text)), contents: existsSync(path) ? readFileSync(path, "utf8") : text, made: [] };
}

const files = [
  secretsFile(".dev.vars", join(V2_DIR, ".dev.vars.example"), join(dir, ".dev.vars")),
  secretsFile("vault/.dev.vars", join(V2_DIR, "vault", ".dev.vars.example"), join(dir, "vault", ".dev.vars")),
];

// A listed secret defined twice, or over several lines, is for a person to sort out: this script would
// otherwise rewrite one definition while another is the one read. Checked in both files before either is written.
for (const file of files) {
  for (const name of file.names) {
    if (MAKERS[name] === undefined) continue;
    const found = [...file.contents.matchAll(definition(name))];
    if (found.length > 1) refuse(`${name} is defined ${found.length} times in ${file.label}; keep one and run again. Nothing changed.`);
    // A quoted value opens on this line and must close on it, a comment after it allowed.
    const value = found[0]?.[1]?.trim() ?? "";
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === "`") && value.indexOf(quote, 1) === -1) {
      refuse(`${name} spans several lines in ${file.label}; put it on one line and run again. Nothing changed.`);
    }
  }
}

for (const file of files) {
  for (const name of file.names) {
    const maker = MAKERS[name];
    if (maker === undefined) continue;
    // Whether it is set, as a dotenv parser reads the file: spaces around `=`,
    // quotes and `export` are the parser's to judge, not a pattern's.
    const current = parseEnv(file.contents)[name];
    if (current !== undefined && current.trim() !== "") continue;
    const value = maker();
    if (current === undefined) {
      file.contents = `${file.contents.trimEnd()}\n${name}=${value}\n`;
    } else {
      // Defined but empty (and defined once, as checked above): that definition is replaced.
      file.contents = file.contents.replace(new RegExp(definition(name).source, "mu"), `${name}=${value}`);
    }
    file.made.push(name);
  }
}

for (const file of files) {
  mkdirSync(dirname(file.path), { recursive: true });
  // Opened without emptying it, made readable only by this user, and only then written: a mode
  // that cannot be set leaves the file as it was.
  const fd = openSync(file.path, constants.O_RDWR | constants.O_CREAT, 0o600);
  try {
    try {
      fchmodSync(fd, 0o600);
    } catch {
      refuse(`${file.label} could not be made readable only by you; nothing was written to it.`);
    }
    ftruncateSync(fd, 0);
    writeSync(fd, file.contents, 0);
  } finally {
    closeSync(fd);
  }
}
const made = files.filter((file) => file.made.length > 0);
if (made.length === 0) {
  console.log("Every secret is already set; nothing changed.");
} else {
  for (const file of made) console.log(`Made ${file.made.join(", ")} in ${file.label}.`);
  if (made.some((file) => file.made.includes("SECRET_VAULT_LOCAL_KEK_V1"))) {
    console.log("Back up SECRET_VAULT_LOCAL_KEK_V1 before you store provider keys: without it, they cannot be opened.");
  }
}

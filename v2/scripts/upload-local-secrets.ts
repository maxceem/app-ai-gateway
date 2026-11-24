/**
 * Uploads the secrets in `.dev.vars` to the Worker a Wrangler config names
 * (v1's `upload-local-secrets`, ported), with `wrangler secret bulk`.
 *
 *   node --experimental-strip-types scripts/upload-local-secrets.ts -c <wrangler config> [--env <name>] [--dir <folder>]
 *
 * - It overwrites the Worker's values with the local ones, the vault key
 *   included: a new local `SECRET_VAULT_LOCAL_KEK_V1` uploaded to a deployment
 *   that already stores provider keys makes those keys unreadable.
 * - The Worker is the one the config (and `--env`, which the config must
 *   define) names: there is no default. It stops when `CLOUDFLARE_ENV` is set
 *   without `--env`. The rest of the operator's shell and `.env` settings are
 *   theirs to keep right. Paths are taken from the folder the command was run in.
 * - The values go to Wrangler on stdin, never as arguments, and are never
 *   printed: only the names are.
 * - An empty value is left out, so a secret not set locally is not cleared.
 * - Wrangler runs with `WRANGLER_LOG_SANITIZE=true`, so its own debug logs
 *   never hold the values, whatever the shell sets.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";

const USAGE = "usage: upload-local-secrets.ts -c <the Worker's Wrangler config> [--env <name>] [--dir <folder>]";
const V2_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
/** The folder the command was run in (`pnpm run` moves to the package's own; `INIT_CWD` keeps the caller's). */
const CALLER_DIR = process.env.INIT_CWD ?? process.cwd();

function refuse(message: string): never {
  console.error(message);
  process.exit(2);
}
let parsed: { config?: string; env?: string; dir?: string };
try {
  parsed = parseArgs({
    // `pnpm run <script> -- …` passes its `--` on.
    args: process.argv.slice(process.argv[2] === "--" ? 3 : 2),
    strict: true,
    allowPositionals: false,
    options: { config: { type: "string", short: "c" }, env: { type: "string" }, dir: { type: "string" } },
  }).values;
} catch (error) {
  refuse(`${(error as Error).message}\n${USAGE}`);
}
for (const name of ["config", "env", "dir"] as const) {
  if (parsed[name] !== undefined && parsed[name].trim() === "") refuse(`--${name} needs a value\n${USAGE}`);
}
if (parsed.config === undefined) refuse(USAGE);
const config = resolve(CALLER_DIR, parsed.config);
const envName = parsed.env;
const dir = parsed.dir === undefined ? V2_DIR : resolve(CALLER_DIR, parsed.dir);
const shellEnv = process.env.CLOUDFLARE_ENV;
if (shellEnv !== undefined && shellEnv !== "" && envName === undefined) {
  refuse(`CLOUDFLARE_ENV is set (${shellEnv}): name the environment with --env, so the Worker is never taken from the shell`);
}
if (envName !== undefined) {
  const { experimental_readRawConfig } = await import("wrangler");
  const raw = experimental_readRawConfig({ config }) as { rawConfig: { env?: Record<string, unknown> } };
  if (raw.rawConfig.env?.[envName] === undefined) refuse(`${config} defines no environment ${envName}; nothing was uploaded.`);
}

const values = Object.fromEntries(
  Object.entries(parseEnv(readFileSync(join(dir, ".dev.vars"), "utf8"))).filter(([, value]) => value !== undefined && value.trim() !== ""),
);
const names = Object.keys(values).sort();
if (names.length === 0) {
  console.error(".dev.vars holds no values to upload; run setup-local-secrets.ts first.");
  process.exit(1);
}

// The shell's environment, without CLOUDFLARE_ENV (--env says it).
const { CLOUDFLARE_ENV: _ignored, ...shell } = process.env;
const result = spawnSync("pnpm", ["exec", "wrangler", "secret", "bulk", "-c", config, ...(envName === undefined ? [] : ["--env", envName])], {
  cwd: V2_DIR,
  input: JSON.stringify(values),
  // Wrangler's own logs hide request and response bodies, whatever the shell says.
  env: { ...shell, WRANGLER_LOG_SANITIZE: "true" },
  stdio: ["pipe", "inherit", "inherit"],
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Uploaded ${names.join(", ")} to the Worker in ${config}${envName === undefined ? "" : `, environment ${envName}`}.`);

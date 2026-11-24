/**
 * Uploads the secrets in `.dev.vars` to the Worker a Wrangler config names
 * (v1's `upload-local-secrets`, ported), with `wrangler secret bulk`.
 *
 *   node --experimental-strip-types scripts/upload-local-secrets.ts -c <wrangler config> [--dir <folder>]
 *
 * - The Worker is the one the config (and `--env`) names: there is no
 *   default. It stops when `CLOUDFLARE_ENV` is set without `--env`. The rest
 *   of the operator's shell and `.env` settings are theirs to keep right.
 * - The values go to Wrangler on stdin, never as arguments, and are never
 *   printed: only the names are.
 * - An empty value is left out, so a secret not set locally is not cleared.
 * - Wrangler runs with `WRANGLER_LOG_SANITIZE=true`, so its own debug logs
 *   never hold the values, whatever the shell sets.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const V2_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const config = option("-c");
const envName = option("--env");
const dir = args.includes("--dir") ? option("--dir") : V2_DIR;
function refuse(message: string): never {
  console.error(message);
  process.exit(2);
}
if (config === undefined || dir === undefined) refuse("usage: upload-local-secrets.ts -c <the Worker's Wrangler config> [--env <name>] [--dir <folder>]");
const shellEnv = process.env.CLOUDFLARE_ENV;
if (shellEnv !== undefined && shellEnv !== "" && envName === undefined) {
  refuse(`CLOUDFLARE_ENV is set (${shellEnv}): name the environment with --env, so the Worker is never taken from the shell`);
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

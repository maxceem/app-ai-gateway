/**
 * Uploads the secrets in `.dev.vars` to the Worker a Wrangler config names
 * (v1's `upload-local-secrets`, ported), with `wrangler secret bulk`.
 *
 *   node --experimental-strip-types scripts/upload-local-secrets.ts -c <wrangler config> [--dir <folder>]
 *
 * - The Worker is the one the config names: there is no default.
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
const dir = args.includes("--dir") ? option("--dir") : V2_DIR;
if (config === undefined || dir === undefined) {
  console.error("usage: upload-local-secrets.ts -c <the Worker's Wrangler config> [--dir <folder>]");
  process.exit(2);
}

const values = Object.fromEntries(
  Object.entries(parseEnv(readFileSync(join(dir, ".dev.vars"), "utf8"))).filter(([, value]) => value !== undefined && value.trim() !== ""),
);
const names = Object.keys(values).sort();
if (names.length === 0) {
  console.error(".dev.vars holds no values to upload; run setup-local-secrets.ts first.");
  process.exit(1);
}

const result = spawnSync("pnpm", ["exec", "wrangler", "secret", "bulk", "-c", config], {
  cwd: V2_DIR,
  input: JSON.stringify(values),
  // Wrangler's own logs hide request and response bodies, whatever the shell says.
  env: { ...process.env, WRANGLER_LOG_SANITIZE: "true" },
  stdio: ["pipe", "inherit", "inherit"],
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Uploaded ${names.join(", ")} to the Worker in ${config}.`);

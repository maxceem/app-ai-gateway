/**
 * Builds v2 for a prebuilt deploy (`deploy.ts --prebuilt <dir>`):
 *
 *   node --experimental-strip-types scripts/build-prebuilt.ts [dir]    # default dist/prebuilt
 *
 * writes
 * - `<dir>/worker/index.js`: the gateway, bundled from the tracked `wrangler.jsonc`;
 * - `<dir>/console`: the console's static files;
 * - `<dir>/vault/src` and `<dir>/relay/src`: the vault's and the relay's plain
 *   files, copied as they are. They have no build; the deploy checks they are
 *   the ones in git before it uploads them.
 *
 * The release runs this in a job without deploy secrets, so no package code
 * runs where the secrets are.
 */
import { spawnSync } from "node:child_process";
import { cp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const V2_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_DIR = dirname(V2_DIR);
// A relative path starts at the folder it runs in (`v2/` through `pnpm run`), as in `deploy.ts`.
const out = resolve(process.cwd(), process.argv[2] ?? join(V2_DIR, "dist", "prebuilt"));

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

try {
  await rm(out, { recursive: true, force: true });
  run("pnpm", ["--filter", "@app-ai-gateway/console-v2", "build"], REPO_DIR);
  // No profile: the bundle depends only on the tracked file.
  run("pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--outdir", join(out, "worker"), "--config", join(V2_DIR, "wrangler.jsonc")], V2_DIR);
  // Neither is deployed: the map is not uploaded and the README is Wrangler's note.
  await rm(join(out, "worker", "index.js.map"), { force: true });
  await rm(join(out, "worker", "README.md"), { force: true });
  await cp(join(V2_DIR, "console", "dist"), join(out, "console"), { recursive: true });
  for (const name of ["vault", "relay"]) await cp(join(V2_DIR, name, "src"), join(out, name, "src"), { recursive: true });
  console.log(`Built v2 into ${out}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

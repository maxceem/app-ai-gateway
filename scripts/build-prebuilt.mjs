#!/usr/bin/env node
// Builds the gateway for a prebuilt deployment:
//
//   node scripts/build-prebuilt.mjs [dir]    # default dist/prebuilt
//
// writes `<dir>/worker/index.js`, the Worker bundled from the tracked
// wrangler.jsonc, and `<dir>/console`, the console's static assets. Then
// `node scripts/deploy.mjs --profile <name> --prebuilt <dir>` deploys exactly
// those files with Wrangler alone. The release runs this in a job without
// deploy secrets, so no package code runs where the secrets are.
import { spawnSync } from "node:child_process";
import { cp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pricesDefines, pricesRevision } from "./prices-revision.mjs";
import { projectRoot } from "./wrangler-config.mjs";

const out = resolve(projectRoot, process.argv[2] ?? "dist/prebuilt");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
}

try {
  await rm(out, { recursive: true, force: true });
  run("pnpm", ["run", "console:build"]);
  // No profile: the bundle depends only on the tracked file, and the deploy
  // refuses a profile that changes how it would have been built.
  // The price list it carries, which `GET /v1/cli/capabilities` reports.
  const defines = pricesDefines(pricesRevision());
  run(process.execPath, ["scripts/wrangler.mjs", "deploy", "--dry-run", "--outdir", join(out, "worker"), ...defines]);
  // Neither is deployed: the map is not uploaded and the README is Wrangler's note.
  await rm(join(out, "worker/index.js.map"), { force: true });
  await rm(join(out, "worker/README.md"), { force: true });
  await cp(join(projectRoot, "console/dist"), join(out, "console"), { recursive: true });
  console.log(`Built the gateway into ${out}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

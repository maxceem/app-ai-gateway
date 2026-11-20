// Builds the v2 CLI in this checkout and runs it against state of its own.
//
// `agw` keeps its sign-in under `$XDG_STATE_HOME` and the gateway's tool list
// under `$XDG_CACHE_HOME`. A build being tried out here would otherwise share
// them with an installed copy, so both point at `v2/.agw-dev/` instead, which
// `--reset` removes in one go.
//
//   pnpm v2:cli:dev deployment status
//   pnpm v2:cli:dev --reset
//
// `AGW_DEV_HOME` moves the directory.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const home = process.env["AGW_DEV_HOME"] ?? join(root, ".agw-dev");
const argv = process.argv.slice(2);

if (argv[0] === "--reset") {
  const existed = existsSync(home);
  await rm(home, { recursive: true, force: true });
  process.stderr.write(existed ? `Removed ${home}\n` : `Nothing to remove at ${home}\n`);
  process.exit(0);
}

try {
  await import("./build.mjs");
} catch {
  // esbuild has already said what is wrong with the sources.
  process.exit(1);
}

await mkdir(join(home, "state"), { recursive: true, mode: 0o700 });
await mkdir(join(home, "cache"), { recursive: true, mode: 0o700 });
const child = spawn(process.execPath, [join(root, "cli/dist/agw.mjs"), ...argv], {
  stdio: "inherit",
  env: { ...process.env, XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache") },
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));

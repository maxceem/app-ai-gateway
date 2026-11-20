// Builds the CLI in this checkout and runs it against a state directory of its own.
//
// `agw` keeps connections, management keys, vault keys and installation
// journals under `$XDG_STATE_HOME`, and caches downloaded gateway releases
// under `$XDG_CACHE_HOME`. A build being tried out here would otherwise write
// into the same directories an installed copy reads, so a deployment made while
// testing would appear among real ones and a half-finished experiment would be
// left for the installed CLI to resume. Both are pointed at `.agw-dev/`
// instead, which `--reset` removes in one go.
//
//   pnpm cli:dev deployment status
//   pnpm cli:dev:reset
//
// `--reset` rather than a `reset` word, so that it cannot be mistaken for a
// command this CLI might one day have. `AGW_DEV_HOME` moves the directory;
// keeping two of them is how to hold two independent dev deployments at once.
//
// The bundle is rebuilt on every run. It costs about 0.2s, which is less than
// the time it takes to wonder whether the last edit made it in; the gateway
// release beside it is the slow half, and `release:build` is what makes that.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const home = process.env["AGW_DEV_HOME"] ?? join(root, ".agw-dev");
const bundle = join(root, "cli/dist/agw.mjs");
const argv = process.argv.slice(2);
// Readable from where it is being run: a path inside the checkout reads better
// relative, and one outside it reads better whole than as a row of `..`.
const shown = (path) => {
  const near = relative(process.cwd(), path);
  return near && !near.startsWith("..") ? near : path;
};

if (argv[0] === "--reset") {
  const existed = existsSync(home);
  await rm(home, { recursive: true, force: true });
  process.stderr.write(
    existed ? `Removed ${shown(home)}\n` : `Nothing to remove at ${shown(home)}\n`,
  );
  process.exit(0);
}

try {
  await import("./build.mjs");
} catch {
  // esbuild has already said what is wrong with the sources.
  process.exit(1);
}

// Rebuilding never produces this half: it is the gateway the CLI uploads, not
// the CLI itself. Said once here rather than left to the `release_missing` a
// deployment command would raise, which cannot name a command in a checkout it
// knows nothing about.
if (!existsSync(join(root, "cli", "dist", "release")))
  process.stderr.write(
    "Note: this checkout has no gateway release, which `deployment setup`, `update`\n" +
      "and `domain` need. Build one: pnpm --filter @maxceem/agw release:build\n",
  );

// Created ahead of the run so the CLI's own 0700 checks see a directory that
// was never world-readable, the same way its real state directory is made.
await mkdir(join(home, "state"), { recursive: true, mode: 0o700 });
await mkdir(join(home, "cache"), { recursive: true, mode: 0o700 });

const child = spawn(process.execPath, [bundle, ...argv], {
  stdio: "inherit",
  env: {
    ...process.env,
    XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"),
    // Windows reads one directory for both; `reset` removes it just the same.
    LOCALAPPDATA: home,
  },
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

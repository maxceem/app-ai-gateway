#!/usr/bin/env node
// Which model price list a build carries: the last commit, on this branch's own
// line of merges, that changed src/usage/models.json, and that commit's day.
//
//   node scripts/prices-revision.mjs   # prints revision=… and updated=…, and
//                                      # appends them to $GITHUB_OUTPUT
//
// Builds bake both into the Worker (`GET /v1/cli/capabilities` reports them)
// and the console (Settings shows the day), and every deploy names them to the
// post-deploy check. A prices deploy builds a release's tree with main's price
// list, whose history that checkout lacks, so it passes them in as
// PRICES_REVISION and PRICES_UPDATED. Without git, both are null.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PRICES = "src/usage/models.json";
const REVISION = /^[0-9a-f]{7,40}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const root = fileURLToPath(new URL("..", import.meta.url));

/** `{ revision, updated }`: a short commit hash and a `YYYY-MM-DD` day, or nulls. */
export function pricesRevision(env = process.env, cwd = root) {
  const given = { revision: env.PRICES_REVISION?.trim(), updated: env.PRICES_UPDATED?.trim() };
  if (given.revision || given.updated) {
    if (!REVISION.test(given.revision ?? "") || !DAY.test(given.updated ?? "")) {
      throw new Error("PRICES_REVISION must be a commit hash and PRICES_UPDATED a YYYY-MM-DD day, both set");
    }
    return { revision: given.revision, updated: given.updated };
  }
  const log = spawnSync("git", ["log", "-1", "--first-parent", "--format=%h %cs", "--abbrev=7", "--", PRICES], {
    cwd,
    encoding: "utf8",
  });
  const [revision, updated] = log.status === 0 ? log.stdout.trim().split(" ") : [];
  return REVISION.test(revision ?? "") && DAY.test(updated ?? "")
    ? { revision, updated }
    : { revision: null, updated: null };
}

/** Wrangler arguments that bake the revision into the Worker bundle, or none. */
export function pricesDefines(prices) {
  return prices.revision
    ? ["--define", `PRICES_REVISION:${JSON.stringify(prices.revision)}`, "--define", `PRICES_UPDATED:${JSON.stringify(prices.updated)}`]
    : [];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const prices = pricesRevision();
    const lines = [`revision=${prices.revision ?? ""}`, `updated=${prices.updated ?? ""}`];
    console.log(lines.join("\n"));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
// Fails when a pull request touches the released identity of the repository:
//
//   node scripts/check-version-unchanged.mjs <base-ref>
//
// The `version` of `package.json` and of `cli/package.json`, and the
// `upgradeFrom` list in `cli/package.json`, are written by
// `pnpm run release <version>` and by nothing else. A release is triggered by a
// pushed `vX.Y.Z` tag, so a bumped field in a pull request cannot start one — it
// can only make the tag and the manifests disagree, which the release workflow
// then refuses, or silently claim a schema compatibility nobody decided on.
//
// Run from `.github/workflows/ci.yml` on pull requests only. The base ref must
// already be fetched (`fetch-depth: 0`).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { versionGuardFindings, versionGuardMessage } from "./release-lib.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const MANIFESTS = ["package.json", "cli/package.json"];

function showAtRef(ref, path) {
  const result = spawnSync("git", ["show", `${ref}:${path}`], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Cannot read ${path} at ${ref}:\n${result.stderr ?? ""}`);
  }
  return result.stdout;
}

try {
  const base = process.argv[2];
  if (!base) throw new Error("Usage: node scripts/check-version-unchanged.mjs <base-ref>");

  const [baseRoot, baseCli] = MANIFESTS.map((path) => showAtRef(base, path));
  const [headRoot, headCli] = MANIFESTS.map((path) =>
    readFileSync(join(projectRoot, path), "utf8"),
  );

  const findings = versionGuardFindings({ baseRoot, headRoot, baseCli, headCli });
  if (findings.length > 0) {
    console.error(versionGuardMessage(findings));
    process.exitCode = 1;
  } else {
    console.log("The version fields match the base branch.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

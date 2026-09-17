#!/usr/bin/env node
// Cuts a release of the gateway and the CLI:
//
//   pnpm run release <version>                     # e.g. pnpm run release 0.1.8
//   pnpm run release <version> --dry-run           # print the plan, write nothing
//   pnpm run release <version> --breaks-upgrades   # do not carry the previous release forward
//   pnpm run release <version> --message "..."     # extra paragraph in the commit body
//
// This is the only thing the project owner runs. It bumps both manifests, type
// checks, commits `Release X.Y.Z`, tags `vX.Y.Z` and pushes the commit and the
// tag together. Everything after that — the tests, the gateway archive, the
// GitHub release, the Cloudflare deployment, npm and the documentation — is
// done by `.github/workflows/release.yml`, which the pushed tag triggers.
//
// Not to be confused with `cli/scripts/release.mjs`: that one is the release
// *build*, which packs the deployable gateway into `cli/dist/gateway-X.Y.Z.tar.gz`
// for the CLI to download. It runs in CI, from this script's tag.
//
// `--breaks-upgrades` is a human decision and cannot be inferred. By default the
// version being replaced is prepended to `cli/package.json` `upgradeFrom`, which
// is this release's claim that it can migrate a deployment of that version's
// database (see `cli/scripts/manifest.mjs`). Pass the flag when this release
// cannot: existing deployments then have to step through an earlier version, and
// failing that way round is the safe one.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyRelease } from "./release-lib.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const BRANCH = "main";

function parseArguments(argv) {
  const options = { dryRun: false, includePrevious: true, message: "" };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--breaks-upgrades") options.includePrevious = false;
    else if (arg === "--message" || arg === "-m") {
      options.message = argv[index + 1] ?? "";
      index += 1;
      if (!options.message) throw new Error("--message requires a value");
    } else if (arg.startsWith("--message=")) options.message = arg.slice("--message=".length);
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 1) {
    throw new Error(
      "Usage: pnpm run release <version> [--dry-run] [--breaks-upgrades] [--message <text>]",
    );
  }
  return { version: positional[0].replace(/^v/u, ""), ...options };
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr ?? ""}`);
  }
  return result;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/**
 * Everything that makes this checkout a safe place to cut a release from.
 *
 * Checked before a single byte is written, because the tag is what triggers the
 * release workflow: a tag pushed from a stale branch, or one that already
 * exists on the remote, would either release the wrong tree or collide with a
 * published archive whose digest is baked into a published CLI bundle.
 */
function assertCheckoutIsReleasable(version) {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  if (branch !== BRANCH) throw new Error(`Releases are cut from ${BRANCH}; this checkout is on ${branch}.`);

  const status = git(["status", "--porcelain"]).stdout.trim();
  if (status) throw new Error(`The working tree has uncommitted changes:\n${status}`);

  console.log("Fetching origin ...");
  git(["fetch", "--prune", "--tags", "origin"]);

  const local = git(["rev-parse", "HEAD"]).stdout.trim();
  const remote = git(["rev-parse", `origin/${BRANCH}`]).stdout.trim();
  if (local !== remote) {
    throw new Error(
      `HEAD is ${local.slice(0, 8)} but origin/${BRANCH} is ${remote.slice(0, 8)}. ` +
        `Pull or push until they agree; the workflow refuses a tag that is not on ${BRANCH}.`,
    );
  }

  const tag = `v${version}`;
  if (git(["rev-parse", "--verify", `refs/tags/${tag}`], { allowFailure: true }).status === 0) {
    throw new Error(`Tag ${tag} already exists locally.`);
  }
  const onOrigin = git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`], { allowFailure: true });
  if (onOrigin.stdout.trim()) throw new Error(`Tag ${tag} already exists on origin.`);
}

function commitMessage(version, extra) {
  return extra ? `Release ${version}\n\n${extra}\n` : `Release ${version}\n`;
}

try {
  const { version, dryRun, includePrevious, message } = parseArguments(process.argv.slice(2));
  const rootPath = join(projectRoot, "package.json");
  const cliPath = join(projectRoot, "cli/package.json");
  const plan = applyRelease({
    rootText: readFileSync(rootPath, "utf8"),
    cliText: readFileSync(cliPath, "utf8"),
    version,
    includePrevious,
  });
  const tag = `v${version}`;

  if (!dryRun) assertCheckoutIsReleasable(version);

  console.log(`\nRelease ${plan.previousVersion} -> ${version}`);
  console.log(`  package.json and cli/package.json version: ${version}`);
  console.log(`  cli/package.json upgradeFrom: ${JSON.stringify(plan.upgradeFrom)}`);
  if (!includePrevious) {
    console.log(`  (${plan.previousVersion} is NOT carried forward: this release breaks upgrades)`);
  }
  console.log(`  commit: ${commitMessage(version, message).split("\n")[0]}`);
  console.log(`  tag:    ${tag}`);
  console.log(`  push:   git push --atomic origin ${BRANCH} ${tag}\n`);

  if (dryRun) {
    console.log("Dry run: nothing was written, committed, tagged or pushed.");
    process.exit(0);
  }

  writeFileSync(rootPath, plan.rootText);
  writeFileSync(cliPath, plan.cliText);

  console.log("Running pnpm run check ...");
  if (run("pnpm", ["run", "check"]) !== 0) {
    // Leave the bumped files in place: the failure is the point, and reverting
    // them would hide which version was being cut when it happened.
    throw new Error(
      "`pnpm run check` failed after the version bump. Fix it, then run this command again " +
        `(git restore package.json cli/package.json first, so ${version} is applied once).`,
    );
  }

  git(["add", "--", "package.json", "cli/package.json"]);
  git(["commit", "--message", commitMessage(version, message)]);
  git(["tag", "--annotate", tag, "--message", commitMessage(version, message)]);
  git(["push", "--atomic", "origin", BRANCH, tag]);

  console.log(
    `\nPushed ${tag}. The release workflow now verifies the tag, publishes the gateway archive,\n` +
      "deploys the gateway, publishes the CLI to npm and deploys the documentation:\n" +
      "https://github.com/maxceem/app-ai-gateway/actions/workflows/release.yml",
  );
} catch (error) {
  console.error("");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

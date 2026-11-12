#!/usr/bin/env node
// Plans a catalog deploy: the gateway release that is live, with only the model
// catalog on `main` swapped in. `.github/workflows/deploy-catalog.yml` runs it
// when a merge changes `src/usage/models.json`, so a merged price update
// reaches the gateway and its public `/models.json` without a release.
//
//   node scripts/catalog-deploy.mjs plan              # in a checkout of main
//   node scripts/catalog-deploy.mjs apply <release>   # copy the catalog into the release checkout
//   node scripts/catalog-deploy.mjs recheck <tag>     # just before deploying
//
// No code reaches the deploy that a release has not already shipped: the
// release checkout is the tag's own tree, and `apply` refuses it once anything
// besides the catalog differs. The tag must be the newest `vX.Y.Z` and its
// release run must have finished successfully, so this never ships a tag still
// waiting for the owner's approval, nor older code over a newer release. When
// either fails, the run fails and says why: the merged prices are not live yet.
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CATALOG = "src/usage/models.json";
const root = fileURLToPath(new URL("..", import.meta.url));

/** The newest `vX.Y.Z` tag in `git ls-remote --tags` output, with the commit it names. */
export function newestRelease(lsRemote) {
  const tags = new Map();
  for (const line of lsRemote.split("\n")) {
    const match = /^([0-9a-f]{40})\trefs\/tags\/(v(\d+)\.(\d+)\.(\d+))(\^\{\})?$/u.exec(line.trim());
    if (!match) continue;
    const [, sha, tag, major, minor, patch, peeled] = match;
    const known = tags.get(tag);
    // An annotated tag is listed twice; the peeled line names the commit.
    if (!known || peeled) tags.set(tag, { tag, sha, order: [Number(major), Number(minor), Number(patch)] });
  }
  const sorted = [...tags.values()].sort((a, b) =>
    b.order[0] - a.order[0] || b.order[1] - a.order[1] || b.order[2] - a.order[2]);
  if (sorted.length === 0) return null;
  const { tag, sha } = sorted[0];
  return { tag, sha };
}

/**
 * Whether the Release workflow shipped `sha`: "deployed" once a run for it
 * succeeded, "running" while one is queued, in progress or waiting for
 * approval, otherwise "failed" (or "none" when it never ran).
 */
export function releaseState(runs, sha) {
  const own = runs.filter((run) => run.head_sha === sha);
  if (own.some((run) => run.conclusion === "success")) return "deployed";
  if (own.some((run) => run.status !== "completed")) return "running";
  return own.length > 0 ? "failed" : "none";
}

/** True when `git status --porcelain` lists the catalog as the only change. */
export function onlyCatalogChanged(porcelain) {
  const lines = porcelain.split("\n").filter((line) => line.trim() !== "");
  return lines.length === 1 && lines[0] === ` M ${CATALOG}`;
}

function git(args, cwd = root) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout;
}

async function releaseRuns(tag) {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repository || !token) throw new Error("GITHUB_REPOSITORY and GH_TOKEN are required");
  const url = `https://api.github.com/repos/${repository}/actions/workflows/release.yml/runs`
    + `?event=push&branch=${encodeURIComponent(tag)}&per_page=50`;
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`Listing the release runs failed: HTTP ${response.status}`);
  return (await response.json()).workflow_runs;
}

/** The live release, or an error saying why the catalog can't go out on it. */
async function liveRelease() {
  const release = newestRelease(git(["ls-remote", "--tags", "origin", "v*"]));
  if (!release) throw new Error("No vX.Y.Z tag exists yet, so there is no release to deploy the catalog with.");
  const state = releaseState(await releaseRuns(release.tag), release.sha);
  if (state === "deployed") return release;
  const reason = {
    running: `${release.tag} is still being released`,
    failed: `the release of ${release.tag} did not finish`,
    none: `${release.tag} has no release run`,
  }[state];
  throw new Error(
    `Not deploying the catalog: ${reason}. Deploying it with an older release could replace newer code. `
    + `Run this workflow again once ${release.tag} is live, or release again; a release ships the catalog on main.`,
  );
}

function output(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  for (const line of lines) console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

async function plan() {
  const release = await liveRelease();
  const unchanged = spawnSync("git", ["diff", "--quiet", release.sha, "HEAD", "--", CATALOG], { cwd: root });
  if (unchanged.status === 0) {
    console.log(`${release.tag} already ships the catalog on main; nothing to deploy.`);
    output({ deploy: "false", tag: release.tag });
    return;
  }
  if (unchanged.status !== 1) throw new Error(`Comparing the catalog with ${release.tag} failed`);
  const [commit, date] = git(["log", "-1", "--first-parent", "--format=%H %cs", "HEAD", "--", CATALOG]).trim().split(" ");
  output({ deploy: "true", tag: release.tag, sha: release.sha, catalog_commit: commit, catalog_date: date });
}

function apply(releaseDir) {
  if (!releaseDir) throw new Error("usage: node scripts/catalog-deploy.mjs apply <release checkout>");
  copyFileSync(join(root, CATALOG), join(releaseDir, CATALOG));
  const status = git(["status", "--porcelain", "--untracked-files=all"], releaseDir);
  if (!onlyCatalogChanged(status)) {
    throw new Error(`The release checkout differs from its tag in more than ${CATALOG}:\n${status}`);
  }
  console.log(`${CATALOG} is the only change to the release checkout.`);
}

async function recheck(tag) {
  if (!tag) throw new Error("usage: node scripts/catalog-deploy.mjs recheck <tag>");
  const release = await liveRelease();
  if (release.tag !== tag) throw new Error(`${release.tag} was released while this run checked ${tag}; not deploying older code.`);
  console.log(`${tag} is still the live release.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, argument] = process.argv.slice(2);
  try {
    if (command === "plan") await plan();
    else if (command === "apply") apply(argument);
    else if (command === "recheck") await recheck(argument);
    else throw new Error("usage: node scripts/catalog-deploy.mjs <plan|apply <release>|recheck <tag>>");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

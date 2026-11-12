#!/usr/bin/env node
// Deploys the model catalog on `main` with the gateway release that is live,
// so a merged price update reaches the gateway and its public `/models.json`
// without a release. Run by `.github/workflows/deploy-catalog.yml`:
//
//   node scripts/catalog-deploy.mjs start     # on main: dispatch the deploy at the newest release tag
//   node scripts/catalog-deploy.mjs prepare   # in that run's build job: check the tag, swap in main's catalog
//
// The deploy runs at a release tag, so its workflow file, this script and the
// code it builds are all released code, and the `catalog` environment that
// holds the deploy secrets admits `v*` tags only. Code merged to main but not
// released never runs with those secrets, and the build runs in a job of its
// own without them. `prepare` also refuses a tag that is not the newest one or
// whose release did not succeed, and a checkout that differs from the tag in
// anything but the catalog.
import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CATALOG = "src/usage/models.json";
const WORKFLOW = "deploy-catalog.yml";
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

/**
 * True when `git status --porcelain` shows nothing but the catalog changed.
 * A clean checkout passes too: main's catalog may be the release's own again,
 * after a revert, and deploying it is how the revert goes live.
 */
export function onlyCatalogChanged(porcelain) {
  const lines = porcelain.split("\n").filter((line) => line.trim() !== "");
  return lines.length === 0 || (lines.length === 1 && lines[0] === ` M ${CATALOG}`);
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout;
}

async function github(path, init = {}) {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repository || !token) throw new Error("GITHUB_REPOSITORY and GH_TOKEN are required");
  return fetch(`https://api.github.com/repos/${repository}/${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...init.headers,
    },
  });
}

function newestTag() {
  const release = newestRelease(git(["ls-remote", "--tags", "origin", "v*"]));
  if (!release) throw new Error("No vX.Y.Z tag exists yet, so there is no release to deploy the catalog with.");
  return release;
}

function output(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  for (const line of lines) console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

/** On main: start the deploy at the newest release tag, which runs that tag's own workflow. */
async function start() {
  const { tag } = newestTag();
  const ref = encodeURIComponent(tag);
  const present = await github(`contents/.github/workflows/${WORKFLOW}?ref=${ref}`);
  if (present.status === 404) {
    console.log(`${tag} predates catalog deploys, so this catalog goes live with the next release.`);
    return;
  }
  if (!present.ok) throw new Error(`Looking for ${WORKFLOW} in ${tag} failed: HTTP ${present.status}`);
  const dispatched = await github(`actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: tag }),
  });
  if (!dispatched.ok) throw new Error(`Starting the deploy at ${tag} failed: HTTP ${dispatched.status}`);
  console.log(`Started the catalog deploy at ${tag}.`);
}

/** In the deploy run at a tag: check the tag is the live release, then swap in main's catalog. */
async function prepare() {
  const sha = process.env.GITHUB_SHA;
  const release = newestTag();
  if (sha !== release.sha) {
    throw new Error(`This run is at ${sha}, but the newest release is ${release.tag} (${release.sha}). Not deploying older code.`);
  }
  const response = await github(`actions/workflows/release.yml/runs?event=push&branch=${encodeURIComponent(release.tag)}&per_page=50`);
  if (!response.ok) throw new Error(`Listing the release runs failed: HTTP ${response.status}`);
  const state = releaseState((await response.json()).workflow_runs, release.sha);
  if (state !== "deployed") {
    throw new Error(
      `Not deploying the catalog: the release of ${release.tag} ${state === "running" ? "has not finished" : "did not succeed"}. `
      + "Deploying it with an older release could replace newer code; it goes live with the next release or catalog change.",
    );
  }

  git(["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  writeFileSync(join(root, CATALOG), git(["show", `origin/main:${CATALOG}`]));
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  if (!onlyCatalogChanged(status)) {
    throw new Error(`The checkout differs from ${release.tag} in more than ${CATALOG}:\n${status}`);
  }
  const [commit, date] = git(["log", "-1", "--first-parent", "--format=%H %cs", "origin/main", "--", CATALOG]).trim().split(" ");
  output({ tag: release.tag, catalog_commit: commit, catalog_date: date });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command] = process.argv.slice(2);
  try {
    if (command === "start") await start();
    else if (command === "prepare") await prepare();
    else throw new Error("usage: node scripts/catalog-deploy.mjs <start|prepare>");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

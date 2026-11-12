#!/usr/bin/env node
// Deploys the model price list on `main` with the gateway release that is live,
// so a merged price update reaches the gateway and its public `/models.json`
// without a release. Run by `.github/workflows/deploy-prices.yml`:
//
//   node scripts/prices-deploy.mjs start     # on main: dispatch the deploy at the newest release tag
//   node scripts/prices-deploy.mjs prepare   # in that run's build job: check the tag, swap in main's price list
//   node scripts/prices-deploy.mjs check <revision>    # in its deploy job: is the build still current?
//   node scripts/prices-deploy.mjs follow <revision>   # at the end of a release: deploy main's price list if newer
//
// The deploy runs at a release tag, so its workflow file, this script and the
// code it builds are all released code, and the `prices` environment that
// holds the deploy secrets admits `v*` tags only. Code merged to main but not
// released never runs with those secrets, and the build runs in a job of its
// own without them. `prepare` also refuses a tag that is not the newest one or
// whose release did not succeed, and a checkout that differs from the tag in
// anything but the price list.
import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PRICES = "src/usage/models.json";
const WORKFLOW = "deploy-prices.yml";
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
 * True when `git status --porcelain` shows nothing but the price list changed.
 * A clean checkout passes too: main's price list may be the release's own again,
 * after a revert, and deploying it is how the revert goes live.
 */
export function onlyPricesChanged(porcelain) {
  const lines = porcelain.split("\n").filter((line) => line.trim() !== "");
  return lines.length === 0 || (lines.length === 1 && lines[0] === ` M ${PRICES}`);
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
  if (!release) throw new Error("No vX.Y.Z tag exists yet, so there is no release to deploy the price list with.");
  return release;
}

function output(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  for (const line of lines) console.log(line);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

/** Starts this workflow at `tag`, which runs that tag's own copy of it. */
async function dispatch(tag) {
  const present = await github(`contents/.github/workflows/${WORKFLOW}?ref=${encodeURIComponent(tag)}`);
  if (present.status === 404) {
    console.log(`${tag} predates prices deploys, so this price list goes live with the next release.`);
    return;
  }
  if (!present.ok) throw new Error(`Looking for ${WORKFLOW} in ${tag} failed: HTTP ${present.status}`);
  const dispatched = await github(`actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: tag }),
  });
  if (!dispatched.ok) throw new Error(`Starting the deploy at ${tag} failed: HTTP ${dispatched.status}`);
  console.log(`Started the prices deploy at ${tag}.`);
}

/** On main: start the deploy at the newest release tag. */
async function start() {
  await dispatch(newestTag().tag);
}

/**
 * The newest release, when this run is at its commit and its release
 * succeeded; otherwise an error saying why the price list cannot go out on it.
 */
async function liveRelease() {
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
      `Not deploying the price list: the release of ${release.tag} ${state === "running" ? "has not finished" : "did not succeed"}. `
      + "Deploying it with an older release could replace newer code; it goes live with the next release or price change.",
    );
  }
  return release;
}

/** Main's price list as scripts/prices-revision.mjs names it: `{ revision, updated }`. */
function mainPrices() {
  git(["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  const [revision, updated] = git(["log", "-1", "--first-parent", "--format=%h %cs", "--abbrev=7", "origin/main", "--", PRICES]).trim().split(" ");
  return { revision, updated };
}

/** Two short hashes name the same commit (one may be longer, to stay unique). */
export function sameRevision(a, b) {
  return Boolean(a && b) && (a.startsWith(b) || b.startsWith(a));
}

/** In the build job at a tag: check the tag is the live release, then swap in main's price list. */
async function prepare() {
  const release = await liveRelease();
  const main = mainPrices();
  writeFileSync(join(root, PRICES), git(["show", `origin/main:${PRICES}`]));
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  if (!onlyPricesChanged(status)) {
    throw new Error(`The checkout differs from ${release.tag} in more than ${PRICES}:\n${status}`);
  }
  output({ tag: release.tag, prices_revision: main.revision, prices_updated: main.updated });
}

/**
 * In the deploy job, just before deploying a build: is its release still the
 * live one, and its price list still main's? A deploy job run again later
 * would otherwise ship an old build over a newer release or price list.
 */
async function check(revision) {
  if (!revision) throw new Error("usage: node scripts/prices-deploy.mjs check <revision>");
  await liveRelease();
  const main = mainPrices();
  if (!sameRevision(main.revision, revision)) {
    throw new Error(
      `This build carries the price list from ${revision}, but main's is now ${main.revision}. `
      + "Not deploying a stale build; the prices deploy for the newer one ships it.",
    );
  }
  console.log(`The build is still the live release with main's price list (${revision}).`);
}

/**
 * At the end of a release: when main's price list moved on since the tag,
 * as when one merged while the release waited, or the release ran again after
 * a prices deploy, deploy main's on this release. Only for the newest release:
 * running an older one again is a rollback, and stays one.
 */
async function follow(revision) {
  const release = newestTag();
  if (process.env.GITHUB_SHA !== release.sha) {
    console.log(`This is not the newest release (${release.tag}); leaving its price list as released.`);
    return;
  }
  const main = mainPrices();
  if (sameRevision(main.revision, revision)) {
    console.log(`${release.tag} carries main's price list (${revision}).`);
    return;
  }
  console.log(`${release.tag} carries the price list from ${revision || "an unknown commit"}, main's is ${main.revision}.`);
  await dispatch(release.tag);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, argument] = process.argv.slice(2);
  try {
    if (command === "start") await start();
    else if (command === "prepare") await prepare();
    else if (command === "check") await check(argument);
    else if (command === "follow") await follow(argument);
    else throw new Error("usage: node scripts/prices-deploy.mjs <start|prepare|check <revision>|follow <revision>>");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

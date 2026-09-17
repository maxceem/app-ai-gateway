import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertVersionsAgree } from "./manifest.mjs";

/**
 * Publishes the gateway archive as a GitHub release asset.
 *
 * The npm package carries only the executable now, so the deployable gateway
 * has to be somewhere the installed CLI can fetch it from, at exactly the URL
 * and digest `cli/scripts/release.mjs` built into that executable. This script
 * puts it there, and stops short of npm on purpose: publishing the CLI before
 * its asset is live would ship a version whose first `deployment setup` cannot
 * find its gateway.
 */
const root = fileURLToPath(new URL("../../", import.meta.url));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  return result;
}

function capture(command, args) {
  return spawnSync(command, args, { cwd: root, encoding: "utf8" });
}

const version = await assertVersionsAgree();
const tag = `v${version}`;

// Before anything is built: the archive is packed from the working tree, so a
// tree with uncommitted changes would publish a gateway that no commit
// describes, under a tag that claims one does.
const status = capture("git", ["status", "--porcelain"]);
if (status.status !== 0) throw new Error("Cannot read the git status of this checkout");
if (status.stdout.trim())
  throw new Error(
    `The working tree has uncommitted changes:\n${status.stdout}` +
      `Commit or stash them before publishing ${tag}.`,
  );

if (capture("gh", ["--version"]).status !== 0)
  throw new Error("The GitHub CLI (gh) is required to publish a release asset");

if (run(process.execPath, [resolve(root, "cli/scripts/release.mjs")]).status !== 0)
  throw new Error("The CLI release build failed");

const asset = resolve(root, `cli/dist/gateway-${version}.tar.gz`);
const { size } = await stat(asset);
const { sha256, url } = JSON.parse(
  await readFile(resolve(root, "cli/dist/release-integrity.json"), "utf8"),
);

const notes =
  `Gateway ${version}, as \`@maxceem/agw@${version}\` downloads it.\n\n` +
  "The CLI fetches this asset on first use, checks it against the SHA-256 " +
  "built into its published bundle, and caches it. Nothing else here is " +
  `needed to install a gateway.\n\n\`\`\`\nsha256  ${sha256}\n\`\`\`\n`;

const exists = capture("gh", ["release", "view", tag]).status === 0;
const published = exists
  ? run("gh", ["release", "upload", tag, asset, "--clobber"])
  : run("gh", ["release", "create", tag, "--title", tag, "--notes", notes, asset]);
if (published.status !== 0)
  throw new Error(`gh could not ${exists ? "upload the asset to" : "create"} ${tag}`);

console.log(
  `\n${exists ? "Uploaded" : "Published"} ${asset} (${(size / 1024 / 1024).toFixed(1)} MB) to ${tag}.` +
    `\nThe CLI of this version will download it from ${url}.` +
    "\n\nNext step, and only once that asset is live: run `npm publish` from `cli/`." +
    "\nThis script does not publish to npm.",
);

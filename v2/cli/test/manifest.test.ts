import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error - the build scripts are plain ESM with no declarations.
import { cliManifest } from "../scripts/manifest.mjs";

/**
 * The published release refuses to update a deployment whose recorded version
 * it does not list (`unsupported_upgrade`), so the list is what decides whether
 * an existing self-hosted installation can take a fix at all. It is written to
 * `cli/package.json` by `scripts/release.mjs`, not declared by hand, and a
 * release cut with `--breaks-upgrades` lists only its own version; these tests
 * hold it to the shape the deployment path expects.
 */
test("a release can always update a deployment of its own version", async () => {
  const { version, upgradeFrom } = await cliManifest();
  assert.equal(upgradeFrom[0], version);
});

test("a release lists every earlier version it can update", async () => {
  const { upgradeFrom } = await cliManifest();
  for (const earlier of upgradeFrom) {
    assert.match(earlier, /^\d+\.\d+\.\d+$/);
  }
  assert.equal(
    new Set(upgradeFrom).size,
    upgradeFrom.length,
    "an upgrade path is listed twice",
  );
});

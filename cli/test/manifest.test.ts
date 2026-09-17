import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error - the build scripts are plain ESM with no declarations.
import { cliManifest } from "../scripts/manifest.mjs";

/**
 * The published release refuses to update a deployment whose recorded version
 * it does not list (`unsupported_upgrade`), so the list is what decides whether
 * an existing self-hosted installation can take a fix at all. It is declared by
 * hand in `cli/package.json`; these tests hold it to the shape the deployment
 * path expects.
 */
test("a release can always update a deployment of its own version", async () => {
  const { version, upgradeFrom } = await cliManifest();
  assert.equal(upgradeFrom[0], version);
});

test("a release lists every earlier version it can update", async () => {
  const { version, upgradeFrom } = await cliManifest();
  for (const earlier of upgradeFrom) {
    assert.match(earlier, /^\d+\.\d+\.\d+$/);
  }
  assert.equal(
    new Set(upgradeFrom).size,
    upgradeFrom.length,
    "an upgrade path is listed twice",
  );
  assert.ok(
    upgradeFrom.length > 1 || version.endsWith(".0.0"),
    "only a first release has no earlier version to update from",
  );
});

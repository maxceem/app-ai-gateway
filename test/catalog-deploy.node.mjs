import assert from "node:assert/strict";
import { test } from "node:test";
import { newestRelease, onlyCatalogChanged, releaseState } from "../scripts/catalog-deploy.mjs";

const a = "a".repeat(40);
const b = "b".repeat(40);
const c = "c".repeat(40);
const d = "d".repeat(40);

test("catalog deploy: the newest release is the highest version, at the commit it names", () => {
  const lsRemote = [
    `${a}\trefs/tags/v0.9.0`,
    `${b}\trefs/tags/v0.10.0`,
    `${c}\trefs/tags/v0.10.0^{}`,
    `${d}\trefs/tags/v0.10.0-rc.1`,
    `${d}\trefs/tags/swift-1.7.0`,
    "",
  ].join("\n");
  // v0.10.0 sorts above v0.9.0 by number, and its peeled line names the commit.
  assert.deepEqual(newestRelease(lsRemote), { tag: "v0.10.0", sha: c });
  assert.deepEqual(newestRelease(`${a}\trefs/tags/v1.2.3\n`), { tag: "v1.2.3", sha: a });
  assert.equal(newestRelease(`${a}\trefs/tags/swift-1.7.0\n`), null);
});

test("catalog deploy: a release is live only once a run for its commit succeeded", () => {
  const run = (head_sha, status, conclusion) => ({ head_sha, status, conclusion });
  assert.equal(releaseState([run(a, "completed", "failure"), run(a, "completed", "success")], a), "deployed");
  // Waiting for the owner's approval is a run that has not completed.
  assert.equal(releaseState([run(a, "waiting", null)], a), "running");
  assert.equal(releaseState([run(a, "completed", "failure")], a), "failed");
  assert.equal(releaseState([run(b, "completed", "success")], a), "none");
  assert.equal(releaseState([], a), "none");
});

test("catalog deploy: the release checkout may differ from its tag in the catalog alone", () => {
  assert.equal(onlyCatalogChanged(" M src/usage/models.json\n"), true);
  // Main's catalog reverted to the release's own: still deployed, which is how the revert goes live.
  assert.equal(onlyCatalogChanged(""), true);
  assert.equal(onlyCatalogChanged(" M src/usage/models.json\n M src/usage/pricing.ts\n"), false);
  assert.equal(onlyCatalogChanged("?? src/extra.ts\n M src/usage/models.json\n"), false);
  assert.equal(onlyCatalogChanged(" D src/usage/models.json\n"), false);
});

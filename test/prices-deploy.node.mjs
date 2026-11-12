import assert from "node:assert/strict";
import { test } from "node:test";
import { newestRelease, onlyPricesChanged, releaseState } from "../scripts/prices-deploy.mjs";

const a = "a".repeat(40);
const b = "b".repeat(40);
const c = "c".repeat(40);
const d = "d".repeat(40);

test("prices deploy: the newest release is the highest version, at the commit it names", () => {
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

test("prices deploy: a release is live only once a run for its commit succeeded", () => {
  const run = (head_sha, status, conclusion) => ({ head_sha, status, conclusion });
  assert.equal(releaseState([run(a, "completed", "failure"), run(a, "completed", "success")], a), "deployed");
  // Waiting for the owner's approval is a run that has not completed.
  assert.equal(releaseState([run(a, "waiting", null)], a), "running");
  assert.equal(releaseState([run(a, "completed", "failure")], a), "failed");
  assert.equal(releaseState([run(b, "completed", "success")], a), "none");
  assert.equal(releaseState([], a), "none");
});

test("prices deploy: the release checkout may differ from its tag in the price list alone", () => {
  assert.equal(onlyPricesChanged(" M src/usage/models.json\n"), true);
  // Main's price list reverted to the release's own: still deployed, which is how the revert goes live.
  assert.equal(onlyPricesChanged(""), true);
  assert.equal(onlyPricesChanged(" M src/usage/models.json\n M src/usage/pricing.ts\n"), false);
  assert.equal(onlyPricesChanged("?? src/extra.ts\n M src/usage/models.json\n"), false);
  assert.equal(onlyPricesChanged(" D src/usage/models.json\n"), false);
});

test("prices revision: a deploy's given revision wins, a broken one is refused, no git means none", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pricesDefines, pricesRevision } = await import("../scripts/prices-revision.mjs");
  const given = pricesRevision({ PRICES_REVISION: "3f9a1c2", PRICES_UPDATED: "2026-11-12" });
  assert.deepEqual(given, { revision: "3f9a1c2", updated: "2026-11-12" });
  assert.deepEqual(pricesDefines(given), ["--define", 'PRICES_REVISION:"3f9a1c2"', "--define", 'PRICES_UPDATED:"2026-11-12"']);
  for (const env of [{ PRICES_REVISION: "3f9a1c2" }, { PRICES_REVISION: "x; rm -rf /", PRICES_UPDATED: "2026-11-12" }, { PRICES_REVISION: "3f9a1c2", PRICES_UPDATED: "12 Nov" }]) {
    assert.throws(() => pricesRevision(env), /PRICES_REVISION/u);
  }
  const outside = mkdtempSync(join(tmpdir(), "agw-no-git-"));
  try {
    assert.deepEqual(pricesRevision({}, outside), { revision: null, updated: null });
    assert.deepEqual(pricesDefines({ revision: null, updated: null }), []);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
  // This checkout has history, so it names its own.
  assert.match(pricesRevision({}).revision, /^[0-9a-f]{7,40}$/u);
});

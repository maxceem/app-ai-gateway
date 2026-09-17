import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyRelease,
  assertReleasable,
  compareVersions,
  isStableVersion,
  nextUpgradeFrom,
  parseVersion,
  readUpgradeFrom,
  readVersionField,
  renderUpgradeFrom,
  setUpgradeFrom,
  setVersionField,
  versionGuardFindings,
  versionGuardMessage,
} from "../scripts/release-lib.mjs";

const projectRoot = new URL("..", import.meta.url);
const rootManifest = readFileSync(new URL("package.json", projectRoot), "utf8");
const cliManifest = readFileSync(new URL("cli/package.json", projectRoot), "utf8");

test("accepts only stable X.Y.Z versions", () => {
  assert.deepEqual(parseVersion("1.20.3"), [1, 20, 3]);
  for (const bad of ["v1.2.3", "1.2", "1.2.3-rc.1", "^1.2.3", "1.2.3.4", "", "latest"]) {
    assert.equal(isStableVersion(bad), false, bad);
    assert.throws(() => parseVersion(bad));
  }
});

test("compares versions numerically, not as strings", () => {
  assert.ok(compareVersions("0.1.10", "0.1.9") > 0);
  assert.ok(compareVersions("0.2.0", "0.10.0") < 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

test("a release only moves forward", () => {
  assertReleasable("0.1.8", "0.1.7");
  assert.throws(() => assertReleasable("0.1.7", "0.1.7"), /not ahead/u);
  assert.throws(() => assertReleasable("0.1.6", "0.1.7"), /not ahead/u);
});

test("rewrites the version field and nothing else", () => {
  const next = setVersionField(rootManifest, "9.9.9");
  assert.equal(readVersionField(next), "9.9.9");
  assert.equal(next.split("\n").length, rootManifest.split("\n").length);
  assert.ok(next.endsWith("}\n"));
  // One line differs, and it is the version line.
  const changed = next
    .split("\n")
    .filter((line, index) => line !== rootManifest.split("\n")[index]);
  assert.deepEqual(changed, ['  "version": "9.9.9",']);
});

test("refuses a manifest without exactly one version field", () => {
  assert.throws(() => setVersionField('{\n  "name": "x"\n}\n', "1.0.0"), /exactly one/u);
  assert.throws(
    () => setVersionField('{\n  "version": "1.0.0",\n  "version": "1.0.0"\n}\n', "1.0.1"),
    /exactly one/u,
  );
});

test("carries the previous release forward by default and skips it on request", () => {
  assert.deepEqual(nextUpgradeFrom(["0.1.6"], "0.1.7"), ["0.1.7", "0.1.6"]);
  assert.deepEqual(nextUpgradeFrom(["0.1.6"], "0.1.7", { includePrevious: false }), ["0.1.6"]);
  // Idempotent: a list that already names the previous release is left alone.
  assert.deepEqual(nextUpgradeFrom(["0.1.7", "0.1.6"], "0.1.7"), ["0.1.7", "0.1.6"]);
  assert.deepEqual(nextUpgradeFrom(null, "0.1.7"), ["0.1.7"]);
  assert.throws(() => nextUpgradeFrom(["0.1"], "0.1.7"), /stable release version/u);
});

test("keeps upgradeFrom on one line while it fits", () => {
  assert.equal(renderUpgradeFrom(["0.1.1", "0.1.0"]), '  "upgradeFrom": ["0.1.1", "0.1.0"]');
  const many = Array.from({ length: 20 }, (_, index) => `0.1.${index}`);
  const rendered = renderUpgradeFrom(many);
  assert.ok(rendered.includes("\n"));
  assert.deepEqual(JSON.parse(rendered.replace(/^\s*"upgradeFrom":\s*/u, "")), many);
});

test("rewrites upgradeFrom in place, keeping the trailing comma", () => {
  const next = setUpgradeFrom(cliManifest, ["0.1.7", "0.1.6"]);
  assert.deepEqual(readUpgradeFrom(next), ["0.1.7", "0.1.6"]);
  assert.ok(next.includes('"upgradeFrom": ["0.1.7", "0.1.6"],\n'));
  assert.equal(next.split("\n").length, cliManifest.split("\n").length);
});

test("applies a release to both manifests together", () => {
  const plan = applyRelease({
    rootText: rootManifest,
    cliText: cliManifest,
    version: "9.9.9",
  });
  assert.equal(plan.previousVersion, readVersionField(rootManifest));
  assert.equal(readVersionField(plan.rootText), "9.9.9");
  assert.equal(readVersionField(plan.cliText), "9.9.9");
  assert.equal(readUpgradeFrom(plan.cliText)[0], plan.previousVersion);
  assert.deepEqual(readUpgradeFrom(plan.cliText), plan.upgradeFrom);
  // The bumped version is never listed as one it upgrades from: the CLI always
  // accepts its own, and `cli/scripts/manifest.mjs` rejects the repetition.
  assert.equal(readUpgradeFrom(plan.cliText).includes("9.9.9"), false);
});

test("a release that breaks upgrades drops the previous version", () => {
  const plan = applyRelease({
    rootText: rootManifest,
    cliText: cliManifest,
    version: "9.9.9",
    includePrevious: false,
  });
  assert.deepEqual(readUpgradeFrom(plan.cliText), readUpgradeFrom(cliManifest));
});

test("refuses to release manifests that disagree", () => {
  assert.throws(
    () =>
      applyRelease({
        rootText: rootManifest,
        cliText: setVersionField(cliManifest, "0.0.1"),
        version: "9.9.9",
      }),
    /back in step/u,
  );
});

test("the guard reports every released field a pull request changed", () => {
  const unchanged = versionGuardFindings({
    baseRoot: rootManifest,
    headRoot: rootManifest,
    baseCli: cliManifest,
    headCli: cliManifest,
  });
  assert.deepEqual(unchanged, []);
  assert.equal(versionGuardMessage(unchanged), "");

  const bumped = applyRelease({ rootText: rootManifest, cliText: cliManifest, version: "9.9.9" });
  const findings = versionGuardFindings({
    baseRoot: rootManifest,
    headRoot: bumped.rootText,
    baseCli: cliManifest,
    headCli: bumped.cliText,
  });
  assert.equal(findings.length, 3);
  assert.match(versionGuardMessage(findings), /pnpm run release/u);
});

test("the guard catches an upgradeFrom edit on its own", () => {
  const findings = versionGuardFindings({
    baseRoot: rootManifest,
    headRoot: rootManifest,
    baseCli: cliManifest,
    headCli: setUpgradeFrom(cliManifest, ["0.1.0"]),
  });
  assert.deepEqual(findings, [
    `cli/package.json upgradeFrom changed from ${JSON.stringify(readUpgradeFrom(cliManifest))} to ["0.1.0"].`,
  ]);
});

test("the guard passes on this checkout against its own HEAD", () => {
  const script = fileURLToPath(new URL("../scripts/check-version-unchanged.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "HEAD"], {
    cwd: fileURLToPath(projectRoot),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("a dry run writes nothing and rejects a version that is not ahead", () => {
  const script = fileURLToPath(new URL("../scripts/release.mjs", import.meta.url));
  const cwd = fileURLToPath(projectRoot);
  const before = readFileSync(new URL("package.json", projectRoot), "utf8");

  const ok = spawnSync(process.execPath, [script, "9.9.9", "--dry-run"], { cwd, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Dry run: nothing was written/u);
  assert.match(ok.stdout, /tag:\s+v9\.9\.9/u);

  const stale = spawnSync(process.execPath, [script, "0.0.1", "--dry-run"], { cwd, encoding: "utf8" });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /not ahead/u);

  const bad = spawnSync(process.execPath, [script, "9.9.9", "--nope"], { cwd, encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown option/u);

  assert.equal(readFileSync(new URL("package.json", projectRoot), "utf8"), before);
});

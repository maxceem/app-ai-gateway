// The pure half of `pnpm run release` (scripts/release.mjs) and of the pull
// request version guard (scripts/check-version-unchanged.mjs).
//
// Nothing here touches git, the network or the filesystem, so both scripts can
// be tested from `test/release-script.node.mjs` on strings alone.
//
// The two package files are rewritten by targeted replacement rather than
// `JSON.parse` + `JSON.stringify`: the repository has no formatter, and a
// re-serialised `cli/package.json` would explode `upgradeFrom` and the other
// hand-kept single-line arrays into one item per line. Replacing the two fields
// in place keeps a release commit down to the lines a release actually changes.

const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/u;

/** Parses a stable `X.Y.Z` version, rejecting ranges, prereleases and `v` prefixes. */
export function parseVersion(value) {
  if (typeof value !== "string") throw new Error("A version must be a string");
  const match = STABLE_VERSION.exec(value.trim());
  if (!match) {
    throw new Error(
      `"${value}" is not a stable release version. Use X.Y.Z with no "v" prefix and no pre-release suffix.`,
    );
  }
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new Error(`"${value}" has a version part that is not a number`);
  }
  return parts;
}

export function isStableVersion(value) {
  try {
    parseVersion(value);
    return true;
  } catch {
    return false;
  }
}

/** Numeric comparison: negative when `a` is older, zero when equal. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/**
 * The version being released must be stable and strictly ahead of the current
 * one. Re-releasing a version would publish a second archive under a tag whose
 * digest is already baked into a published CLI bundle.
 */
export function assertReleasable(next, current) {
  parseVersion(next);
  parseVersion(current);
  if (compareVersions(next, current) <= 0) {
    throw new Error(
      `Version ${next} is not ahead of the current ${current}. A release only ever moves forward.`,
    );
  }
}

/**
 * Replaces the `version` field of a package manifest, keeping every other byte.
 */
export function setVersionField(text, version) {
  parseVersion(version);
  const pattern = /^(?<lead>[ \t]*"version":[ \t]*")(?<value>[^"]*)(?<tail>")/gmu;
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one "version" field in the manifest; found ${matches.length}.`,
    );
  }
  const [match] = matches;
  return (
    text.slice(0, match.index) +
    `${match.groups.lead}${version}${match.groups.tail}` +
    text.slice(match.index + match[0].length)
  );
}

export function readVersionField(text) {
  const match = /^[ \t]*"version":[ \t]*"([^"]*)"/mu.exec(text);
  if (!match) throw new Error('The manifest has no "version" field');
  return match[1];
}

export function readUpgradeFrom(text) {
  const match = /^[ \t]*"upgradeFrom":[ \t]*(\[[^\]]*\])/mu.exec(text);
  if (!match) return null;
  return JSON.parse(match[1]);
}

/**
 * The list of earlier releases the next one may upgrade a deployment from.
 *
 * The previous release goes in front by default, because the usual release
 * keeps the schema compatible. Dropping it is the deliberate, human call
 * described in `cli/scripts/manifest.mjs`: a release that cannot migrate an
 * older database must not claim it can.
 */
export function nextUpgradeFrom(existing, previousVersion, { includePrevious = true } = {}) {
  const declared = existing ?? [];
  if (!Array.isArray(declared)) throw new Error("upgradeFrom must be an array");
  for (const version of declared) parseVersion(version);
  if (!includePrevious) return [...declared];
  parseVersion(previousVersion);
  if (declared.includes(previousVersion)) return [...declared];
  return [previousVersion, ...declared];
}

/** Renders the array the way `cli/package.json` keeps it: one line while it fits. */
export function renderUpgradeFrom(versions, indent = "  ") {
  const single = `${indent}"upgradeFrom": [${versions.map((v) => JSON.stringify(v)).join(", ")}]`;
  if (single.length <= 100) return single;
  const inner = `${indent}  `;
  return [
    `${indent}"upgradeFrom": [`,
    ...versions.map((v, index) => `${inner}${JSON.stringify(v)}${index === versions.length - 1 ? "" : ","}`),
    `${indent}]`,
  ].join("\n");
}

export function setUpgradeFrom(text, versions) {
  const pattern = /^(?<indent>[ \t]*)"upgradeFrom":[ \t]*\[[^\]]*\](?<tail>,?)/mu;
  const match = pattern.exec(text);
  if (!match) throw new Error('cli/package.json has no "upgradeFrom" array');
  const replacement = renderUpgradeFrom(versions, match.groups.indent) + match.groups.tail;
  return text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length);
}

/**
 * The complete rewrite of both manifests for one release, as strings.
 *
 * `cli/package.json` and the root `package.json` must always carry the same
 * version (`assertVersionsAgree` in `cli/scripts/manifest.mjs`), so they are
 * only ever written together.
 */
export function applyRelease({ rootText, cliText, version, includePrevious = true }) {
  const current = readVersionField(rootText);
  const cliCurrent = readVersionField(cliText);
  if (current !== cliCurrent) {
    throw new Error(
      `package.json is at ${current} but cli/package.json is at ${cliCurrent}. ` +
        "Put them back in step before releasing.",
    );
  }
  assertReleasable(version, current);
  const upgradeFrom = nextUpgradeFrom(readUpgradeFrom(cliText), current, { includePrevious });
  return {
    previousVersion: current,
    upgradeFrom,
    rootText: setVersionField(rootText, version),
    cliText: setUpgradeFrom(setVersionField(cliText, version), upgradeFrom),
  };
}

const GUARD_ADVICE =
  "Versions are set only by `pnpm run release <version>`, which the project owner runs on main: " +
  "the release is triggered by the pushed `vX.Y.Z` tag, not by this field. " +
  "Revert the change; the release is cut after your pull request merges.";

/**
 * What a pull request changed about the released identity of the repository.
 *
 * Returns one message per difference, empty when the pull request leaves all of
 * them alone.
 */
export function versionGuardFindings({ baseRoot, headRoot, baseCli, headCli }) {
  const findings = [];
  const compare = (label, before, after) => {
    if (before !== after) findings.push(`${label} changed from ${before} to ${after}.`);
  };
  compare("package.json version", readVersionField(baseRoot), readVersionField(headRoot));
  compare("cli/package.json version", readVersionField(baseCli), readVersionField(headCli));
  compare(
    "cli/package.json upgradeFrom",
    JSON.stringify(readUpgradeFrom(baseCli)),
    JSON.stringify(readUpgradeFrom(headCli)),
  );
  return findings;
}

export function versionGuardMessage(findings) {
  if (findings.length === 0) return "";
  return [...findings, "", GUARD_ADVICE].join("\n");
}

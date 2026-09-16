import { readFile } from "node:fs/promises";

/**
 * The two fields the CLI bundle is built with, read from `cli/package.json`.
 *
 * One source, shared by the build, the release build and the CLI itself: the
 * version `agw --version` prints and the Wrangler a packaged release must be
 * driven by are both declared there and nowhere else.
 */
export async function cliManifest() {
  const packaged = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const wrangler = packaged.dependencies?.wrangler;
  if (typeof packaged.version !== "string" || typeof wrangler !== "string") {
    throw new Error("cli/package.json must declare a version and a pinned wrangler dependency");
  }
  if (!/^\d+\.\d+\.\d+$/.test(wrangler)) {
    throw new Error(
      `cli/package.json must pin wrangler to an exact version; found "${wrangler}"`,
    );
  }
  return { version: packaged.version, wrangler };
}

/**
 * The gateway release version, which is the repository's own.
 *
 * The root `package.json` is authoritative: it is the version the Worker
 * reports as `serverVersion` and the version a packaged release carries. The
 * CLI bundles exactly one gateway release and refuses any other, so its own
 * version has to equal it — this is where that is enforced.
 */
export async function gatewayVersion() {
  const root = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  if (typeof root.version !== "string") throw new Error("The root package.json has no version");
  return root.version;
}

export async function assertVersionsAgree() {
  const [{ version }, gateway] = await Promise.all([cliManifest(), gatewayVersion()]);
  if (version !== gateway) {
    throw new Error(
      `cli/package.json version ${version} does not match the gateway release ${gateway} in the root package.json. ` +
        "The CLI bundles exactly one gateway release, so the two must be raised together.",
    );
  }
  return version;
}

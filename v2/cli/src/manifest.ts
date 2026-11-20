import { createRequire } from "node:module";

/**
 * The CLI's own `package.json`, which is the single source for both the version
 * `agw --version` prints and the Wrangler the deployment commands drive.
 *
 * `esbuild` inlines it through `define` when the bundle is built, so the
 * published `dist/agw.mjs` carries no file read. Running the sources straight
 * from the repository — which the test suite does — reads the same manifest
 * instead, so the two can never disagree.
 */
export interface CliManifest {
  version: string;
  wrangler: string;
  /** Null in a checkout that has not run the CLI release build. */
  release: ReleaseIntegrity | null;
}

/**
 * Where this CLI's gateway release is published, and what it must hash to.
 *
 * The release itself is not inside the npm package; it is one asset on a
 * GitHub release, downloaded once and cached. These two digests are what makes
 * that safe: they are built into the bundle, so npm's own signature covers
 * them, and GitHub is only ever allowed to supply bytes that match them.
 */
export interface ReleaseIntegrity {
  url: string;
  /** Of the `.tar.gz`, checked before a byte of it is extracted. */
  sha256: string;
  /** Of the release's `manifest.json`, which names every file's digest. */
  manifest: string;
}

declare const __AGW_MANIFEST__: CliManifest | undefined;

function fromPackageJson(): CliManifest {
  const packaged = createRequire(import.meta.url)("../package.json") as {
    version?: unknown;
    dependencies?: Record<string, unknown>;
  };
  const wrangler = packaged.dependencies?.["wrangler"];
  if (typeof packaged.version !== "string" || typeof wrangler !== "string") {
    throw new Error("cli/package.json must declare a version and a pinned wrangler dependency");
  }
  // No release: `cli/package.json` says nothing about a published archive, and
  // a source run resolves the release tree a contributor built instead.
  return { version: packaged.version, wrangler, release: null };
}

const manifest: CliManifest =
  typeof __AGW_MANIFEST__ === "object" && __AGW_MANIFEST__ !== null
    ? __AGW_MANIFEST__
    : fromPackageJson();

export const VERSION = manifest.version;

/** The Wrangler a packaged release is built with and must be driven by. */
export const WRANGLER_VERSION = manifest.wrangler;

/** The published gateway archive this bundle accepts, or null in a checkout. */
export const RELEASE: ReleaseIntegrity | null = manifest.release ?? null;

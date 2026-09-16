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
  return { version: packaged.version, wrangler };
}

const manifest: CliManifest =
  typeof __AGW_MANIFEST__ === "object" && __AGW_MANIFEST__ !== null
    ? __AGW_MANIFEST__
    : fromPackageJson();

export const VERSION = manifest.version;

/** The Wrangler a packaged release is built with and must be driven by. */
export const WRANGLER_VERSION = manifest.wrangler;

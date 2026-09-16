import { readFile, lstat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { fail } from "./common.ts";
import { VERSION, WRANGLER_VERSION } from "./manifest.ts";

export { WRANGLER_VERSION };

/** The deployable gateway release packaged beside the CLI. */
export interface ReleaseManifest {
  format: number;
  version: string;
  node: string;
  wrangler: string;
  schema: number;
  upgradeFrom: string[];
  files: Record<string, string>;
}

/** The Wrangler configuration the packaged release deploys with. */
export interface ReleaseConfig {
  assets?: { directory?: string };
  vars?: Record<string, string>;
  [key: string]: unknown;
}

export interface ReleaseArtifact {
  directory: string;
  manifest: ReleaseManifest;
  config: ReleaseConfig;
}

export async function release(
  requested: string = VERSION,
  base: string = dirname(fileURLToPath(import.meta.url)),
): Promise<ReleaseArtifact> {
  if (requested !== VERSION)
    fail(
      "unsupported_release",
      `This CLI bundles gateway ${VERSION} only.`,
      `Install @maxceem/agw@${requested} to use its matching release.`,
    );
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major === undefined || minor === undefined || major < 22 || (major === 22 && minor < 19))
    fail("unsupported_runtime", "Node.js 22.19.0 or newer is required.");
  const directory = join(base, "release", requested);
  let serialized: string;
  let integrity: { sha256?: unknown };
  try {
    serialized = await readFile(join(directory, "manifest.json"), "utf8");
    integrity = JSON.parse(
      await readFile(join(base, "release-integrity.json"), "utf8"),
    ) as { sha256?: unknown };
  } catch {
    fail(
      "release_missing",
      "The CLI package does not contain its deployable release.",
      "Install a packaged release; repository contributors must run the CLI release build.",
      4,
    );
  }
  if (
    createHash("sha256").update(serialized).digest("hex") !== integrity.sha256
  )
    fail("release_integrity", "Release manifest integrity check failed.");
  const manifest = JSON.parse(serialized) as ReleaseManifest;
  if (
    manifest.format !== 1 ||
    manifest.version !== requested ||
    manifest.wrangler !== WRANGLER_VERSION ||
    manifest.schema !== 1
  )
    fail(
      "release_incompatible",
      "Release compatibility does not match this CLI.",
    );
  for (const [path, hash] of Object.entries(manifest.files)) {
    if (
      path.startsWith("/") ||
      path.split(/[\\/]/).some((p) => p === ".." || p === "")
    )
      fail("release_integrity", "Release includes an unsafe path.");
    const file = join(directory, path);
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex") !== hash
    )
      fail("release_integrity", "Release asset integrity check failed.");
  }
  return {
    directory,
    manifest,
    config: JSON.parse(
      await readFile(join(directory, "wrangler.json"), "utf8"),
    ) as ReleaseConfig,
  };
}

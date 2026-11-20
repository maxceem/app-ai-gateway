import { readFile, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { fail } from "./common.ts";
import { readArchive, ARCHIVE_LIMIT } from "./archive.ts";
import { VERSION, WRANGLER_VERSION, RELEASE, type ReleaseIntegrity } from "./manifest.ts";
import { cacheDirectory, protectedDirectory } from "./state.ts";

export { WRANGLER_VERSION };

/** The deployable gateway release this CLI installs. */
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

/**
 * The seams around obtaining the archive, all of them defaulted.
 *
 * `integrity` is the digests built into this bundle; it is a parameter only so
 * that the tests can exercise the download and cache paths without a published
 * build, and no command passes it.
 */
export interface ReleaseSource {
  /** A `.tar.gz` already on disk, for a firewalled or air-gapped install. */
  archive?: string | undefined;
  /** Where verified releases are kept, one directory per version. */
  cache?: string | undefined;
  integrity?: ReleaseIntegrity | null | undefined;
  download?: ((url: string) => Promise<Buffer>) | undefined;
}

const digest = (data: Buffer | string): string =>
  createHash("sha256").update(data).digest("hex");

/** Fetches the archive, with nothing trusted about what comes back but its size. */
async function fetchArchive(url: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(300000),
      headers: { "user-agent": `agw/${VERSION}` },
    });
  } catch {
    fail(
      "release_download",
      `Cannot download the gateway release from ${url}.`,
      "Check network access, or pass --release-archive with a copy downloaded elsewhere.",
      3,
    );
  }
  if (!response.ok)
    fail(
      "release_download",
      `Downloading the gateway release from ${url} failed with HTTP ${response.status}.`,
      "Check network access, or pass --release-archive with a copy downloaded elsewhere.",
      3,
    );
  const body = Buffer.from(await response.arrayBuffer());
  // Only a memory guard. Whether these are the right bytes is decided by the
  // digest the caller compares next, never by anything the response said.
  if (body.length > ARCHIVE_LIMIT)
    fail("release_download", "The downloaded gateway release exceeds its size limit.", undefined, 3);
  return body;
}

/** Writes the verified members of an archive into a directory of its own. */
async function extract(archive: Buffer, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const entry of readArchive(archive)) {
    const path = join(directory, entry.path);
    if (entry.directory) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      continue;
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // `wx` into a directory this call created: two entries claiming one path
    // fail here rather than letting the later one win.
    await writeFile(path, entry.data, { mode: 0o600, flag: "wx" });
  }
}

/**
 * The cached release for this version, downloaded and verified if it is absent.
 *
 * The archive is matched against the digest built into this bundle before a
 * byte of it is extracted, and the manifest it unpacks to is matched before the
 * result is adopted. Extraction happens in a sibling directory and is renamed
 * into place only once both hold, so an interrupted or refused download can
 * never leave something at the cache path that a later run would trust.
 */
async function cachedRelease(
  version: string,
  integrity: ReleaseIntegrity,
  source: ReleaseSource,
): Promise<string> {
  const root = source.cache ?? join(cacheDirectory(), "releases");
  const directory = join(root, version);
  const cached = await readFile(join(directory, "manifest.json")).catch(() => null);
  if (cached && digest(cached) === integrity.manifest) return directory;
  const supplied = source.archive ?? process.env["AGW_RELEASE_ARCHIVE"] ?? undefined;
  let archive: Buffer;
  if (supplied) {
    archive = await readFile(supplied).catch(() =>
      fail(
        "release_unavailable",
        `Cannot read the gateway release archive at ${supplied}.`,
        "Supply the gateway-<version>.tar.gz asset published with this CLI release.",
        4,
      ),
    );
  } else {
    archive = await (source.download ?? fetchArchive)(integrity.url);
  }
  if (digest(archive) !== integrity.sha256)
    fail(
      "release_integrity",
      "The gateway release archive does not match the digest built into this CLI.",
      "Nothing was extracted. Obtain the archive published with this CLI version.",
      4,
    );
  await protectedDirectory(root);
  const staging = join(root, `.${version}-${randomBytes(8).toString("hex")}`);
  try {
    await extract(archive, staging);
    const manifest = await readFile(join(staging, "manifest.json")).catch(() => null);
    if (!manifest || digest(manifest) !== integrity.manifest)
      fail(
        "release_integrity",
        "The gateway release archive does not contain the expected manifest.",
        "Nothing was installed. Obtain the archive published with this CLI version.",
        4,
      );
    await rm(directory, { recursive: true, force: true });
    await rename(staging, directory);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return directory;
}

export async function release(
  requested: string = VERSION,
  base: string = dirname(fileURLToPath(import.meta.url)),
  source: ReleaseSource = {},
): Promise<ReleaseArtifact> {
  if (requested !== VERSION)
    fail(
      "unsupported_release",
      `This CLI deploys gateway ${VERSION} only.`,
      `Install @maxceem/agw@${requested} to use its matching release.`,
    );
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major === undefined || minor === undefined || major < 22 || (major === 22 && minor < 19))
    fail("unsupported_runtime", "Node.js 22.19.0 or newer is required.");
  const integrity = source.integrity === undefined ? RELEASE : source.integrity;
  // A release tree beside the bundle wins: that is the contributor flow, where
  // `pnpm --filter @maxceem/agw release:build` has just produced the gateway
  // this CLI is being tried against. A published CLI never has one.
  const packaged = join(base, "release", requested);
  const local = await lstat(packaged).catch(() => null);
  let directory: string;
  if (local?.isDirectory()) directory = packaged;
  else if (integrity) directory = await cachedRelease(requested, integrity, source);
  else
    fail(
      "release_missing",
      "This CLI build does not know where to obtain its deployable release.",
      "Install a published release; repository contributors must run the CLI release build.",
      4,
    );
  let serialized: string;
  try {
    serialized = await readFile(join(directory, "manifest.json"), "utf8");
  } catch {
    fail(
      "release_missing",
      "The deployable release is missing its manifest.",
      "Install a published release; repository contributors must run the CLI release build.",
      4,
    );
  }
  // Checked again on the cached path, and for the first time on the contributor
  // path: every file digest below is read out of this document, so it is only
  // worth what its own digest is worth.
  if (integrity && digest(serialized) !== integrity.manifest)
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
      digest(await readFile(file)) !== hash
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

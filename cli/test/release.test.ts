import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { readArchive } from "../src/archive.ts";
import { release, type ReleaseSource } from "../src/release.ts";
import { VERSION, WRANGLER_VERSION, type ReleaseIntegrity } from "../src/manifest.ts";
import { hasCode } from "./helpers.ts";

/**
 * The gateway release now travels as a GitHub asset rather than inside the npm
 * package, so what stands between a deployment and a substituted gateway is the
 * pair of digests built into the CLI bundle. These tests hold that line: every
 * archive here is built locally, the download seam is always stubbed, and no
 * test may reach the network.
 */

const digest = (data: Buffer | string): string =>
  createHash("sha256").update(data).digest("hex");

interface Fixture {
  /** A scratch directory, removed when the test ends. */
  root: string;
  /** Where verified releases are cached, as `--release-archive` would fill it. */
  cache: string;
  /** A directory with no release tree in it, standing in for a published CLI. */
  installed: string;
  archive: Buffer;
  integrity: ReleaseIntegrity;
}

/** The release tree the archive is packed from, as `release.mjs` lays it out. */
async function tree(directory: string, worker: string): Promise<string> {
  await mkdir(join(directory, "worker"), { recursive: true });
  await mkdir(join(directory, "migrations"), { recursive: true });
  await writeFile(join(directory, "worker/index.js"), worker);
  await writeFile(join(directory, "migrations/0000_initial.sql"), "SELECT 1;\n");
  await writeFile(
    join(directory, "wrangler.json"),
    JSON.stringify({ name: "gateway", main: "./worker/index.js" }, null, 2),
  );
  const files: Record<string, string> = {};
  for (const path of ["worker/index.js", "migrations/0000_initial.sql", "wrangler.json"])
    files[path] = digest(await readFile(join(directory, path)));
  const serialized =
    JSON.stringify(
      {
        format: 1,
        version: VERSION,
        node: "22.19.0",
        wrangler: WRANGLER_VERSION,
        schema: 1,
        upgradeFrom: [VERSION],
        files,
      },
      null,
      2,
    ) + "\n";
  await writeFile(join(directory, "manifest.json"), serialized);
  return serialized;
}

/** Packs a directory exactly the way the release build packs one. */
function pack(directory: string, members: string[]): Buffer {
  const packed = spawnSync("tar", [
    "--format",
    "ustar",
    "--numeric-owner",
    "-cf",
    "-",
    "-C",
    directory,
    ...members,
  ]);
  assert.equal(packed.status, 0, String(packed.stderr));
  return gzipSync(packed.stdout, { level: 9 });
}

async function fixture(t: TestContext, worker = "export default {};\n"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agw-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "tree");
  const serialized = await tree(source, worker);
  const archive = pack(source, [
    "manifest.json",
    "migrations",
    "worker",
    "wrangler.json",
  ]);
  return {
    root,
    cache: join(root, "cache"),
    installed: join(root, "installed"),
    archive,
    integrity: {
      url: "https://example.invalid/gateway.tar.gz",
      sha256: digest(archive),
      manifest: digest(serialized),
    },
  };
}

/** A download seam that refuses to be used, for the paths that must not reach it. */
const noDownload = async (): Promise<Buffer> => {
  throw new Error("the release was downloaded when it should not have been");
};

const source = (f: Fixture, extra: ReleaseSource = {}): ReleaseSource => ({
  cache: f.cache,
  integrity: f.integrity,
  download: noDownload,
  ...extra,
});

test("a downloaded release is verified, cached, and not downloaded again", async (t) => {
  const f = await fixture(t);
  const requested: string[] = [];
  const download = async (url: string): Promise<Buffer> => {
    requested.push(url);
    return f.archive;
  };
  const first = await release(VERSION, f.installed, source(f, { download }));
  assert.deepEqual(requested, [f.integrity.url]);
  assert.equal(first.manifest.version, VERSION);
  assert.equal(first.config["main"], "./worker/index.js");
  assert.equal(first.directory, join(f.cache, VERSION));

  const second = await release(VERSION, f.installed, source(f, { download }));
  assert.deepEqual(requested, [f.integrity.url], "the cached release was downloaded again");
  assert.equal(second.directory, first.directory);
  // Nothing half-extracted is left beside the release it was staged next to.
  assert.deepEqual(await readdir(f.cache), [VERSION]);
});

test("an archive that does not match the built-in digest never reaches the disk", async (t) => {
  const f = await fixture(t);
  const other = await fixture(t, "export default { substituted: true };\n");
  await assert.rejects(
    release(VERSION, f.installed, source(f, { download: async () => other.archive })),
    (error: unknown) =>
      hasCode("release_integrity")(error) &&
      (error as Error).message.includes("digest built into this CLI"),
  );
  assert.deepEqual(
    await readdir(f.cache).catch(() => []),
    [],
    "a refused archive left something behind in the cache",
  );
});

test("a file changed inside a correctly hashed archive is caught by its own digest", async (t) => {
  const f = await fixture(t);
  // The manifest is left alone and repacked with everything else, so both the
  // archive digest and the manifest digest are made to agree; only the file the
  // manifest describes is not the file the archive carries.
  const swapped = join(f.root, "tree");
  await writeFile(join(swapped, "worker/index.js"), "export default { swapped: true };\n");
  const archive = pack(swapped, ["manifest.json", "migrations", "worker", "wrangler.json"]);
  const integrity = { ...f.integrity, sha256: digest(archive) };
  await assert.rejects(
    release(VERSION, f.installed, source(f, { integrity, download: async () => archive })),
    (error: unknown) =>
      hasCode("release_integrity")(error) &&
      (error as Error).message === "Release asset integrity check failed.",
  );
});

test("a local archive is accepted without reaching the network", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, `gateway-${VERSION}.tar.gz`);
  await writeFile(path, f.archive);
  const artifact = await release(VERSION, f.installed, source(f, { archive: path }));
  assert.equal(artifact.manifest.version, VERSION);
});

test("AGW_RELEASE_ARCHIVE names the same escape hatch as the flag", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, `gateway-${VERSION}.tar.gz`);
  await writeFile(path, f.archive);
  process.env["AGW_RELEASE_ARCHIVE"] = path;
  t.after(() => {
    delete process.env["AGW_RELEASE_ARCHIVE"];
  });
  const artifact = await release(VERSION, f.installed, source(f));
  assert.equal(artifact.manifest.version, VERSION);
});

test("a CLI built with no release refuses rather than inventing a source", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    release(VERSION, f.installed, { cache: f.cache, integrity: null, download: noDownload }),
    hasCode("release_missing"),
  );
});

test("a release tree beside the bundle is used as it stands", async (t) => {
  const f = await fixture(t);
  const beside = join(f.root, "beside");
  await mkdir(beside, { recursive: true });
  const serialized = await tree(join(beside, "release", VERSION), "export default {};\n");
  const artifact = await release(VERSION, beside, {
    cache: f.cache,
    integrity: { ...f.integrity, manifest: digest(serialized) },
    download: noDownload,
  });
  assert.equal(artifact.directory, join(beside, "release", VERSION));
});

/**
 * Entries the release build never writes, spelled out byte by byte, because a
 * downloaded archive is where a crafted one would arrive. The reader is asked
 * to refuse each one rather than normalise it.
 */
function header(entry: {
  name: string;
  size?: number;
  type?: string;
  link?: string;
  prefix?: string;
}): Buffer {
  const block = Buffer.alloc(512);
  const octal = (value: number, width: number): string =>
    value.toString(8).padStart(width - 1, "0") + "\0";
  block.write(entry.name, 0, 100, "latin1");
  block.write(octal(0o644, 8), 100, 8, "latin1");
  block.write(octal(0, 8), 108, 8, "latin1");
  block.write(octal(0, 8), 116, 8, "latin1");
  block.write(octal(entry.size ?? 0, 12), 124, 12, "latin1");
  block.write(octal(0, 12), 136, 12, "latin1");
  block.write("        ", 148, 8, "latin1");
  block.write(entry.type ?? "0", 156, 1, "latin1");
  if (entry.link) block.write(entry.link, 157, 100, "latin1");
  block.write("ustar\0", 257, 6, "latin1");
  block.write("00", 263, 2, "latin1");
  if (entry.prefix) block.write(entry.prefix, 345, 155, "latin1");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "latin1");
  return block;
}

function crafted(entries: Parameters<typeof header>[0][], body = ""): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(body);
    blocks.push(header({ ...entry, size: entry.size ?? data.length }));
    if (data.length) {
      const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
      data.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

test("the reader accepts the archive the release build writes", async (t) => {
  const f = await fixture(t);
  const entries = readArchive(f.archive);
  const paths = entries.map((e) => e.path).sort();
  assert.deepEqual(paths.includes("worker/index.js"), true);
  assert.deepEqual(paths.includes("manifest.json"), true);
  assert.equal(
    entries.every((e) => !e.path.startsWith("/") && !e.path.includes("..")),
    true,
  );
});

test("the reader refuses a path that escapes the directory", () => {
  assert.throws(
    () => readArchive(crafted([{ name: "../escaped.js" }], "x")),
    hasCode("release_archive"),
  );
  assert.throws(
    () => readArchive(crafted([{ name: "worker/../../escaped.js" }], "x")),
    hasCode("release_archive"),
  );
  assert.throws(
    () => readArchive(crafted([{ name: "escaped.js", prefix: ".." }], "x")),
    hasCode("release_archive"),
  );
});

test("the reader refuses an absolute path", () => {
  assert.throws(
    () => readArchive(crafted([{ name: "/etc/profile" }], "x")),
    hasCode("release_archive"),
  );
  assert.throws(
    () => readArchive(crafted([{ name: "C:\\windows\\system32\\drivers\\etc\\hosts" }], "x")),
    hasCode("release_archive"),
  );
});

test("the reader refuses links and other entry types outright", () => {
  for (const type of ["2", "1", "3", "x", "L", "K"])
    assert.throws(
      () => readArchive(crafted([{ name: "worker/index.js", type, link: "/etc/passwd" }])),
      hasCode("release_archive"),
      `entry type ${type} was accepted`,
    );
});

test("the reader refuses a corrupt header, a truncated archive and hidden members", () => {
  assert.throws(() => readArchive(Buffer.from("not gzip at all")), hasCode("release_archive"));
  // The name is edited after the checksum was written over the original.
  const corrupt = header({ name: "worker/index.js" });
  corrupt.write("z", 5, 1, "latin1");
  assert.throws(
    () => readArchive(gzipSync(Buffer.concat([corrupt, Buffer.alloc(1024)]))),
    hasCode("release_archive"),
  );
  assert.throws(
    () =>
      readArchive(gzipSync(Buffer.concat([header({ name: "a", size: 4096 }), Buffer.alloc(1024)]))),
    hasCode("release_archive"),
  );
  // A second member parked behind the end-of-archive marker, where a reader
  // that stopped at the marker would never look but an extractor might.
  assert.throws(
    () =>
      readArchive(
        gzipSync(
          Buffer.concat([
            Buffer.alloc(1024),
            header({ name: "worker/index.js" }),
            Buffer.alloc(1024),
          ]),
        ),
      ),
    hasCode("release_archive"),
  );
});

test("the reader refuses an archive that expands past its limit", async (t) => {
  const f = await fixture(t);
  assert.throws(() => readArchive(f.archive, 1024), hasCode("release_archive"));
});

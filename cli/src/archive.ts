import { gunzipSync } from "node:zlib";
import { fail } from "./common.ts";

/**
 * A ustar reader for exactly one archive: the gateway release the CLI fetches.
 *
 * The bytes arrive from a GitHub download, so they are read as hostile input
 * until the caller has matched them against the hash built into this bundle.
 * That is the reason for a reader here rather than a tar library: the CLI keeps
 * Wrangler as its only dependency, and the format this has to accept is the one
 * `cli/scripts/release.mjs` writes with `--format ustar` — regular files and
 * directories, nothing else. Everything outside that is refused rather than
 * interpreted, so there is no extension, no link and no rewriting rule for a
 * crafted archive to reach.
 */
export interface ArchiveEntry {
  /** A relative path with `/` separators, already proven safe to join onto. */
  path: string;
  directory: boolean;
  /** Empty for a directory. */
  data: Buffer;
}

const BLOCK = 512;

/**
 * The most an archive may expand to.
 *
 * The release is about five megabytes; this leaves room for it to grow while
 * keeping a compression bomb from filling memory or the cache directory before
 * a single hash has been checked.
 */
export const ARCHIVE_LIMIT = 64 * 1024 * 1024;

/** A NUL-terminated header field, read as the bytes ustar defines it in. */
function text(header: Buffer, start: number, length: number): string {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("latin1");
}

/**
 * An octal header number.
 *
 * Only the digits ustar allows: GNU's base-256 encoding for large values sets
 * the high bit of the first byte, which fails this and is refused rather than
 * decoded, because nothing in a gateway release needs it.
 */
function octal(header: Buffer, start: number, length: number, field: string): number {
  const value = text(header, start, length).trim();
  if (!/^[0-7]+$/.test(value))
    fail("release_archive", `Release archive has an unreadable ${field} field.`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed))
    fail("release_archive", `Release archive has an out-of-range ${field} field.`);
  return parsed;
}

/** Whether the stored checksum matches, counting the field itself as spaces. */
function checksumMatches(header: Buffer): boolean {
  const stored = octal(header, 148, 8, "checksum");
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : header[i]!;
    unsigned += byte;
    // Historic writers summed the bytes as signed chars; both are accepted, and
    // neither is a security boundary — the whole archive is hashed beforehand.
    signed += byte > 0x7f ? byte - 0x100 : byte;
  }
  return stored === unsigned || stored === signed;
}

/**
 * The entry's path, refused unless it can only land inside the target
 * directory.
 *
 * Absolute paths, `..`, empty segments and backslashes are all rejected here
 * rather than normalised away: an archive that needs any of them is not one
 * this CLI wrote, and `join` would happily follow them out of the cache.
 */
function safePath(raw: string, directory: boolean): string {
  const path = directory ? raw.replace(/\/+$/, "") : raw;
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  )
    fail("release_archive", "Release archive contains an unsafe path.");
  return path;
}

export function readArchive(gzipped: Buffer, limit: number = ARCHIVE_LIMIT): ArchiveEntry[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(gzipped, { maxOutputLength: limit });
  } catch {
    fail("release_archive", "Release archive is not readable gzip within the size limit.");
  }
  if (tar.length % BLOCK !== 0)
    fail("release_archive", "Release archive is not a whole number of tar blocks.");
  const entries: ArchiveEntry[] = [];
  let total = 0;
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      // The end-of-archive marker. Everything past it must be padding, so an
      // archive with a second set of members hidden behind it is refused.
      if (!tar.subarray(offset).every((byte) => byte === 0))
        fail("release_archive", "Release archive continues past its end marker.");
      return entries;
    }
    if (text(header, 257, 6).trim() !== "ustar")
      fail("release_archive", "Release archive is not in ustar format.");
    if (!checksumMatches(header))
      fail("release_archive", "Release archive has a corrupt header.");
    const type = String.fromCharCode(header[156]!);
    if (type === "L" || type === "K")
      fail("release_archive", "Release archive uses GNU long-name extensions.");
    if (type !== "0" && type !== "\0" && type !== "5")
      fail(
        "release_archive",
        "Release archives may contain only regular files and directories.",
      );
    const directory = type === "5";
    const prefix = text(header, 345, 155);
    const name = text(header, 0, 100);
    const path = safePath(prefix ? `${prefix}/${name}` : name, directory);
    const size = octal(header, 124, 12, "size");
    if (directory && size !== 0)
      fail("release_archive", "Release archive has a directory entry with contents.");
    total += size;
    if (total > limit) fail("release_archive", "Release archive exceeds its size limit.");
    const start = offset + BLOCK;
    if (start + size > tar.length)
      fail("release_archive", "Release archive is truncated.");
    entries.push({
      path,
      directory,
      data: directory ? Buffer.alloc(0) : Buffer.from(tar.subarray(start, start + size)),
    });
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  fail("release_archive", "Release archive has no end marker.");
}

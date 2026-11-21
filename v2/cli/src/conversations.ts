/**
 * `agw app conversations`: downloads an app's stored conversations into a
 * folder (v1's command, ported).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { fail } from "./common.ts";
import type { Context } from "./context.ts";
import type { Flags } from "./parser.ts";

/** What `agw app conversations` did. */
export interface ConversationsExportResult {
  app_id: string;
  output: string;
  from: string | null;
  to: string;
  /** Batch files the gateway holds for the range. */
  files: number;
  /** Of those, the ones this run downloaded; the rest were already there. */
  downloaded: number;
  /** Media the batches name that this run downloaded, with --media. */
  media: number;
  bytes: number;
}

/** Media a record names in place of its data. */
const MEDIA_REFERENCE = /agw-media:(\d{4}-\d{2}-\d{2}\/media\/[0-9a-f]{64}\.[a-z0-9]{1,5})/g;

function day(name: string, value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    fail("invalid_input", `--${name} must be a day, YYYY-MM-DD.`);
  }
  return value;
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

/** Where a file the gateway names goes, refusing any name that would land outside `output`. */
function inside(output: string, name: string): string {
  const path = resolve(output, name);
  const rel = relative(output, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    fail("invalid_response", "The gateway named a conversation file outside the export folder.", undefined, 3);
  }
  return path;
}

/**
 * Writes a download to a temporary file beside its place, then renames it, so
 * an interrupted export never leaves a partial file under the real name.
 */
async function save(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.part`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Whether a media file already there holds the bytes its name's SHA-256 names. */
async function mediaIntact(path: string, name: string): Promise<boolean> {
  const expected = /\/([0-9a-f]{64})\.[a-z0-9]{1,5}$/.exec(name)?.[1];
  if (expected === undefined) return false;
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch {
    return false;
  }
  return createHash("sha256").update(bytes).digest("hex") === expected;
}

/**
 * Downloads an app's stored conversations into a folder, laid out the way the
 * gateway stores them: `<day>/<batch>.jsonl.gz`, and with --media,
 * `<day>/media/<sha256>.<ext>`. A batch already there at its listed size, and
 * a media file whose content matches the SHA-256 in its name, are skipped, so
 * running the same export again fetches only what is new or was cut short.
 */
export async function conversationsCommand(ctx: Context, appId: string, flags: Flags): Promise<ConversationsExportResult> {
  const from = flags.from === undefined ? null : day("from", flags.from);
  const to = day("to", flags.to ?? new Date().toISOString().slice(0, 10));
  if (from !== null && from > to) fail("invalid_input", "--from must not be later than --to.");
  const output = resolve(flags.output ?? `conversations-${appId}`);
  await mkdir(output, { recursive: true });

  const result: ConversationsExportResult = { app_id: appId, output, from, to, files: 0, downloaded: 0, media: 0, bytes: 0 };
  const batches: string[] = [];
  let cursor: string | undefined;
  do {
    const page = (
      await ctx.call("listAppConversations", {
        params: { app: appId },
        query: { ...(from ? { from } : {}), to, ...(cursor ? { cursor } : {}) },
      })
    ).data;
    for (const file of page.files) {
      result.files += 1;
      const path = inside(output, file.name);
      batches.push(path);
      if ((await sizeOf(path)) === file.size) continue;
      const bytes = await ctx.client.download("getAppConversationFile", { params: { app: appId }, query: { name: file.name } });
      await save(path, bytes);
      result.downloaded += 1;
      result.bytes += bytes.byteLength;
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined);

  if (flags.media) {
    const names = new Set<string>();
    for (const path of batches) {
      const text = gunzipSync(await readFile(path)).toString("utf8");
      for (const match of text.matchAll(MEDIA_REFERENCE)) names.add(match[1]!);
    }
    for (const name of names) {
      const path = inside(output, name);
      if (await mediaIntact(path, name)) continue;
      const bytes = await ctx.client.download("getAppConversationFile", { params: { app: appId }, query: { name } });
      await save(path, bytes);
      result.media += 1;
      result.bytes += bytes.byteLength;
    }
  }
  return result;
}

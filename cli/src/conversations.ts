import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { fail } from "./common.ts";
import type { Context } from "./context.ts";
import type { Flags } from "./parser.ts";
import { date } from "./usage.ts";

/** What `agw app conversations` did. */
export interface ConversationsExportResult {
  app_id: string;
  output: string;
  from: string | null;
  to: string;
  /** Batch files the deployment holds for the range. */
  files: number;
  /** Of those, the ones this run downloaded; the rest were already there. */
  downloaded: number;
  /** Media the batches name that this run downloaded, with --media. */
  media: number;
  bytes: number;
}

/** Media a record names in place of its data. */
const MEDIA_REFERENCE = /agw-media:(\d{4}-\d{2}-\d{2}\/media\/[0-9a-f]{64}\.[a-z0-9]{1,5})/g;

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

async function save(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

/**
 * Downloads an app's stored conversations into a folder, laid out the way the
 * deployment stores them: `<day>/<batch>.jsonl.gz`, and with --media,
 * `<day>/media/<sha256>.<ext>`. A file already there at its listed size is skipped,
 * so running the same export again fetches only what is new.
 */
export async function conversationsCommand(
  ctx: Context,
  appId: string,
  flags: Flags,
): Promise<ConversationsExportResult> {
  const from = flags.from === undefined ? null : date(flags.from);
  const to = date(flags.to ?? new Date().toISOString().slice(0, 10));
  if (from !== null && from > to) fail("invalid_input", "--from must not be later than --to.");
  const output = resolve(flags.output ?? `conversations-${appId}`);
  await mkdir(output, { recursive: true });

  const result: ConversationsExportResult = {
    app_id: appId, output, from, to, files: 0, downloaded: 0, media: 0, bytes: 0,
  };
  const batches: string[] = [];
  let cursor: string | undefined;
  do {
    const page = (await ctx.call("listAppConversations", {
      params: { app: appId },
      query: { ...(from ? { from } : {}), to, ...(cursor ? { cursor } : {}) },
    })).data;
    for (const file of page.files) {
      result.files += 1;
      const path = join(output, file.name);
      batches.push(path);
      if ((await sizeOf(path)) === file.size) continue;
      const bytes = await ctx.client.download("getAppConversationFile", {
        params: { app: appId },
        query: { name: file.name },
      });
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
      const path = join(output, name);
      if ((await sizeOf(path)) !== null) continue;
      const bytes = await ctx.client.download("getAppConversationFile", {
        params: { app: appId },
        query: { name },
      });
      await save(path, bytes);
      result.media += 1;
      result.bytes += bytes.byteLength;
    }
  }
  return result;
}

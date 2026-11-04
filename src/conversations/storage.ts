/**
 * Where stored conversations live in the `CONVERSATIONS` R2 bucket, and the
 * one spelling of every key: written by `src/do/ConversationLog.ts`, listed and
 * read by the management API, pruned by nightly maintenance.
 *
 *   conversations/<app>/<YYYY-MM-DD>/<HHMMSS>-<batch>.jsonl.gz   one batch of records
 *   conversations/<app>/<YYYY-MM-DD>/media/<sha256>.<ext>        one image, recording or file, by content
 *
 * A batch sits under the UTC day of its earliest record, and media under the
 * day of the record that carried it, which is that batch's day or a later one.
 * So a listing by day is a listing by prefix, and retention deletes whole days
 * and never removes media a kept record names.
 */

export const CONVERSATIONS_ROOT = "conversations/";

/** A file name relative to its app's folder, as the management API accepts it. */
export const CONVERSATION_FILE_NAME =
  /^\d{4}-\d{2}-\d{2}\/(?:\d{6}-[a-z0-9]{8,32}\.jsonl\.gz|media\/[0-9a-f]{64}\.[a-z0-9]{1,5})$/;

/** The folder every key of one application starts with. */
export function appPrefix(appId: string): string {
  return `${CONVERSATIONS_ROOT}${appId}/`;
}

/** A record's instant as ISO 8601; now, for one that does not parse. */
function instant(createdAt: string): string {
  const at = new Date(createdAt);
  return Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString();
}

/** The UTC day, `YYYY-MM-DD`, a record belongs to. */
export function recordDay(createdAt: string): string {
  return instant(createdAt).slice(0, 10);
}

/** The key of one batch, named from the UTC instant of its earliest record. */
export function batchKey(appId: string, firstRecordAt: string, batchId: string): string {
  const iso = instant(firstRecordAt);
  const day = iso.slice(0, 10);
  const time = iso.slice(11, 19).replaceAll(":", "");
  return `${appPrefix(appId)}${day}/${time}-${batchId}.jsonl.gz`;
}

/** File extensions by media type; anything else is kept as `.bin`, its type in its metadata. */
const MEDIA_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/webm": "webm",
  "audio/flac": "flac",
  "audio/pcm": "pcm",
  "application/pdf": "pdf",
};

/** A media type for a file extension, for an upload that did not say its type. */
export function typeForExtension(fileName: string): string | null {
  const extension = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  if (extension === undefined) return null;
  if (extension === "jpeg") return "image/jpeg";
  for (const [type, known] of Object.entries(MEDIA_EXTENSIONS)) if (known === extension) return type;
  return null;
}

/** Media's name relative to its app's folder: the same bytes on the same day are one object. */
export function mediaName(day: string, sha256Hex: string, mime: string): string {
  return `${day}/media/${sha256Hex}.${MEDIA_EXTENSIONS[mime.toLowerCase()] ?? "bin"}`;
}

/** The UTC day, `YYYY-MM-DD`, `days` before `now`. */
export function dayBefore(now: number, days: number): string {
  return new Date(now - days * 86_400_000).toISOString().slice(0, 10);
}

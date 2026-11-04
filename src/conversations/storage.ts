/**
 * Where stored conversations live in the `CONVERSATIONS` R2 bucket, and the
 * one spelling of every key: written by `src/do/ConversationLog.ts`, listed and
 * read by the management API, pruned by nightly maintenance.
 *
 *   conversations/<app>/<YYYY-MM-DD>/<HHMMSS>-<batch>.jsonl.gz   one batch of records
 *   conversations/<app>/<YYYY-MM-DD>/images/<sha256>.<ext>       one image, by content
 *
 * A batch sits under the UTC day of its earliest record, and an image under the
 * day of the record that carried it, which is that batch's day or a later one.
 * So a listing by day is a listing by prefix, and retention deletes whole days
 * and never removes an image a kept record names.
 */

export const CONVERSATIONS_ROOT = "conversations/";

/** A file name relative to its app's folder, as the management API accepts it. */
export const CONVERSATION_FILE_NAME =
  /^\d{4}-\d{2}-\d{2}\/(?:\d{6}-[a-z0-9]{8,32}\.jsonl\.gz|images\/[0-9a-f]{64}\.(?:jpg|png|gif|webp))$/;

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

export const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** An image's name relative to its app's folder: the same image on the same day is one object. */
export function imageName(day: string, sha256Hex: string, mime: string): string | null {
  const extension = IMAGE_EXTENSIONS[mime.toLowerCase()];
  return extension === undefined ? null : `${day}/images/${sha256Hex}.${extension}`;
}

/** The UTC day, `YYYY-MM-DD`, `days` before `now`. */
export function dayBefore(now: number, days: number): string {
  return new Date(now - days * 86_400_000).toISOString().slice(0, 10);
}

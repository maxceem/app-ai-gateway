/**
 * Retention for stored conversations (v1's `src/conversations/retention.ts`):
 * every day folder older than its app's `conversations.retention_days` is
 * deleted, with the media inside it. An app that no longer exists keeps
 * nothing.
 *
 * Batches and media sit under days, so retention deletes whole days. A batch
 * holds one day's records (`../do/ConversationLog.ts`), but one written by an
 * older version, or copied from v1, may run past midnight: before the newest
 * day it deletes, retention opens that day's batches and writes again, under
 * their own day, the records still inside the window. Each R2 call is counted
 * against the run's allowance, and a run that runs out stops where it is.
 *
 * App folders are listed a page at a time, starting after the last app the
 * previous run finished (kept in one small object), so a run always makes
 * progress, however many apps there are, and a long list is worked through in
 * turn rather than its first few every time.
 *
 * Runs once a day, from the hourly cron (`../index.ts`).
 */
import { CONVERSATION_RETENTION_DAYS } from "../contracts/app-config.ts";
import { appPrefix, batchKey, CONVERSATIONS_ROOT, dayBefore, recordDay } from "./storage.ts";

const DAY_FOLDER = /^(\d{4}-\d{2}-\d{2})\/$/;
const R2_PAGE = 1000;
/** The app folder the last run finished last. Not a folder itself, so never listed as an app. */
export const RETENTION_CURSOR = `${CONVERSATIONS_ROOT}.retention-cursor`;
/** R2 calls one run may make: well under a Worker invocation's subrequest limit. */
export const RETENTION_CALLS = 500;
/** The UTC hour of the day the hourly cron runs retention in. */
export const RETENTION_HOUR_UTC = 3;

export interface ConversationRetentionResult {
  deletedObjects: number;
  removedApps: number;
}

/** Thrown instead of making an R2 call the run cannot pay for. */
class CallsExhausted extends Error {}

/** A run's allowance of R2 calls, counting the calls actually made. */
export class CallBudget {
  #spent = 0;
  constructor(readonly limit: number) {}

  get remaining(): number {
    return this.limit - this.#spent;
  }

  affords(calls: number): boolean {
    return this.#spent + calls <= this.limit;
  }

  charge(calls: number): void {
    if (!this.affords(calls)) throw new CallsExhausted();
    this.#spent += calls;
  }
}

/** Retention days per existing app, read in one statement. A config this cannot read keeps the default. */
async function appRetention(db: D1Database): Promise<Map<string, number>> {
  const { results } = await db.prepare("SELECT id, config_json FROM app").all<{ id: string; config_json: string }>();
  const days = new Map<string, number>();
  for (const row of results) {
    let retention: number = CONVERSATION_RETENTION_DAYS.default;
    try {
      const value = (JSON.parse(row.config_json) as { conversations?: { retention_days?: unknown } }).conversations?.retention_days;
      if (typeof value === "number" && Number.isInteger(value) && value > 0) retention = value;
    } catch {
      // Unreadable: the default, rather than losing everything.
    }
    days.set(row.id, retention);
  }
  return days;
}

/** Every key under `prefix`, deleted a page at a time. */
async function deleteAll(bucket: R2Bucket, prefix: string, budget: CallBudget): Promise<number> {
  let deleted = 0;
  for (;;) {
    budget.charge(1);
    const page = await bucket.list({ prefix, limit: R2_PAGE });
    if (page.objects.length === 0) return deleted;
    budget.charge(1);
    await bucket.delete(page.objects.map((object) => object.key));
    deleted += page.objects.length;
    if (!page.truncated) return deleted;
  }
}

/** The folders directly under `prefix`, such as an app's day folders. */
async function folders(bucket: R2Bucket, prefix: string, budget: CallBudget): Promise<string[]> {
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    budget.charge(1);
    const page = await bucket.list({ prefix, delimiter: "/", limit: R2_PAGE, ...(cursor ? { cursor } : {}) });
    found.push(...page.delimitedPrefixes);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return found;
}

/**
 * Writes again, under their own day, the records of `folder`'s batches whose
 * day is `firstKept` or later, before the folder is deleted. A batch that holds
 * one day only is left as it is.
 */
async function keepLaterRecords(bucket: R2Bucket, appId: string, folder: string, firstKept: string, budget: CallBudget): Promise<void> {
  budget.charge(1);
  const listing = await bucket.list({ prefix: folder, limit: R2_PAGE });
  for (const object of listing.objects) {
    if (!object.key.endsWith(".jsonl.gz")) continue;
    budget.charge(1);
    const stored = await bucket.get(object.key);
    if (stored === null) continue;
    let text: string;
    try {
      text = await new Response(stored.body.pipeThrough(new DecompressionStream("gzip"))).text();
    } catch {
      // A batch it cannot read has no records it could keep: it goes with its day.
      continue;
    }
    const later = new Map<string, { lines: string[]; earliest: string }>();
    for (const line of text.split("\n")) {
      if (line === "") continue;
      let createdAt: unknown;
      try {
        createdAt = (JSON.parse(line) as { created_at?: unknown }).created_at;
      } catch {
        continue;
      }
      if (typeof createdAt !== "string") continue;
      const day = recordDay(createdAt);
      if (day < firstKept) continue;
      const group = later.get(day) ?? { lines: [], earliest: createdAt };
      group.lines.push(line);
      if (new Date(createdAt).getTime() < new Date(group.earliest).getTime()) group.earliest = createdAt;
      later.set(day, group);
    }
    for (const group of later.values()) {
      // Named from the batch it came from, so a run retried after a crash writes the same file again.
      const source = object.key.slice(object.key.lastIndexOf("-") + 1, -".jsonl.gz".length).toLowerCase().replace(/[^a-z0-9]/g, "");
      const batchId = `${source.slice(0, 24)}split`.padStart(8, "0");
      const gzipped = await new Response(
        new Blob([`${group.lines.join("\n")}\n`]).stream().pipeThrough(new CompressionStream("gzip")),
      ).arrayBuffer();
      budget.charge(1);
      await bucket.put(batchKey(appId, group.earliest, batchId), gzipped, {
        httpMetadata: { contentType: "application/gzip" },
        customMetadata: { records: String(group.lines.length) },
      });
    }
  }
}

export async function runConversationRetention(
  bucket: R2Bucket,
  db: D1Database,
  now: number,
  budget: CallBudget = new CallBudget(RETENTION_CALLS),
  /** App folders listed per R2 call: R2's most, except in tests. */
  pageSize: number = R2_PAGE,
): Promise<ConversationRetentionResult> {
  const result: ConversationRetentionResult = { deletedObjects: 0, removedApps: 0 };
  let finished: string | null = null;
  let last: string | null = null;
  try {
    budget.charge(1);
    last = (await (await bucket.get(RETENTION_CURSOR))?.text()) ?? null;
    const retention = await appRetention(db);
    // The cursor is written with the one call kept back for it.
    const work = new CallBudget(Math.max(0, budget.remaining - 1));
    try {
      // A page at a time, starting after the app the last run finished, and coming round to it.
      let cursor: string | undefined;
      let wrapped = last === null;
      for (;;) {
        work.charge(1);
        const page = await bucket.list({
          prefix: CONVERSATIONS_ROOT,
          delimiter: "/",
          limit: pageSize,
          ...(cursor !== undefined ? { cursor } : !wrapped && last !== null ? { startAfter: last } : {}),
        });
        let round = false;
        for (const folder of page.delimitedPrefixes) {
          if (wrapped && last !== null && folder > last) {
            round = true;
            break;
          }
          // `startAfter` names the folder, whose own keys sort after it: it comes back first.
          if (!wrapped && last !== null && folder <= last) continue;
          const appId = folder.slice(CONVERSATIONS_ROOT.length, -1);
          const days = retention.get(appId);
          if (days === undefined) {
            result.deletedObjects += await deleteAll(bucket, folder, work);
            result.removedApps += 1;
          } else {
            const prefix = appPrefix(appId);
            const firstKept = dayBefore(now, days);
            const expired: string[] = [];
            for (const day of await folders(bucket, prefix, work)) {
              const match = DAY_FOLDER.exec(day.slice(prefix.length));
              // Day folders sort oldest first, so the first one kept ends the app.
              if (match === null || match[1]! >= firstKept) break;
              expired.push(day);
            }
            const newest = expired.at(-1);
            if (newest !== undefined) await keepLaterRecords(bucket, appId, newest, firstKept, work);
            for (const day of expired) result.deletedObjects += await deleteAll(bucket, day, work);
          }
          finished = folder;
        }
        if (round) break;
        if (page.truncated) {
          cursor = page.cursor;
        } else if (!wrapped) {
          wrapped = true;
          cursor = undefined;
        } else {
          break;
        }
      }
    } finally {
      // What the work spent is the run's too (never more than it was given).
      budget.charge(work.limit - work.remaining);
    }
  } catch (error) {
    // Out of allowance: what was deleted stays deleted, and the rest waits for the next run.
    if (!(error instanceof CallsExhausted)) throw error;
  }
  if (finished !== null && finished !== last && budget.affords(1)) {
    budget.charge(1);
    await bucket.put(RETENTION_CURSOR, finished);
  }
  return result;
}

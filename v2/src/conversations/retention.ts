/**
 * Retention for stored conversations (v1's `src/conversations/retention.ts`):
 * every day folder older than its app's `conversations.retention_days` is
 * deleted, with the media inside it. An app that no longer exists keeps
 * nothing. Folders are `<account>~<app>` (`./storage.ts`): an app is looked up
 * with its account, so an app id another account uses again never extends or
 * ends the first account's history. A folder without an account in its name
 * (written before that layout, on a test deployment only) is left alone.
 *
 * Batches and media sit under days, and every batch holds one UTC day's
 * records only (v1's batches that ran past midnight are split by day when the
 * migration copies them, plan section 9.1). So retention deletes whole expired
 * day folders in bulk, without reading them. Each R2 call and each D1 query
 * is counted against the run's allowance for it; each page of keys is deleted as soon as it is listed, so
 * a run that runs out keeps what it deleted and the next run goes on.
 *
 * App folders are listed a page at a time, in one pass from after the last app
 * the previous run reached (kept in one small object) to the end of the
 * listing, where the cursor is cleared and the next run starts from the first
 * app again. So a run always makes progress, however many apps there are, and
 * one busy app never holds up the apps after it: a run that runs out in it,
 * having deleted something there, leaves the cursor after it, and a later pass
 * comes back to it. A run that runs out in an app before deleting anything
 * there leaves the cursor before it, so the next run starts with that app.
 *
 * Runs once a day, from the hourly cron (`../index.ts`).
 */
import { CONVERSATION_RETENTION_DAYS } from "../contracts/app-config.ts";
import { QueryBudget, QueryBudgetExhausted } from "../core/query-budget.ts";
import { appFolderName, CONVERSATIONS_ROOT, dayBefore, parseAppFolderName } from "./storage.ts";

const DAY_FOLDER = /^(\d{4}-\d{2}-\d{2})\/$/;
const R2_PAGE = 1000;
/** The app folder the last run finished last. Not a folder itself, so never listed as an app. */
export const RETENTION_CURSOR = `${CONVERSATIONS_ROOT}.retention-cursor`;
/**
 * R2 calls one run may make: well under a Worker invocation's limit of 1,000
 * calls to Cloudflare services. Counted with the same {@link QueryBudget} as
 * the nightly D1 maintenance, but a run of its own, in its own hour.
 */
export const RETENTION_CALLS = 500;
/**
 * D1 queries one run may make: the first read of every app's retention, then
 * one read of the app before each page it deletes. D1 allows 50 queries per
 * Worker invocation on the Workers Free plan, and the hourly clean-up in the
 * same 03:17 run spends six (`../maintenance/nightly.ts`), so this stays
 * under what is left. Where it runs out first, the run stops as it does when
 * its R2 calls run out.
 */
export const RETENTION_D1_QUERIES = 40;
/** The UTC hour of the day the hourly cron runs retention in. */
export const RETENTION_HOUR_UTC = 3;

export interface ConversationRetentionResult {
  deletedObjects: number;
  removedApps: number;
}

/** An app's retention in days from its stored settings; unreadable settings give the default, rather than losing everything. */
function retentionOf(configJson: string): number {
  try {
    const value = (JSON.parse(configJson) as { conversations?: { retention_days?: unknown } }).conversations?.retention_days;
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  } catch {
    // Unreadable: the default.
  }
  return CONVERSATION_RETENTION_DAYS.default;
}

/** Retention days per existing app, keyed by its folder name (account and app), read in one statement. */
async function appRetention(db: D1Database): Promise<Map<string, number>> {
  const { results } = await db
    .prepare("SELECT id, account_id, config_json FROM app")
    .all<{ id: string; account_id: string; config_json: string }>();
  const days = new Map<string, number>();
  for (const row of results) {
    try {
      days.set(appFolderName(row.account_id, row.id), retentionOf(row.config_json));
    } catch {
      // An id no folder can be named after holds no records.
    }
  }
  return days;
}

/** An app as stored right now: its retention, gone, or unknown where it could not be read. */
type AppNow = { state: "present"; days: number } | { state: "absent" } | { state: "unknown" };

/**
 * The app as stored right now, read just before a page is deleted: a retention
 * raised, or an app made, while the sweep runs is honoured. A failed read is
 * `unknown`, and the folder waits for a later run. A read the run's D1
 * allowance cannot pay for throws, so the run stops there and saves its place.
 */
async function appNow(db: D1Database, accountId: string, appId: string): Promise<AppNow> {
  try {
    const row = await db
      .prepare("SELECT config_json FROM app WHERE id = ? AND account_id = ?")
      .bind(appId, accountId)
      .first<{ config_json: string }>();
    return row === null ? { state: "absent" } : { state: "present", days: retentionOf(row.config_json) };
  } catch (error) {
    if (error instanceof QueryBudgetExhausted) throw error;
    return { state: "unknown" };
  }
}

/**
 * Every key under `prefix`, deleted a page at a time, each page added to
 * `result` as soon as it is deleted. Where `stillExpired` is given, it is
 * asked after each page is listed and right before that page is deleted;
 * when it answers false, deleting stops and `stopped` is true.
 */
async function deleteAll(
  bucket: R2Bucket,
  prefix: string,
  budget: QueryBudget,
  pageSize: number,
  result: ConversationRetentionResult,
  stillExpired?: () => Promise<boolean>,
): Promise<{ stopped: boolean }> {
  for (;;) {
    budget.charge(1);
    const page = await bucket.list({ prefix, limit: pageSize });
    if (page.objects.length === 0) return { stopped: false };
    if (stillExpired !== undefined && !(await stillExpired())) return { stopped: true };
    budget.charge(1);
    await bucket.delete(page.objects.map((object) => object.key));
    result.deletedObjects += page.objects.length;
    if (!page.truncated) return { stopped: false };
  }
}

/**
 * The folders directly under `prefix`, such as an app's day folders, a page at
 * a time as they are listed. A caller that stops early lists no more pages: an
 * app's day folders sort oldest first, so the sweep stops at the first day it
 * keeps, and never spends its calls listing days it would keep anyway.
 */
async function* folders(bucket: R2Bucket, prefix: string, budget: QueryBudget, pageSize: number): AsyncGenerator<string> {
  let cursor: string | undefined;
  do {
    budget.charge(1);
    const page = await bucket.list({ prefix, delimiter: "/", limit: pageSize, ...(cursor ? { cursor } : {}) });
    yield* page.delimitedPrefixes;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
}

export async function runConversationRetention(
  bucket: R2Bucket,
  db: D1Database,
  now: number,
  budget: QueryBudget = new QueryBudget(RETENTION_CALLS),
  /** Keys listed per R2 call: R2's most, except in tests. */
  pageSize: number = R2_PAGE,
  /** The run's D1 queries, apart from its R2 calls. */
  reads: QueryBudget = new QueryBudget(RETENTION_D1_QUERIES),
): Promise<ConversationRetentionResult> {
  db = reads.database(db);
  const result: ConversationRetentionResult = { deletedObjects: 0, removedApps: 0 };
  /** Where the next run starts: after this app folder, or from the first where the pass reached the end (null). */
  let resume: string | null = null;
  let last: string | null = null;
  /** The app folder being worked on. */
  let current: string | null = null;
  /** Where the next run starts if this one runs out in `current` before deleting anything there. */
  let beforeCurrent: string | null = null;
  /** What the run had deleted when it began `current`. */
  let deletedBeforeCurrent = 0;
  try {
    budget.charge(1);
    last = (await (await bucket.get(RETENTION_CURSOR))?.text()) || null;
    resume = last;
    const retention = await appRetention(db);
    // The cursor is written with the one call kept back for it.
    const work = new QueryBudget(Math.max(0, budget.remaining - 1));
    try {
      let cursor: string | undefined;
      for (;;) {
        work.charge(1);
        const page = await bucket.list({
          prefix: CONVERSATIONS_ROOT,
          delimiter: "/",
          limit: pageSize,
          ...(cursor !== undefined ? { cursor } : last !== null ? { startAfter: last } : {}),
        });
        for (const folder of page.delimitedPrefixes) {
          // `startAfter` names the folder, whose own keys sort after it: it comes back first.
          if (last !== null && folder <= last) continue;
          beforeCurrent = resume;
          resume = folder;
          const owner = parseAppFolderName(folder.slice(CONVERSATIONS_ROOT.length, -1));
          // Written before folders named their account: never served, never touched.
          if (owner === null) continue;
          const { accountId, appId } = owner;
          current = folder;
          deletedBeforeCurrent = result.deletedObjects;
          const days = retention.get(appFolderName(accountId, appId));
          if (days === undefined) {
            // The app was missing when the sweep began; it is looked up again before each page,
            // so an app made since then keeps what it has written.
            const outcome = await deleteAll(bucket, folder, work, pageSize, result, async () => (await appNow(db, accountId, appId)).state === "absent");
            if (!outcome.stopped) result.removedApps += 1;
          } else {
            for await (const day of folders(bucket, folder, work, pageSize)) {
              const match = DAY_FOLDER.exec(day.slice(folder.length));
              // Day folders sort oldest first, so the first one kept ends the app.
              if (match === null || match[1]! >= dayBefore(now, days)) break;
              // The retention is read again after each page is listed, right before that page is deleted:
              // a retention raised since the sweep began is honoured, and a failed read leaves the folder
              // for a later run.
              const dayName = match[1]!;
              const outcome = await deleteAll(bucket, day, work, pageSize, result, async () => {
                const fresh = await appNow(db, accountId, appId);
                return fresh.state === "present" && dayName < dayBefore(now, fresh.days);
              });
              if (outcome.stopped) break;
            }
          }
          current = null;
        }
        if (!page.truncated) {
          // The end of the listing: the next run starts from the first app.
          resume = null;
          break;
        }
        cursor = page.cursor;
      }
    } finally {
      // What the work spent is the run's too (never more than it was given).
      budget.charge(work.limit - work.remaining);
    }
  } catch (error) {
    // Out of R2 calls or D1 queries: what was deleted stays deleted, and the rest waits for the next run.
    if (!(error instanceof QueryBudgetExhausted)) throw error;
    // The next run starts after the app it ran out in, so one busy app never holds up
    // those after it; a later pass comes back to it and goes on where this one stopped.
    // But only where it deleted something there: an app the run reached with nothing
    // left to spend was never looked at, so the next run starts with it instead.
    if (current !== null) resume = result.deletedObjects > deletedBeforeCurrent ? current : beforeCurrent;
  }
  if (resume !== last && budget.affords(1)) {
    budget.charge(1);
    if (resume === null) await bucket.delete(RETENTION_CURSOR);
    else await bucket.put(RETENTION_CURSOR, resume);
  }
  return result;
}

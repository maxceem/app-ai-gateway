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
 * day folders in bulk, without reading them. Each R2 call is counted against
 * the run's allowance; each page of keys is deleted as soon as it is listed, so
 * a run that runs out keeps what it deleted and the next run goes on.
 *
 * App folders are listed a page at a time, in one pass from after the last app
 * the previous run reached (kept in one small object) to the end of the
 * listing, where the cursor is cleared and the next run starts from the first
 * app again. So a run always makes progress, however many apps there are, and
 * one busy app never holds up the apps after it: a run that runs out in it
 * leaves the cursor after it, and a later pass comes back to it.
 *
 * Runs once a day, from the hourly cron (`../index.ts`).
 */
import { CONVERSATION_RETENTION_DAYS } from "../contracts/app-config.ts";
import { appFolderName, CONVERSATIONS_ROOT, dayBefore, parseAppFolderName } from "./storage.ts";

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
 * `unknown`, and the folder waits for a later run.
 */
async function appNow(db: D1Database, accountId: string, appId: string): Promise<AppNow> {
  try {
    const row = await db
      .prepare("SELECT config_json FROM app WHERE id = ? AND account_id = ?")
      .bind(appId, accountId)
      .first<{ config_json: string }>();
    return row === null ? { state: "absent" } : { state: "present", days: retentionOf(row.config_json) };
  } catch {
    return { state: "unknown" };
  }
}

/**
 * Every key under `prefix`, deleted a page at a time. Where `stillExpired` is
 * given, it is asked after each page is listed and right before that page is
 * deleted; when it answers false, deleting stops and `stopped` is true.
 */
async function deleteAll(
  bucket: R2Bucket,
  prefix: string,
  budget: CallBudget,
  pageSize: number,
  stillExpired?: () => Promise<boolean>,
): Promise<{ deleted: number; stopped: boolean }> {
  let deleted = 0;
  for (;;) {
    budget.charge(1);
    const page = await bucket.list({ prefix, limit: pageSize });
    if (page.objects.length === 0) return { deleted, stopped: false };
    if (stillExpired !== undefined && !(await stillExpired())) return { deleted, stopped: true };
    budget.charge(1);
    await bucket.delete(page.objects.map((object) => object.key));
    deleted += page.objects.length;
    if (!page.truncated) return { deleted, stopped: false };
  }
}

/** The folders directly under `prefix`, such as an app's day folders. */
async function folders(bucket: R2Bucket, prefix: string, budget: CallBudget, pageSize: number): Promise<string[]> {
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    budget.charge(1);
    const page = await bucket.list({ prefix, delimiter: "/", limit: pageSize, ...(cursor ? { cursor } : {}) });
    found.push(...page.delimitedPrefixes);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return found;
}

export async function runConversationRetention(
  bucket: R2Bucket,
  db: D1Database,
  now: number,
  budget: CallBudget = new CallBudget(RETENTION_CALLS),
  /** Keys listed per R2 call: R2's most, except in tests. */
  pageSize: number = R2_PAGE,
): Promise<ConversationRetentionResult> {
  const result: ConversationRetentionResult = { deletedObjects: 0, removedApps: 0 };
  /** Where the next run starts: after this app folder, or from the first where the pass reached the end (null). */
  let resume: string | null = null;
  let last: string | null = null;
  /** The app folder being worked on: where the allowance runs out, the next run starts after it. */
  let current: string | null = null;
  try {
    budget.charge(1);
    last = (await (await bucket.get(RETENTION_CURSOR))?.text()) || null;
    resume = last;
    const retention = await appRetention(db);
    // The cursor is written with the one call kept back for it.
    const work = new CallBudget(Math.max(0, budget.remaining - 1));
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
          resume = folder;
          const owner = parseAppFolderName(folder.slice(CONVERSATIONS_ROOT.length, -1));
          // Written before folders named their account: never served, never touched.
          if (owner === null) continue;
          const { accountId, appId } = owner;
          current = folder;
          const days = retention.get(appFolderName(accountId, appId));
          if (days === undefined) {
            // The app was missing when the sweep began; it is looked up again before each page,
            // so an app made since then keeps what it has written.
            const outcome = await deleteAll(bucket, folder, work, pageSize, async () => (await appNow(db, accountId, appId)).state === "absent");
            result.deletedObjects += outcome.deleted;
            if (!outcome.stopped) result.removedApps += 1;
          } else {
            for (const day of await folders(bucket, folder, work, pageSize)) {
              const match = DAY_FOLDER.exec(day.slice(folder.length));
              // Day folders sort oldest first, so the first one kept ends the app.
              if (match === null || match[1]! >= dayBefore(now, days)) break;
              // The retention is read again after each page is listed, right before that page is deleted:
              // a retention raised since the sweep began is honoured, and a failed read leaves the folder
              // for a later run.
              const dayName = match[1]!;
              const outcome = await deleteAll(bucket, day, work, pageSize, async () => {
                const fresh = await appNow(db, accountId, appId);
                return fresh.state === "present" && dayName < dayBefore(now, fresh.days);
              });
              result.deletedObjects += outcome.deleted;
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
    // Out of allowance: what was deleted stays deleted, and the rest waits for the next run.
    if (!(error instanceof CallsExhausted)) throw error;
    // The next run starts after the app it ran out in, so one busy app never holds up
    // those after it; a later pass comes back to it and goes on where this one stopped.
    if (current !== null) resume = current;
  }
  if (resume !== last && budget.affords(1)) {
    budget.charge(1);
    if (resume === null) await bucket.delete(RETENTION_CURSOR);
    else await bucket.put(RETENTION_CURSOR, resume);
  }
  return result;
}

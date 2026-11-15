/**
 * Nightly retention for stored conversations: every day folder older than its
 * app's `conversations.retention_days` is deleted, with the images inside it.
 * An app that no longer exists keeps nothing.
 *
 * Batches and images sit under days, so retention deletes whole days and never
 * opens a file. Each R2 call is charged to the maintenance budget like a D1
 * statement — both are subrequests — and a run that runs out stops where it
 * is. The next night starts after the last app this one finished, recorded in
 * one small object, so a long list of apps is worked through in turn rather
 * than its first few every night.
 */

import { CONVERSATION_RETENTION_DAYS } from "../contracts/schemas";
import { QueryBudgetExhausted, type QueryBudget } from "../core/query-budget";
import { appPrefix, CONVERSATIONS_ROOT, dayBefore } from "./storage";

const DAY_FOLDER = /^(\d{4}-\d{2}-\d{2})\/$/;
const R2_PAGE = 1000;
/** The app folder the last run finished last. Not a folder itself, so never listed as an app. */
export const RETENTION_CURSOR = `${CONVERSATIONS_ROOT}.retention-cursor`;

export interface ConversationRetentionResult {
  deletedObjects: number;
  removedApps: number;
}

/** Retention days per existing app, read in one statement. */
async function appRetention(db: D1Database): Promise<Map<string, number>> {
  const { results } = await db.prepare("SELECT id, config_json FROM app").all<{ id: string; config_json: string }>();
  const days = new Map<string, number>();
  for (const row of results) {
    let retention: number = CONVERSATION_RETENTION_DAYS.default;
    try {
      const value = (JSON.parse(row.config_json) as { conversations?: { retention_days?: unknown } })
        .conversations?.retention_days;
      if (typeof value === "number" && Number.isInteger(value) && value > 0) retention = value;
    } catch {
      // A config this cannot read keeps the default rather than losing everything.
    }
    days.set(row.id, retention);
  }
  return days;
}

/** Every key under `prefix`, deleted a page at a time. */
async function deleteAll(bucket: R2Bucket, prefix: string, budget: QueryBudget): Promise<number> {
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
async function folders(bucket: R2Bucket, prefix: string, budget: QueryBudget): Promise<string[]> {
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

export async function runConversationRetention(
  bucket: R2Bucket,
  db: D1Database,
  now: number,
  budget: QueryBudget,
): Promise<ConversationRetentionResult> {
  const result: ConversationRetentionResult = { deletedObjects: 0, removedApps: 0 };
  let finished: string | null = null;
  let last: string | null = null;
  try {
    budget.charge(1);
    last = (await (await bucket.get(RETENTION_CURSOR))?.text()) ?? null;
    const retention = await appRetention(db);
    // The cursor is written with what this leaves unspent.
    const work = budget.limited(budget.remaining - 1);
    const apps = await folders(bucket, CONVERSATIONS_ROOT, work);
    // Starting after the app the last run finished, and coming round to it.
    const ordered = last === null ? apps : [...apps.filter((app) => app > last!), ...apps.filter((app) => app <= last!)];
    for (const folder of ordered) {
      const appId = folder.slice(CONVERSATIONS_ROOT.length, -1);
      const days = retention.get(appId);
      if (days === undefined) {
        result.deletedObjects += await deleteAll(bucket, folder, work);
        result.removedApps += 1;
      } else {
        const prefix = appPrefix(appId);
        const firstKept = dayBefore(now, days);
        for (const day of await folders(bucket, prefix, work)) {
          const match = DAY_FOLDER.exec(day.slice(prefix.length));
          // Day folders sort oldest first, so the first one kept ends the app.
          if (match === null || match[1]! >= firstKept) break;
          result.deletedObjects += await deleteAll(bucket, day, work);
        }
      }
      finished = folder;
    }
  } catch (error) {
    // Out of allowance: what was deleted stays deleted, and the rest waits a night.
    if (!(error instanceof QueryBudgetExhausted)) throw error;
  }
  if (finished !== null && finished !== last && budget.affords(1)) {
    budget.charge(1);
    await bucket.put(RETENTION_CURSOR, finished);
  }
  return result;
}

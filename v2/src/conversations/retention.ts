/**
 * Retention for stored conversations (v1's `src/conversations/retention.ts`):
 * every day folder older than its app's `conversations.retention_days` is
 * deleted, with the media inside it. An app that no longer exists keeps
 * nothing.
 *
 * Batches and media sit under days, so retention deletes whole days and never
 * opens a file. Each R2 call is counted against the run's allowance, and a run
 * that runs out stops where it is. The next run starts after the last app this
 * one finished, recorded in one small object, so a long list of apps is worked
 * through in turn rather than its first few every time.
 *
 * Runs once a day, from the hourly cron (`../index.ts`).
 */
import { CONVERSATION_RETENTION_DAYS } from "../contracts/app-config.ts";
import { appPrefix, CONVERSATIONS_ROOT, dayBefore } from "./storage.ts";

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

export async function runConversationRetention(
  bucket: R2Bucket,
  db: D1Database,
  now: number,
  budget: CallBudget = new CallBudget(RETENTION_CALLS),
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

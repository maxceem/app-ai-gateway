/**
 * Retention for stored conversations (v1's `src/conversations/retention.ts`):
 * every day folder older than its app's `conversations.retention_days` is
 * deleted, with the media inside it. An app that no longer exists keeps
 * nothing.
 *
 * Batches and media sit under days, and every batch holds one UTC day's
 * records only (v1's batches that ran past midnight are split by day when the
 * migration copies them, plan section 9.1). So retention deletes whole expired
 * day folders in bulk, without reading them. Each R2 call is counted against
 * the run's allowance; each page of keys is deleted as soon as it is listed, so
 * a run that runs out keeps what it deleted and the next run goes on.
 *
 * App folders are listed a page at a time, starting after the last app the
 * previous run reached (kept in one small object), so a run always makes
 * progress, however many apps there are, and one busy app never holds up the
 * apps after it: the next run starts after it, and comes round to it again.
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

async function appRetention(db: D1Database): Promise<Map<string, number>> {
  const { results } = await db.prepare("SELECT id, config_json FROM app").all<{ id: string; config_json: string }>();
  const days = new Map<string, number>();
  for (const row of results) days.set(row.id, retentionOf(row.config_json));
  return days;
}

/**
 * The app's retention as stored right now, read just before a folder is deleted, so a retention raised
 * while the sweep runs is honoured. `null` when it can't be read or the app is gone: the folder waits.
 */
async function currentRetention(db: D1Database, appId: string): Promise<number | null> {
  try {
    const row = await db.prepare("SELECT config_json FROM app WHERE id = ?").bind(appId).first<{ config_json: string }>();
    return row === null ? null : retentionOf(row.config_json);
  } catch {
    return null;
  }
}

/**
 * Whether the app is still gone, read just before a removed app's page is deleted, so an app made
 * while the sweep runs keeps its records. False when it exists or the read fails: the folder waits.
 */
async function appStillAbsent(db: D1Database, appId: string): Promise<boolean> {
  try {
    const row = await db.prepare("SELECT 1 AS present FROM app WHERE id = ?").bind(appId).first<{ present: number }>();
    return row === null;
  } catch {
    return false;
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
  let finished: string | null = null;
  let last: string | null = null;
  /** The app folder being worked on: where the allowance runs out, the next run starts after it. */
  let current: string | null = null;
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
          current = folder;
          const days = retention.get(appId);
          if (days === undefined) {
            // The app was missing when the sweep began; it is looked up again before each page,
            // so an app made since then keeps what it has written.
            const outcome = await deleteAll(bucket, folder, work, pageSize, () => appStillAbsent(db, appId));
            result.deletedObjects += outcome.deleted;
            if (!outcome.stopped) result.removedApps += 1;
          } else {
            const prefix = appPrefix(appId);
            for (const day of await folders(bucket, prefix, work, pageSize)) {
              const match = DAY_FOLDER.exec(day.slice(prefix.length));
              // Day folders sort oldest first, so the first one kept ends the app.
              if (match === null || match[1]! >= dayBefore(now, days)) break;
              // The retention is read again after each page is listed, right before that page is deleted:
              // a retention raised since the sweep began is honoured, and a failed read leaves the folder
              // for a later run.
              const dayName = match[1]!;
              const outcome = await deleteAll(bucket, day, work, pageSize, async () => {
                const fresh = await currentRetention(db, appId);
                return fresh !== null && dayName < dayBefore(now, fresh);
              });
              result.deletedObjects += outcome.deleted;
              if (outcome.stopped) break;
            }
          }
          finished = folder;
          current = null;
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
    // The next run starts after the app it ran out in, so one busy app never holds up
    // those after it; the run that comes round to it again goes on where this one stopped.
    if (current !== null) finished = current;
  }
  if (finished !== null && finished !== last && budget.affords(1)) {
    budget.charge(1);
    await bucket.put(RETENTION_CURSOR, finished);
  }
  return result;
}

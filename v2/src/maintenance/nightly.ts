/**
 * The hourly cron's work (`wrangler.jsonc`: `17 * * * *`), including the two
 * daily runs, each in an hour of its own so each gets its own invocation's
 * limits:
 *
 * - 03:17 UTC: stored conversations past their app's retention
 *   (`../conversations/retention.ts`), with its own allowance of R2 calls;
 * - 04:17 UTC: the nightly maintenance (v1's `prune` in `src/index.ts`).
 *
 * One cron trigger, as v1, rather than one per job: a Workers Free account
 * has only a few to share between all its Workers.
 *
 * Every hour:
 * - expired App Attest challenges are recorded as abandoned and deleted;
 * - the sign-in library's clean-up runs (expired approvals, ended OAuth
 *   connections' tokens).
 *
 * Every night, besides, in the nightly maintenance:
 * - auth events and rejection events past their 90 days are deleted;
 * - usage retention runs (`../ledger/retention.ts`).
 *
 * The nightly maintenance has one allowance of D1 queries
 * (`MAINTENANCE_QUERY_BUDGET`, 50 by default, as v1). v1 chose 50 because a
 * Worker on the Workers Free plan may make only 50 D1 queries per invocation,
 * and this gateway must run on the Free plan out of the box. Each job runs in
 * its own try/catch, so a failure in one leaves the others to run; failures
 * are logged as `warn`.
 */
import { pruneAuthEvents, settleExpiredChallenges, AUTH_EVENT_RETENTION_DAYS } from "../client-auth/auth-events.ts";
import { RETENTION_HOUR_UTC, runConversationRetention } from "../conversations/retention.ts";
import { conversationsBucket } from "../conversations/storage.ts";
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";
import { maintenanceQueryBudget, QueryBudget, QueryBudgetExhausted } from "../core/query-budget.ts";
import { pruneRejectionEvents, REJECTION_RETENTION_DAYS } from "../diagnostics/rejection-events.ts";
import { runUsageRetention } from "../ledger/retention.ts";

/**
 * The UTC hour whose run of the hourly cron also runs the nightly
 * maintenance: 04:17, the hour after conversation retention, so the two
 * never share one invocation's limits.
 */
export const NIGHTLY_HOUR_UTC = 4;

/**
 * D1 statements the sign-in library's clean-up issues: three for its
 * operations, one for OAuth tokens. It runs on its own database handle, so
 * the nightly allowance is charged this up front. A test checks it against
 * the library's own counts, which are not imported here: the library stays
 * off every other path (`../auth/identity.ts`).
 */
export const SIGN_IN_SWEEP_STATEMENTS = 4;

function failed(job: string, code: string, error: unknown): void {
  if (error instanceof QueryBudgetExhausted) {
    log("warn", "maintenance_budget_exhausted", { sweep: job, limit: error.limit });
    return;
  }
  log("warn", code, { error: errorFacts(error) });
}

/** One job: its result logged as `info`, or its failure as `warn`. Never throws. */
async function job<T>(
  name: string,
  failCode: string,
  run: () => Promise<T>,
  facts: (value: T) => Record<string, unknown>,
): Promise<void> {
  try {
    const value = await run();
    log("info", name, facts(value));
  } catch (error) {
    failed(name, failCode, error);
  }
}

/** The sign-in library's clean-up. Loaded on first use, like the rest of the management code. */
function sweepSignIn(env: Env): Promise<void> {
  return job(
    "sign_in_swept",
    "sign_in_sweep_failed",
    async () => (await import("../management/maintenance.ts")).sweepSignIn(env),
    (swept) => ({ ...swept }),
  );
}

/** Expired App Attest challenges, recorded as abandoned and deleted. */
function settleChallenges(db: D1Database): Promise<void> {
  return job("auth_challenges_settled", "auth_challenges_prune_failed", () => settleExpiredChallenges(db), (settled) => ({ ...settled }));
}

/** Stored conversations past their app's retention, where the deployment keeps them. */
function pruneConversations(env: Env, now: number): Promise<void> {
  const bucket = conversationsBucket(env);
  if (bucket === null) return Promise.resolve();
  return job("conversations_pruned", "conversations_prune_failed", () => runConversationRetention(bucket, env.DB, now), (pruned) => ({ ...pruned }));
}

/** The nightly jobs, in order, within `budget`. */
export async function runNightly(env: Env, now: number, budget: QueryBudget): Promise<void> {
  const db = budget.database(env.DB);
  await settleChallenges(db);
  // The event passes are each kept a share, so a large backlog of one never
  // starves usage retention, which is offered everything left.
  const eventShare = () => budget.limited(Math.floor(budget.remaining / 3));
  await job(
    "auth_events_pruned",
    "auth_events_prune_failed",
    () => {
      const share = eventShare();
      return pruneAuthEvents(share.database(env.DB), share, now);
    },
    (pruned) => ({ ...pruned, retentionDays: AUTH_EVENT_RETENTION_DAYS }),
  );
  await job(
    "rejection_events_pruned",
    "rejection_events_prune_failed",
    () => {
      const share = eventShare();
      return pruneRejectionEvents(share.database(env.DB), share, now);
    },
    (pruned) => ({ ...pruned, retentionDays: REJECTION_RETENTION_DAYS }),
  );
  // Logs each pass itself, and never throws.
  await runUsageRetention(env.DB, now, budget);
}

/** The hourly cron. `waitUntil` keeps the work alive after the handler returns. */
export function runHourly(env: Env, scheduledTime: number, waitUntil: (work: Promise<unknown>) => void): void {
  waitUntil(sweepSignIn(env));
  const hour = new Date(scheduledTime).getUTCHours();
  if (hour === RETENTION_HOUR_UTC) waitUntil(pruneConversations(env, scheduledTime));
  if (hour !== NIGHTLY_HOUR_UTC) {
    waitUntil(settleChallenges(env.DB));
    return;
  }
  const budget = maintenanceQueryBudget(env);
  // The sign-in clean-up beside this run spends from the same invocation's limit.
  budget.charge(SIGN_IN_SWEEP_STATEMENTS);
  waitUntil(runNightly(env, scheduledTime, budget));
}

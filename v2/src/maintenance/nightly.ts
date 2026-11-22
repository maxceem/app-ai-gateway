/**
 * The hourly cron's work (`wrangler.jsonc`: `17 * * * *`), and once a day,
 * in the run at {@link NIGHTLY_HOUR_UTC}, the nightly maintenance (v1's
 * `prune` in `src/index.ts`).
 *
 * One cron trigger, as v1, rather than one per job: a Workers Free account
 * has only a few to share between all its Workers.
 *
 * Every hour:
 * - expired App Attest challenges are recorded as abandoned and deleted;
 * - the sign-in library's clean-up runs (expired approvals, ended OAuth
 *   connections' tokens).
 *
 * Every night, besides:
 * - auth events and rejection events past their 90 days are deleted;
 * - stored conversations past their app's retention are deleted;
 * - usage retention runs (`../ledger/retention.ts`).
 *
 * The nightly run shares one allowance of D1 queries and R2 calls
 * (`MAINTENANCE_QUERY_BUDGET`, 50 by default, as v1): a Worker on the Free
 * plan may make only 50 per invocation. Each job runs in its own try/catch,
 * so a failure in one leaves the others to run; failures are logged as `warn`.
 */
import { pruneAuthEvents, settleExpiredChallenges, AUTH_EVENT_RETENTION_DAYS } from "../client-auth/auth-events.ts";
import { runConversationRetention } from "../conversations/retention.ts";
import { conversationsBucket } from "../conversations/storage.ts";
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";
import { maintenanceQueryBudget, QueryBudget, QueryBudgetExhausted } from "../core/query-budget.ts";
import { pruneRejectionEvents, REJECTION_RETENTION_DAYS } from "../diagnostics/rejection-events.ts";
import { runUsageRetention } from "../ledger/retention.ts";

/** The UTC hour whose run of the hourly cron also runs the nightly maintenance: 03:17, as v1. */
export const NIGHTLY_HOUR_UTC = 3;

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

/** The nightly jobs, in order, within `budget`. */
export async function runNightly(env: Env, now: number, budget: QueryBudget): Promise<void> {
  const db = budget.database(env.DB);
  await job("auth_challenges_settled", "auth_challenges_prune_failed", () => settleExpiredChallenges(db), (settled) => ({ ...settled }));
  await job("auth_events_pruned", "auth_events_prune_failed", () => pruneAuthEvents(db, now), (deleted) => ({ deleted, retentionDays: AUTH_EVENT_RETENTION_DAYS }));
  await job("rejection_events_pruned", "rejection_events_prune_failed", () => pruneRejectionEvents(db, now), (deleted) => ({ deleted, retentionDays: REJECTION_RETENTION_DAYS }));
  // Offered half of what is left, as v1, so usage retention is never starved.
  // What it does not spend stays for the jobs after it.
  const bucket = conversationsBucket(env);
  if (bucket !== null) {
    await job(
      "conversations_pruned",
      "conversations_prune_failed",
      () => {
        const share = budget.limited(Math.floor(budget.remaining / 2));
        return runConversationRetention(bucket, env.DB, now, share);
      },
      (result) => ({ ...result }),
    );
  }
  // Logs each pass itself, and never throws.
  await runUsageRetention(env.DB, now, budget);
}

/** The hourly cron. `waitUntil` keeps the work alive after the handler returns. */
export function runHourly(env: Env, scheduledTime: number, waitUntil: (work: Promise<unknown>) => void): void {
  waitUntil(sweepSignIn(env));
  if (new Date(scheduledTime).getUTCHours() !== NIGHTLY_HOUR_UTC) {
    waitUntil(job("auth_challenges_settled", "auth_challenges_prune_failed", () => settleExpiredChallenges(env.DB), (settled) => ({ ...settled })));
    return;
  }
  const budget = maintenanceQueryBudget(env);
  // The sign-in clean-up beside this run spends from the same invocation's limit.
  budget.charge(SIGN_IN_SWEEP_STATEMENTS);
  waitUntil(runNightly(env, scheduledTime, budget));
}

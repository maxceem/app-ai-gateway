/**
 * The hourly cron's work (`wrangler.jsonc`: `17 * * * *`), including the two
 * daily runs, each in an hour of its own so each gets its own invocation's
 * limits:
 *
 * - 03:17 UTC: stored conversations past their app's retention
 *   (`../conversations/retention.ts`), with its own allowance of R2 calls,
 *   and the D1 queries `MAINTENANCE_QUERY_BUDGET` leaves after the hourly
 *   clean-up;
 * - 04:17 UTC: the nightly maintenance (v1's `prune` in `src/index.ts`).
 *
 * One cron trigger, as v1, rather than one per job: a Workers Free account
 * has only a few to share between all its Workers.
 *
 * Every hour:
 * - expired App Attest challenges are recorded as abandoned and deleted, up
 *   to `CHALLENGE_DRAIN_BATCHES` batches of 1,000 while they come back full;
 *   one batch in the 03:17 and 04:17 runs, whose statements the other jobs
 *   there need;
 * - the sign-in library's clean-up runs (expired approvals, ended OAuth
 *   connections' tokens).
 *
 * Every night, besides, one more batch of expired challenges. The ledger's
 * own nightly maintenance (`runLedgerNightly`) runs on each account's ledger
 * object, with the same allowances per account: a set of passes taking turns
 * (`../core/chunked-delete.ts`):
 * - auth events and rejection events past their 90 days are deleted;
 * - usage retention (`../ledger/retention.ts`).
 *
 * The nightly maintenance has two allowances:
 * - D1 statements (`MAINTENANCE_QUERY_BUDGET`, 50 by default, as v1). v1
 *   chose 50 because a Worker on the Workers Free plan may make only 50 D1
 *   queries per invocation, and this gateway must run on the Free plan out of
 *   the box.
 * - rows written (`MAINTENANCE_ROW_BUDGET`, 20,000 by default): the Free plan
 *   allows 100,000 a day for the whole account, and the apps need the rest.
 *
 * Each job and each pass fails on its own: a failure leaves the others to
 * run, and is logged as `warn`.
 */
import { authEventsPass, drainExpiredChallenges } from "../client-auth/auth-events.ts";
import { RETENTION_HOUR_UTC, runConversationRetention } from "../conversations/retention.ts";
import { conversationsBucket } from "../conversations/storage.ts";
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";
import { runPasses, type Pass } from "../core/chunked-delete.ts";
import { maintenanceStatementBudget, QueryBudget, QueryBudgetExhausted } from "../core/query-budget.ts";
import { rejectionEventsPass } from "../diagnostics/rejection-events.ts";
import { STUCK_SESSION_STATEMENTS, usageRetentionPasses, warnStuckSessions } from "../ledger/retention.ts";

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

/** Expired App Attest challenges, recorded as abandoned and deleted, at most `batches` batches. */
function settleChallenges(env: Env, db: D1Database, batches: number): Promise<void> {
  return job("auth_challenges_settled", "auth_challenges_prune_failed", () => drainExpiredChallenges(env, db, batches), (settled) => ({ ...settled }));
}

/** D1 statements one batch of the App Attest challenge clean-up issues: one read of a bounded batch of challenges, then one delete. Its events go to the ledger objects. */
export const CHALLENGE_SETTLE_STATEMENTS = 2;

/**
 * Batches of expired challenges an ordinary hour settles while they come back
 * full: 5,000 challenges, 15 statements beside the sign-in clean-up's 4, well
 * inside the 50 D1 queries one invocation may make on the Free plan.
 */
export const CHALLENGE_DRAIN_BATCHES = 5;

/**
 * Conversation retention's D1 queries: what `MAINTENANCE_QUERY_BUDGET` leaves
 * once the hourly clean-up in the same 03:17 run has had its statements. 43 at
 * the default of 50, and more where a deployment on the Paid plan raises it.
 */
export function conversationReadBudget(env: Env): QueryBudget {
  const reads = maintenanceStatementBudget(env);
  reads.charge(SIGN_IN_SWEEP_STATEMENTS + CHALLENGE_SETTLE_STATEMENTS);
  return reads;
}

/** Stored conversations past their app's retention, where the deployment keeps them. */
function pruneConversations(env: Env, now: number): Promise<void> {
  const bucket = conversationsBucket(env);
  if (bucket === null) return Promise.resolve();
  return job(
    "conversations_pruned",
    "conversations_prune_failed",
    () => runConversationRetention(bucket, env.DB, now, undefined, undefined, conversationReadBudget(env)),
    (pruned) => ({ ...pruned }),
  );
}

/**
 * The nightly passes over one account's ledger at `now`, in the order they
 * take their turns. The ledger object runs them once a day on its alarm
 * (`../do/AccountLedger.ts`).
 */
export function nightlyPasses(now: number): Pass[] {
  return [authEventsPass(now), rejectionEventsPass(now), ...usageRetentionPasses(now)];
}

/**
 * The nightly maintenance of one account's ledger, within `budget`'s
 * statements and `rowLimit` rows written: stuck sessions are reported, then
 * the passes take their turns. Never throws.
 */
export async function runLedgerNightly(ledger: D1Database, now: number, budget: QueryBudget, rowLimit: number): Promise<void> {
  if (budget.affords(STUCK_SESSION_STATEMENTS)) {
    await job("ledger_sessions_checked", "ledger_sessions_check_failed", () => warnStuckSessions(budget.database(ledger), now), (stuck) => ({ stuck }));
  }
  // Logs each pass itself, and never throws.
  await runPasses(ledger, budget, rowLimit, nightlyPasses(now));
}

/** The nightly jobs on the settings in D1, within `budget`'s statements. */
export async function runNightly(env: Env, budget: QueryBudget): Promise<void> {
  await settleChallenges(env, budget.database(env.DB), 1);
}

/** The hourly cron. `waitUntil` keeps the work alive after the handler returns. */
export function runHourly(env: Env, scheduledTime: number, waitUntil: (work: Promise<unknown>) => void): void {
  waitUntil(sweepSignIn(env));
  const hour = new Date(scheduledTime).getUTCHours();
  if (hour === RETENTION_HOUR_UTC) waitUntil(pruneConversations(env, scheduledTime));
  if (hour !== NIGHTLY_HOUR_UTC) {
    // In the conversations' hour, one batch: their D1 allowance counts on it (`conversationReadBudget`).
    waitUntil(settleChallenges(env, env.DB, hour === RETENTION_HOUR_UTC ? 1 : CHALLENGE_DRAIN_BATCHES));
    return;
  }
  const budget = maintenanceStatementBudget(env);
  // The sign-in clean-up beside this run spends from the same invocation's limit.
  budget.charge(SIGN_IN_SWEEP_STATEMENTS);
  waitUntil(runNightly(env, budget));
}

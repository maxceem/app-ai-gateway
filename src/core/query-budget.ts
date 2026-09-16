import { log } from "./log";

/**
 * A scheduled run's remaining query allowance, decremented as statements are
 * issued.
 *
 * Mutable and shared rather than returned, so that a sweep which throws partway
 * still leaves an accurate count behind for the sweep after it, and so the
 * nightly run can hand what one sweep did not spend to the next.
 */
export interface QueryBudget {
  remaining: number;
}

/**
 * Queries one nightly maintenance run may issue, across every sweep.
 *
 * D1 queries are subrequests, and a Worker invocation may issue 1,000 of them
 * on the Workers Paid plan but only **50** on the Free plan. This project is
 * meant to be easy to self-host, so the default is the Free one: exceeding it
 * would not corrupt anything — every chunk the retention pass commits is its
 * own transaction — but it would throw on a query every night, and take the
 * passes after it down with it, which is a bad way to discover a limit.
 */
export const DEFAULT_MAINTENANCE_QUERY_BUDGET = 50;

/** Left unspent, so a miscount in one sweep cannot reach the platform ceiling. */
export const MAINTENANCE_SLACK_QUERIES = 1;

/** Below this a run cannot complete a single useful pass, so it is not honoured. */
const MINIMUM_MAINTENANCE_QUERY_BUDGET = 20;

/**
 * The allowance for one nightly run, raised by `MAINTENANCE_QUERY_BUDGET`.
 *
 * Deliberately not a `vars` entry in `wrangler.jsonc`: the Deploy to Cloudflare
 * form shows every one of those as a field, and a deployment that never outgrows
 * the Free plan — which is most of them — should not have to answer a question
 * about D1 subrequest ceilings to install this gateway. A deployment on the
 * Workers Paid plan sets it in the dashboard or in a profile overlay once it has
 * a retention backlog worth draining faster.
 */
export function maintenanceQueryBudget(env: Env): QueryBudget {
  const configured = env.MAINTENANCE_QUERY_BUDGET;
  if (configured === undefined || configured.trim() === "")
    return { remaining: DEFAULT_MAINTENANCE_QUERY_BUDGET };
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < MINIMUM_MAINTENANCE_QUERY_BUDGET) {
    log("warn", "maintenance_query_budget_invalid", {
      configured,
      minimum: MINIMUM_MAINTENANCE_QUERY_BUDGET,
      using: DEFAULT_MAINTENANCE_QUERY_BUDGET,
    });
    return { remaining: DEFAULT_MAINTENANCE_QUERY_BUDGET };
  }
  return { remaining: parsed };
}

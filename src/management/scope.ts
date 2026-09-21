import type { BillingRequestCache } from "../billing/gateway";
import type { Deployment } from "../policy/deployment";

/**
 * Everything a management operation needs about the request it belongs to,
 * other than who is making it.
 *
 * One object rather than three parameters threaded through every signature:
 * a service function that stores a row needs the database, what kind of
 * deployment it is running on (for the plan ceiling) and the request's billing
 * cache, and passing them separately made the useful arguments — the actor,
 * the body, the write boundary — the fourth, fifth and sixth.
 */
export interface ManagementScope {
  env: Env;
  deployment: Deployment;
  billingCache: BillingRequestCache;
}

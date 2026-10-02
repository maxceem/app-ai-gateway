import type { CfAuth } from "@maxceem/cf-auth";
import type { BillingRequestCache } from "../billing/gateway";
import type { Deployment } from "../policy/deployment";

/**
 * The request's cf-auth instance: its service, which resolves and issues
 * credentials, and its operation engine, which opens, reserves, executes,
 * reports and reveals the operations a management write runs under.
 */
export type IdentityInstances = CfAuth;

/**
 * Everything a management operation needs about the request it belongs to,
 * other than who is making it.
 *
 * One object rather than three parameters threaded through every signature: a
 * service function that stores a row needs the database, what kind of
 * deployment it is running on (for the plan ceiling) and the request's billing
 * cache, and passing them separately would push the arguments that matter —
 * the actor, the body, the write boundary — into fourth place and beyond.
 */
export interface ManagementScope {
  env: Env;
  deployment: Deployment;
  billingCache: BillingRequestCache;
  /**
   * The request's cf-auth instance, built on first use and shared by every
   * later call in the request. A function, not a value: building one loads
   * the identity library, which most management operations never touch.
   */
  identity(): Promise<IdentityInstances>;
}

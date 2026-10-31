import type { MiddlewareHandler } from "hono";
import type { CfAuth } from "@maxceem/cf-auth";
import type { BillingRequestCache } from "../billing/gateway";
import { resolveDeployment, type Deployment } from "../policy/deployment";

/** What every request on this Worker carries, whichever surface serves it. */
export interface RequestVariables {
  /** What kind of deployment is answering, resolved once per request. */
  deployment: Deployment;
  /**
   * Every read of an organization's entitlement inside one request shares this
   * map, so a request that consults billing in a gate and again in a handler
   * asks the billing service once.
   */
  billingRequestCache: BillingRequestCache;
  /**
   * The cf-auth instances this request builds, keyed by their options.
   *
   * The promise rather than the instance, so two callers that await the same
   * options concurrently share one build instead of racing to make two.
   */
  identityAuthCache: Map<string, Promise<CfAuth>>;
  /**
   * Aborted when a client call runs past its deadline, with the refusal as its
   * `reason`. Set only on the routes `./deadline` guards.
   */
  deadline?: AbortSignal;
  /**
   * The catalog operation a management request was matched to, and the
   * engine kind it opened, for `./management-analytics`. Set only where the
   * deployment binds `MANAGEMENT_ANALYTICS`.
   */
  managementOperation?: string;
  managementKind?: string;
}

/**
 * Opens the per-request scope: what the deployment is, one billing cache, and
 * one map of the cf-auth instances this request builds.
 *
 * It lives here rather than in the entry module because the lazily mounted
 * management surface needs it too: an inner Hono app builds its own `Context`,
 * and a variable set on the outer request's context is not visible there, so
 * the middleware has to run again inside it.
 */
export const requestScope: MiddlewareHandler<{
  Bindings: Env;
  Variables: RequestVariables;
}> = async (c, next) => {
  c.set("deployment", resolveDeployment(c.env, c.req.url));
  c.set("billingRequestCache", new Map());
  c.set("identityAuthCache", new Map());
  await next();
};

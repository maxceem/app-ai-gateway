import type { MiddlewareHandler } from "hono";
import type { BillingVariables } from "../billing/gateway";

/**
 * Opens the per-request billing cache.
 *
 * Every read of an organization's entitlement inside one request shares this
 * map, so a request that consults billing in a gate and again in a handler asks
 * the billing service once. It lives here rather than in the entry module
 * because the lazily mounted management surface needs it too: an inner Hono app
 * builds its own `Context`, and a variable set on the outer request's context
 * is not visible there, so the middleware has to run again inside it.
 */
export const billingRequestScope: MiddlewareHandler<{
  Bindings: Env;
  Variables: BillingVariables;
}> = async (c, next) => {
  c.set("billingRequestCache", new Map());
  await next();
};

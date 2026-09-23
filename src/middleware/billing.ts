import { assertAccountAccess } from "../core/account-lifecycle";
import type { MiddlewareHandler } from "hono";
import {
  getBillingAccess,
  requireActiveBilling,
} from "../billing/gateway";
import { loadApp } from "../core/config";
import { GatewayError } from "../core/errors";
import type { RequestVariables } from "./request-scope";

/**
 * The account's standing, for the client calls that are not served requests:
 * the application token exchange and `/me`. A served request checks the account
 * itself, as the first step of `../execution/serve`, and leaves the plan to
 * admission.
 */
export const billingEntitlementGate: MiddlewareHandler<{
  Bindings: Env;
  Variables: RequestVariables;
}> = async (c, next) => {
  /*
   * A deployment without a billing binding is self-hosted: it has no plan to
   * check, and no account of its own ever carries a deadline, because only a
   * cloud bootstrap writes one. So this whole gate — and the D1 read behind it
   * — costs a self-hosted deployment nothing.
   */
  const deployment = c.get("deployment");
  if (deployment.mode === "self_hosted") {
    await next();
    return;
  }

  const appId = c.req.param("app");
  if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
  const app = await loadApp(c.env, appId);
  await assertAccountAccess(deployment, c.env, app.organizationId, "proxy");
  requireActiveBilling(await getBillingAccess(
    deployment,
    app.organizationId,
    c.get("billingRequestCache"),
  ));
  await next();
};

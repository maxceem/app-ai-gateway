import { assertAccountAccess } from "../core/account-lifecycle";
import type { MiddlewareHandler } from "hono";
import {
  billingBinding,
  getBillingAccess,
  requireActiveBilling,
  type BillingVariables,
} from "../billing/gateway";
import { loadAppConfig } from "../core/config";
import { GatewayError } from "../core/errors";

export const billingEntitlementGate: MiddlewareHandler<{
  Bindings: Env;
  Variables: BillingVariables;
}> = async (c, next) => {
  /*
   * A deployment without a billing binding is self-hosted: it has no plan to
   * check, and no account of its own ever carries a deadline, because only a
   * cloud bootstrap writes one. So this whole gate — and the D1 read behind it
   * — costs a self-hosted deployment nothing.
   */
  if (!billingBinding(c.env)) {
    await next();
    return;
  }

  const appId = c.req.param("app");
  if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
  const app = await loadAppConfig(c.env, appId);
  /*
   * The account's own deadlines, first and on every application route. An
   * account that has expired is refused before the request attests a key,
   * resolves a provider or spends one of the limits the organization set on its
   * own users: those are the organization's to spend, and an account that may
   * not be served has no claim on them.
   */
  await assertAccountAccess(c.env, app.organizationId, "proxy");
  // The plan allowance is not decided here. Dispatch spends it only after the
  // application's own limits have had their say, so the quota gate owns it.
  if (c.req.path.includes("/proxy/") || c.req.path.includes("/endpoints/")) {
    await next();
    return;
  }
  requireActiveBilling(await getBillingAccess(
    c.env,
    app.organizationId,
    c.get("billingRequestCache"),
  ));
  await next();
};

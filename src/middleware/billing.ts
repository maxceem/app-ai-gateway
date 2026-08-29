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
  if (!billingBinding(c.env)) {
    await next();
    return;
  }

  const appId = c.req.param("app");
  if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
  const app = await loadAppConfig(c.env, appId);
  requireActiveBilling(await getBillingAccess(
    c.env,
    app.organizationId,
    c.get("billingRequestCache"),
  ));
  await next();
};

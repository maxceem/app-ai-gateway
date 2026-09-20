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
import { organizationProviders } from "../core/provider-store";

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
  const served = c.req.path.includes("/proxy/") || c.req.path.includes("/endpoints/");
  /*
   * The account's own deadlines, first and on every application route. An
   * account that has expired is refused before the request attests a key,
   * resolves a provider or spends one of the limits the organization set on its
   * own users: those are the organization's to spend, and an account that may
   * not be served has no claim on them.
   *
   * On a served request the organization's provider rows are read alongside it,
   * because the two reads are independent — neither answer changes the other's
   * query — and one of them is going to be needed a few microtasks later
   * whatever this gate decides. Starting them together turns two serial round
   * trips into one on a cold isolate.
   *
   * `allSettled` rather than `all`, for two reasons. The lifecycle decides
   * first, so its rejection is the one thrown and nothing about the order this
   * gate refuses in changes; and a provider read that fails must not become an
   * unhandled rejection while the lifecycle rejection is on its way out.
   *
   * The provider outcome is ignored entirely. It is a best-effort cache warm:
   * `gatewayAuth`, `proxyPrepare` and `endpointPrepare` all read the same rows
   * again through the same cache, and if this read failed, theirs re-reads and
   * surfaces the failure with the context to describe it. Answering it here
   * would mean refusing a request for a provider the request may not even name.
   */
  if (served) {
    const [lifecycle] = await Promise.allSettled([
      assertAccountAccess(c.env, app.organizationId, "proxy"),
      organizationProviders(c.env, app.organizationId),
    ]);
    if (lifecycle.status === "rejected") throw lifecycle.reason;
    // The plan allowance is not decided here. Dispatch spends it only after the
    // application's own limits have had their say, so the quota gate owns it.
    await next();
    return;
  }
  await assertAccountAccess(c.env, app.organizationId, "proxy");
  requireActiveBilling(await getBillingAccess(
    c.env,
    app.organizationId,
    c.get("billingRequestCache"),
  ));
  await next();
};

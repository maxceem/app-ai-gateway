import type { BillingRuntime } from "../../billing/contract";
import { Hono, type Context } from "hono";
import {
  BILLING_SERVICE_ID,
  billingPlanLimits,
  billingRpcError,
  invalidateBillingAccess,
  subscriptionActions,
} from "../../billing/gateway";
import { accountLifecycle } from "../../core/account-lifecycle";
import { accountUnclaimed, unclaimedAccessDeadline } from "../../policy/accounts";
import { billingQuota, quotaUsage } from "../../billing/quota";
import type { BillingStatusResponse } from "../../contracts/billing";
import type { BodiedOperation } from "../../contracts/catalog";
import { adminRouter, type HttpOperationHandler } from "../catalog-router";
import { GatewayError } from "../../core/errors";
import type { AdminVariables } from "../../middleware/admin";

type BillingRouteEnv = {
  Bindings: Env;
  Variables: AdminVariables;
};

export const billingRoutes = new Hono<BillingRouteEnv>();
const routes = adminRouter(billingRoutes, "/v1/admin/billing");

/**
 * The billing service, or the one refusal a deployment without one gives every
 * operation here.
 */
function binding(c: Context<BillingRouteEnv>): BillingRuntime {
  const value = c.get("deployment").billing;
  if (!value) throw new GatewayError(404, "not_found", "Billing is not configured");
  return value;
}

/**
 * The only way an operation is mounted here: each runs `binding` as its
 * `before`, so a deployment without billing is refused before a body is read.
 */
function handle<K extends BodiedOperation>(name: K, handler: HttpOperationHandler<BillingRouteEnv, K>): void {
  routes.handle(name, handler, { before: (c) => void binding(c) });
}

async function rpc<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw billingRpcError(error);
  }
}

handle("listBillingPlans", (c) => rpc(() => binding(c).listPlans({
  serviceId: BILLING_SERVICE_ID,
})));

/**
 * Reads the live count out of the organization's quota object.
 *
 * The console has no other source for it. The count lives in a Durable Object
 * that only the dispatch path writes, and the usage tables record what was
 * spent rather than what is left — so until an organization is actually refused,
 * nothing tells an operator how close it is. Reporting it beside the
 * subscription is what turns a runaway client into something noticed on day
 * three instead of on the first `429`.
 *
 * A self-hosted deployment never gets here — every `/billing` operation is
 * refused without a billing binding — so there is no allowance-less case to
 * report. A malformed plan limit is deliberately left to throw: the data plane
 * is already refusing every request for that reason, and the operator reading
 * this page is exactly who needs to see why.
 */
async function status(c: Context<BillingRouteEnv>): Promise<BillingStatusResponse> {
  const organizationId = c.get("actor").organizationId;
  const quota = await billingQuota(
    c.get("deployment"),
    c.env,
    organizationId,
    c.get("billingRequestCache"),
  );
  /*
   * The plan's ceilings, parsed. `access.plan.limits` is in the response
   * already, but it is whatever JSON the plan was authored with; this is the
   * subset this gateway actually enforces, with every value checked to be a
   * whole count. A client comparing what it owns against a ceiling should read
   * this, so that it is reading the same numbers the write path will apply.
   *
   * Absent keys mean unlimited, so an empty object is the honest answer for a
   * plan with no ceilings and for a self-hosted deployment alike.
   */
  const limits = billingPlanLimits(quota.access);
  // The account's own deadline, beside its billing: the one window a person
  // can end by claiming the account, which no plan changes.
  const account = await accountLifecycle(c.env, organizationId);
  const deadline = accountUnclaimed(account) ? unclaimedAccessDeadline(account.createdAt) : null;
  const unclaimedAccessEndsAt = deadline === null ? null : new Date(deadline).toISOString();
  return {
    access: quota.access,
    limits,
    // A plan with no monthly limit counts nothing, so there is no figure to report.
    quota: await quotaUsage(c.env, organizationId, quota),
    actions: subscriptionActions(quota.access),
    unclaimedAccessEndsAt,
  };
}

handle("getBillingStatus", status);

handle("startCheckout", async (c, { body: input }) => {
  const result = await rpc(() => binding(c).createCheckout({
    serviceId: BILLING_SERVICE_ID,
    tenantId: c.get("actor").organizationId,
    planKey: input.planKey,
    billingPeriod: input.billingPeriod,
    ...(input.successUrl === undefined ? {} : { successUrl: input.successUrl }),
    ...(input.cancelUrl === undefined ? {} : { cancelUrl: input.cancelUrl }),
  }));
  invalidateBillingAccess(c.get("actor").organizationId);
  return result;
});

handle("changePlan", async (c, { body: input }) => {
  const result = await rpc(() => binding(c).changePlan({
    serviceId: BILLING_SERVICE_ID,
    tenantId: c.get("actor").organizationId,
    planKey: input.planKey,
    billingPeriod: input.billingPeriod,
  }));
  invalidateBillingAccess(c.get("actor").organizationId);
  return result;
});

handle("cancelSubscription", async (c) => {
  const result = await rpc(() => binding(c).cancelSubscription({
    serviceId: BILLING_SERVICE_ID,
    tenantId: c.get("actor").organizationId,
  }));
  invalidateBillingAccess(c.get("actor").organizationId);
  return result;
});

handle("resumeSubscription", async (c, { body: input }) => {
  const result = await rpc(() => binding(c).resumeSubscription({
    serviceId: BILLING_SERVICE_ID,
    tenantId: c.get("actor").organizationId,
    planKey: input.planKey,
    billingPeriod: input.billingPeriod,
  }));
  invalidateBillingAccess(c.get("actor").organizationId);
  return result;
});

handle("startTrial", async (c, { body: input }) => {
  const result = await rpc(() => binding(c).startTrial({
    serviceId: BILLING_SERVICE_ID,
    tenantId: c.get("actor").organizationId,
    planKey: input.planKey,
  }));
  invalidateBillingAccess(c.get("actor").organizationId);
  return result;
});

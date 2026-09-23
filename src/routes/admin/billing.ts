import type { BillingRuntime } from "../../billing/contract";
import { Hono, type Context } from "hono";
import {
  BILLING_SERVICE_ID,
  billingPlanLimits,
  billingRpcError,
  invalidateBillingAccess,
  invalidateBillingRequestAccess,
} from "../../billing/gateway";
import { getBillingQuotaResolution } from "../../billing/quota";
import {
  BillingCheckoutRequestSchema,
  BillingPlanSelectionSchema,
  BillingTrialRequestSchema,
  type BillingStatusResponse,
} from "../../contracts/billing";
import { schemaBody } from "../../management/validation";
import { jsonBody } from "./body";
import { adminRouter } from "../catalog-router";
import { GatewayError } from "../../core/errors";
import type { AdminVariables } from "../../middleware/admin";

type BillingRouteEnv = {
  Bindings: Env;
  Variables: AdminVariables;
};

export const billingRoutes = new Hono<BillingRouteEnv>();
const routes = adminRouter(billingRoutes, "/v1/admin/billing");

function binding(c: Context<BillingRouteEnv>): BillingRuntime {
  const value = c.get("deployment").billing;
  if (!value) throw new GatewayError(404, "not_found", "Billing is not configured");
  return value;
}

async function rpc<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw billingRpcError(error);
  }
}

routes.handle("listBillingPlans", (c) => rpc(() => binding(c).listPlans({
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
 * A self-hosted deployment never gets here — the whole `/billing` subtree is
 * refused without a billing binding — so there is no allowance-less case to
 * report. A malformed plan limit is deliberately left to throw: the data plane
 * is already refusing every request for that reason, and the operator reading
 * this page is exactly who needs to see why.
 */
async function status(c: Context<BillingRouteEnv>): Promise<BillingStatusResponse> {
  const organizationId = c.get("actor").organizationId;
  let resolved = await getBillingQuotaResolution(
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
  const limits = billingPlanLimits(resolved.access);
  if (!resolved.period) return { access: resolved.access, limits, quota: null };
  const quota = c.env.ORG_QUOTA.getByName(organizationId);
  let usage = await (Date.parse(resolved.period.periodEnd) <= Date.now() ? quota.pastUsage(resolved.period) : quota.usage(resolved.period));
  if ("superseded" in usage && usage.superseded) {
    invalidateBillingRequestAccess(organizationId, c.get("billingRequestCache"));
    resolved = await getBillingQuotaResolution(
      c.get("deployment"),
      c.env,
      organizationId,
      c.get("billingRequestCache"),
    );
    if (!resolved.period) return { access: resolved.access, limits, quota: null };
    usage = await (Date.parse(resolved.period.periodEnd) <= Date.now() ? quota.pastUsage(resolved.period) : quota.usage(resolved.period));
  }
  if ("superseded" in usage && usage.superseded) {
    throw new GatewayError(503, "billing_unavailable", "Billing changed while status was being read");
  }
  return {
    access: resolved.access,
    limits,
    quota: { ...usage, ...(resolved.limit === undefined ? {} : { limit: resolved.limit }) },
  };
}

routes.handle("getBillingStatus", status);

routes.handle("startCheckout", async (c) => {
  const input = schemaBody(BillingCheckoutRequestSchema, await jsonBody(c));
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

routes.handle("changePlan", async (c) => {
  const input = schemaBody(BillingPlanSelectionSchema, await jsonBody(c));
  const result = await rpc(() => binding(c).changePlan({
    serviceId: BILLING_SERVICE_ID,
    tenantId: c.get("actor").organizationId,
    planKey: input.planKey,
    billingPeriod: input.billingPeriod,
  }));
  invalidateBillingAccess(c.get("actor").organizationId);
  return result;
});

routes.handle("cancelSubscription", async (c) => {
  const result = await rpc(() => binding(c).cancelSubscription({
    serviceId: BILLING_SERVICE_ID,
    tenantId: c.get("actor").organizationId,
  }));
  invalidateBillingAccess(c.get("actor").organizationId);
  return result;
});

routes.handle("resumeSubscription", async (c) => {
  const input = schemaBody(BillingPlanSelectionSchema, await jsonBody(c));
  const result = await rpc(() => binding(c).resumeSubscription({
    serviceId: BILLING_SERVICE_ID,
    tenantId: c.get("actor").organizationId,
    planKey: input.planKey,
    billingPeriod: input.billingPeriod,
  }));
  invalidateBillingAccess(c.get("actor").organizationId);
  return result;
});

routes.handle("startTrial", async (c) => {
  const input = schemaBody(BillingTrialRequestSchema, await jsonBody(c));
  const result = await rpc(() => binding(c).startTrial({
    serviceId: BILLING_SERVICE_ID,
    tenantId: c.get("actor").organizationId,
    planKey: input.planKey,
  }));
  invalidateBillingAccess(c.get("actor").organizationId);
  return result;
});

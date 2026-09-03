import type { BillingPeriod, BillingRuntime } from "cf-billing";
import { Hono, type Context } from "hono";
import {
  BILLING_SERVICE_ID,
  billingBinding,
  billingPlanLimits,
  billingRpcError,
  getBillingAccess,
  invalidateBillingAccess,
  type GatewayBillingAccess,
} from "../../billing/gateway";
import { GatewayError } from "../../core/errors";
import type { AdminVariables } from "../../middleware/admin";

type BillingRouteEnv = {
  Bindings: Env;
  Variables: AdminVariables;
};

export const billingRoutes = new Hono<BillingRouteEnv>();

function binding(env: Env): BillingRuntime {
  const value = billingBinding(env);
  if (!value) throw new GatewayError(404, "not_found", "Billing is not configured");
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GatewayError(400, "invalid_request", "A JSON object is required");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GatewayError(400, "invalid_request", `${name} is required`);
  }
  return value.trim();
}

function billingPeriod(value: unknown): BillingPeriod {
  if (value !== "month" && value !== "year") {
    throw new GatewayError(400, "invalid_request", "billingPeriod must be month or year");
  }
  return value;
}

async function rpc<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw billingRpcError(error);
  }
}

billingRoutes.get("/plans", async (c) => c.json(await rpc(() => binding(c.env).listPlans({
  serviceId: BILLING_SERVICE_ID,
}))));

/** What the organization has spent of the allowance it pays for. */
export interface OrganizationQuotaStatus {
  /** The UTC calendar month being reported, `YYYY-MM`. */
  month: string;
  /** Requests dispatched to a provider this month, organization-wide. */
  used: number;
  /** The plan's `maxRequestsPerMonth`. Absent means the plan sets no ceiling. */
  limit?: number;
  /** The instant a fresh allowance begins, ISO-8601 in UTC. */
  resetAt: string;
}

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
async function organizationQuota(
  env: Env,
  organizationId: string,
  access: GatewayBillingAccess,
): Promise<OrganizationQuotaStatus> {
  const limit = billingPlanLimits(access).maxRequestsPerMonth;
  const usage = await env.ORG_QUOTA.getByName(organizationId).usage(Date.now());
  return { ...usage, ...(limit === undefined ? {} : { limit }) };
}

async function status(c: Context<BillingRouteEnv>) {
  const organizationId = c.get("admin").organizationId;
  const access = await getBillingAccess(
    c.env,
    organizationId,
    c.get("billingRequestCache"),
  );
  return c.json({ access, quota: await organizationQuota(c.env, organizationId, access) });
}

billingRoutes.get("/status", status);
// cf-billing does not expose a standalone portal-URL RPC. This alias gives the
// console one stable portal/status polling endpoint without inventing a URL.
billingRoutes.get("/portal/status", status);

billingRoutes.post("/checkout", async (c) => {
  const body = record(await c.req.json());
  const result = await rpc(() => binding(c.env).createCheckout({
    serviceId: BILLING_SERVICE_ID,
    tenantId: c.get("admin").organizationId,
    planKey: requiredString(body.planKey, "planKey"),
    billingPeriod: billingPeriod(body.billingPeriod),
    ...(typeof body.successUrl === "string" ? { successUrl: body.successUrl } : {}),
    ...(typeof body.cancelUrl === "string" ? { cancelUrl: body.cancelUrl } : {}),
  }));
  invalidateBillingAccess(c.get("admin").organizationId);
  return c.json(result);
});

billingRoutes.post("/change", async (c) => {
  const body = record(await c.req.json());
  const result = await rpc(() => binding(c.env).changePlan({
    serviceId: BILLING_SERVICE_ID,
    tenantId: c.get("admin").organizationId,
    planKey: requiredString(body.planKey, "planKey"),
    billingPeriod: billingPeriod(body.billingPeriod),
  }));
  invalidateBillingAccess(c.get("admin").organizationId);
  return c.json(result);
});

billingRoutes.post("/cancel", async (c) => {
  const result = await rpc(() => binding(c.env).cancelSubscription({
    serviceId: BILLING_SERVICE_ID,
    tenantId: c.get("admin").organizationId,
  }));
  invalidateBillingAccess(c.get("admin").organizationId);
  return c.json(result);
});

billingRoutes.post("/resume", async (c) => {
  const body = record(await c.req.json());
  const result = await rpc(() => binding(c.env).resumeSubscription({
    serviceId: BILLING_SERVICE_ID,
    tenantId: c.get("admin").organizationId,
    planKey: requiredString(body.planKey, "planKey"),
    billingPeriod: billingPeriod(body.billingPeriod),
  }));
  invalidateBillingAccess(c.get("admin").organizationId);
  return c.json(result);
});

billingRoutes.post("/trial", async (c) => {
  const body = record(await c.req.json());
  const result = await rpc(() => binding(c.env).startTrial({
    serviceId: BILLING_SERVICE_ID,
    tenantId: c.get("admin").organizationId,
    planKey: requiredString(body.planKey, "planKey"),
  }));
  invalidateBillingAccess(c.get("admin").organizationId);
  return c.json(result);
});

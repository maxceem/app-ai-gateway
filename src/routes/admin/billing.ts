import type { BillingPeriod, BillingRuntime } from "cf-billing";
import { Hono, type Context } from "hono";
import {
  BILLING_SERVICE_ID,
  billingBinding,
  billingRpcError,
  getBillingAccess,
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

async function status(c: Context<BillingRouteEnv>) {
  const access = await getBillingAccess(
    c.env,
    c.get("admin").organizationId,
    c.get("billingRequestCache"),
  );
  return c.json({ access });
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
  return c.json(result);
});

billingRoutes.post("/change", async (c) => {
  const body = record(await c.req.json());
  return c.json(await rpc(() => binding(c.env).changePlan({
    serviceId: BILLING_SERVICE_ID,
    tenantId: c.get("admin").organizationId,
    planKey: requiredString(body.planKey, "planKey"),
    billingPeriod: billingPeriod(body.billingPeriod),
  })));
});

billingRoutes.post("/cancel", async (c) => c.json(await rpc(() =>
  binding(c.env).cancelSubscription({
    serviceId: BILLING_SERVICE_ID,
    tenantId: c.get("admin").organizationId,
  }))));

billingRoutes.post("/resume", async (c) => {
  const body = record(await c.req.json());
  return c.json(await rpc(() => binding(c.env).resumeSubscription({
    serviceId: BILLING_SERVICE_ID,
    tenantId: c.get("admin").organizationId,
    planKey: requiredString(body.planKey, "planKey"),
    billingPeriod: billingPeriod(body.billingPeriod),
  })));
});

billingRoutes.post("/trial", async (c) => {
  const body = record(await c.req.json());
  return c.json(await rpc(() => binding(c.env).startTrial({
    serviceId: BILLING_SERVICE_ID,
    tenantId: c.get("admin").organizationId,
    planKey: requiredString(body.planKey, "planKey"),
  })));
});

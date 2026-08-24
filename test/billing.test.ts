import type { BillingAccess, BillingRuntime } from "cf-billing";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  getBillingAccess,
  type BillingRequestCache,
} from "../src/billing/gateway";
import { validateAppConfigJson } from "../src/core/config";
import worker from "../src/index";
import { seedServerApp, serverConfig, TEST_ORGANIZATION_ID } from "./helpers";

const ORIGIN = "https://example.test";
const MANAGEMENT_HEADERS = {
  authorization: "Bearer agw_mgmt_test-admin-secret",
};

function stub(overrides: Partial<BillingRuntime> = {}): BillingRuntime {
  const inactive: BillingAccess = { status: "inactive", reason: "missing_subscription" };
  return {
    getTenantAccess: async () => inactive,
    getAccess: async () => inactive,
    listPlans: async () => ({ plans: [] }),
    createCheckout: async () => ({ url: "https://checkout.example.test" }),
    changePlan: async () => ({ ok: true }),
    resumeSubscription: async () => ({ ok: true }),
    cancelSubscription: async () => ({ ok: true }),
    startTrial: async () => inactive,
    handleLemonWebhook: async () => ({ ok: true, duplicate: false, stale: false }),
    ...overrides,
  };
}

function withBilling(binding: BillingRuntime): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "BILLING") return binding;
      return Reflect.get(target, property, receiver);
    },
  }) as Env;
}

describe("billing gateway", () => {
  it("defaults to active self-hosted access without a binding", async () => {
    await expect(getBillingAccess({}, "org-self-hosted")).resolves.toEqual({
      status: "active",
      selfHosted: true,
    });
    const capabilities = await exports.default.fetch(`${ORIGIN}/v1/console/capabilities`);
    await expect(capabilities.json()).resolves.toEqual({
      billing: false,
      registrationOpen: true,
      googleAuth: false,
    });
  });

  it("caches active and inactive access per request", async () => {
    let calls = 0;
    const access: BillingAccess = {
      status: "active",
      planKey: "pro",
      limits: { maxApps: 3 },
    };
    const binding = stub({
      getTenantAccess: async () => {
        calls += 1;
        return access;
      },
    });
    const cache: BillingRequestCache = new Map();
    await expect(getBillingAccess({ BILLING: binding }, "org-active", cache)).resolves.toEqual(access);
    await expect(getBillingAccess({ BILLING: binding }, "org-active", cache)).resolves.toEqual(access);
    expect(calls).toBe(1);

    await expect(getBillingAccess({ BILLING: stub() }, "org-inactive")).resolves.toMatchObject({
      status: "inactive",
      reason: "missing_subscription",
    });
  });

  it("uses RPC-safe billing error codes and fails closed", async () => {
    const error = new Error("service unavailable");
    error.name = "BillingHttpError:service_not_found";
    await expect(getBillingAccess({
      BILLING: stub({ getTenantAccess: async () => { throw error; } }),
    }, "org-error")).resolves.toEqual({
      status: "inactive",
      reason: "billing_unavailable",
      selfHosted: false,
      billingErrorCode: "service_not_found",
    });
  });

  it("validates configured rate, daily, and spending ceilings at the config choke point", () => {
    for (const [limits, ceilings] of [
      [{ rpm: 11 }, { maxRpm: 10 }],
      [{ rpd: 101 }, { maxRpd: 100 }],
      [{}, { maxMonthlyUsd: 5 }],
    ] as const) {
      const config = serverConfig({
        limits,
        ...(ceilings.maxMonthlyUsd === undefined ? {} : { appBudgetUsd: 6 }),
      });
      expect(() => validateAppConfigJson(config, ceilings)).toThrowError(/plan ceiling/u);
    }
  });

  it("conditionally exposes organization-scoped billing routes", async () => {
    const absent = await exports.default.fetch(`${ORIGIN}/v1/admin/billing/plans`, {
      headers: MANAGEMENT_HEADERS,
    });
    expect(absent.status).toBe(404);

    let tenantId = "";
    const billingEnv = withBilling(stub({
      getTenantAccess: async (input) => {
        tenantId = input.tenantId;
        return { status: "active", planKey: "pro" };
      },
      listPlans: async () => ({ plans: [] }),
    }));
    const capabilities = await worker.request(
      `${ORIGIN}/v1/console/capabilities`,
      undefined,
      billingEnv,
    );
    await expect(capabilities.json()).resolves.toMatchObject({ billing: true });

    const status = await worker.request(
      `${ORIGIN}/v1/admin/billing/status`,
      { headers: MANAGEMENT_HEADERS },
      billingEnv,
    );
    expect(status.status).toBe(200);
    expect(tenantId).toBe(TEST_ORGANIZATION_ID);
  });

  it("enforces app-count and config ceilings for billed organizations", async () => {
    const inactiveCreate = await worker.request(`${ORIGIN}/v1/admin/apps`, {
      method: "POST",
      headers: { ...MANAGEMENT_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ id: "billing-inactive", name: "Inactive", config: serverConfig() }),
    }, withBilling(stub()));
    expect(inactiveCreate.status).toBe(402);
    await expect(inactiveCreate.json()).resolves.toMatchObject({
      error: { code: "payment_required" },
    });

    const zeroAppEnv = withBilling(stub({
      getTenantAccess: async () => ({ status: "active", limits: { maxApps: 0 } }),
    }));
    const appLimit = await worker.request(`${ORIGIN}/v1/admin/apps`, {
      method: "POST",
      headers: { ...MANAGEMENT_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ id: "billing-app-limit", name: "Limit", config: serverConfig() }),
    }, zeroAppEnv);
    expect(appLimit.status).toBe(403);
    await expect(appLimit.json()).resolves.toMatchObject({
      error: { code: "plan_limit_exceeded" },
    });

    const rateLimitEnv = withBilling(stub({
      getTenantAccess: async () => ({ status: "active", limits: { maxRpm: 5 } }),
    }));
    const configLimit = await worker.request(`${ORIGIN}/v1/admin/apps`, {
      method: "POST",
      headers: { ...MANAGEMENT_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        id: "billing-config-limit",
        name: "Limit",
        config: serverConfig({ limits: { rpm: 6 } }),
      }),
    }, rateLimitEnv);
    expect(configLimit.status).toBe(403);
    await expect(configLimit.json()).resolves.toMatchObject({
      error: { code: "plan_limit_exceeded" },
    });

    const updateId = "billing-update-limit";
    await seedServerApp(updateId);
    const updateLimit = await worker.request(`${ORIGIN}/v1/admin/apps/${updateId}`, {
      method: "POST",
      headers: { ...MANAGEMENT_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Updated limit",
        config: serverConfig({ limits: { rpm: 6 } }),
      }),
    }, rateLimitEnv);
    expect(updateLimit.status).toBe(403);
    await expect(updateLimit.json()).resolves.toMatchObject({
      error: { code: "plan_limit_exceeded" },
    });
  });

  it("rejects the data plane with stable 402 without disabling the app", async () => {
    const appId = "billing-payment-required";
    await seedServerApp(appId);
    const response = await worker.request(
      `${ORIGIN}/v1/apps/${appId}/proxy/openai/v1/responses`,
      { method: "POST", body: JSON.stringify({ model: "gpt-5.6-terra" }) },
      withBilling(stub()),
    );
    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "payment_required" },
    });
    const row = await env.DB.prepare("SELECT status FROM apps WHERE id = ?")
      .bind(appId)
      .first<{ status: string }>();
    expect(row?.status).toBe("active");
  });
});

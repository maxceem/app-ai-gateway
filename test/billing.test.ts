import type { BillingAccess, BillingRuntime } from "cf-billing";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BILLING_ACCESS_CACHE_TTL_MS,
  billingPlanLimits,
  clearBillingAccessCache,
  getBillingAccess,
  requireActiveBilling,
  type BillingRequestCache,
  type GatewayBillingAccess,
} from "../src/billing/gateway";
import { validateAppConfigJson } from "../src/core/config";
import worker from "../src/index";
import { seedServerApp, serverConfig, TEST_ORGANIZATION_ID } from "./helpers";

const ORIGIN = "https://example.test";
const MANAGEMENT_HEADERS = {
  authorization: "Bearer agw_mgmt_test-admin-secret",
};

beforeEach(() => {
  clearBillingAccessCache();
  vi.restoreAllMocks();
});

/** No plan resolves at all: the one condition that still answers 402. */
const NO_PLAN: BillingAccess = { plan: null, subscription: null };

/** An entitled organization, on a subscription or on the service default. */
function onPlan(input: {
  planKey?: string;
  limits?: unknown;
  isDefault?: boolean;
} = {}): BillingAccess {
  const planKey = input.planKey ?? "pro";
  return {
    plan: {
      planKey,
      planName: planKey,
      limits: input.limits,
      isDefault: input.isDefault ?? false,
    },
    subscription: input.isDefault
      ? null
      : {
          status: "active",
          planKey,
          planName: planKey,
          billingPeriod: "month",
          renewsAt: null,
          endsAt: null,
          trialEndsAt: null,
          source: "lemon_squeezy",
        },
  };
}

function stub(overrides: Partial<BillingRuntime> = {}): BillingRuntime {
  return {
    getTenantAccess: async () => NO_PLAN,
    listPlans: async () => ({ plans: [] }),
    createCheckout: async () => ({ url: "https://checkout.example.test" }),
    changePlan: async () => ({ ok: true }),
    resumeSubscription: async () => ({ ok: true }),
    cancelSubscription: async () => ({ ok: true }),
    startTrial: async () => NO_PLAN,
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
  it("defaults to unlimited self-hosted access without a binding", async () => {
    await expect(getBillingAccess({}, "org-self-hosted")).resolves.toEqual({
      state: "self_hosted",
    });
    const capabilities = await exports.default.fetch(`${ORIGIN}/v1/console/capabilities`);
    await expect(capabilities.json()).resolves.toEqual({
      billing: false,
      registrationOpen: true,
      googleAuth: false,
    });
  });

  it("caches access across requests until the isolate TTL expires", async () => {
    let calls = 0;
    const access = onPlan({ limits: { maxRequestsPerMonth: 10_000 } });
    const cached = { state: "billed", ...access };
    const binding = stub({
      getTenantAccess: async () => {
        calls += 1;
        return access;
      },
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    await expect(getBillingAccess(
      { BILLING: binding },
      "org-active",
      new Map() as BillingRequestCache,
    )).resolves.toEqual(cached);
    await expect(getBillingAccess(
      { BILLING: binding },
      "org-active",
      new Map() as BillingRequestCache,
    )).resolves.toEqual(cached);
    expect(calls).toBe(1);

    now.mockReturnValue(1_000 + BILLING_ACCESS_CACHE_TTL_MS + 1);
    await expect(getBillingAccess(
      { BILLING: binding },
      "org-active",
      new Map() as BillingRequestCache,
    )).resolves.toEqual(cached);
    expect(calls).toBe(2);

    await expect(getBillingAccess({ BILLING: stub() }, "org-unentitled")).resolves.toEqual({
      state: "billed",
      plan: null,
      subscription: null,
    });
  });

  it("invalidates cached access after a billing mutation", async () => {
    let accessCalls = 0;
    const billingEnv = withBilling(stub({
      getTenantAccess: async () => {
        accessCalls += 1;
        return onPlan();
      },
    }));

    for (const expectedCalls of [1, 2]) {
      const status = await worker.request(
        `${ORIGIN}/v1/admin/billing/status`,
        { headers: MANAGEMENT_HEADERS },
        billingEnv,
      );
      expect(status.status).toBe(200);
      expect(accessCalls).toBe(expectedCalls);
      if (expectedCalls === 1) {
        const cancelled = await worker.request(
          `${ORIGIN}/v1/admin/billing/cancel`,
          { method: "POST", headers: MANAGEMENT_HEADERS },
          billingEnv,
        );
        expect(cancelled.status).toBe(200);
      }
    }
  });

  it("uses RPC-safe billing error codes and fails closed", async () => {
    const error = new Error("service unavailable");
    error.name = "BillingHttpError:service_not_found";
    let calls = 0;
    const binding = stub({
      getTenantAccess: async () => {
        calls += 1;
        if (calls === 1) throw error;
        return onPlan();
      },
    });
    await expect(getBillingAccess({ BILLING: binding }, "org-error")).resolves.toEqual({
      state: "unavailable",
      billingErrorCode: "service_not_found",
    });
    await expect(getBillingAccess({ BILLING: binding }, "org-error")).resolves.toEqual({
      state: "billed",
      ...onPlan(),
    });
    expect(calls).toBe(2);
  });

  /**
   * The plan carries one limit, spent on the data plane. Nothing about a stored
   * application configuration is a quota any more, so no plan value can refuse a
   * write — including the shapes that used to be ceilings.
   */
  it("imposes no plan ceiling on a stored application configuration", () => {
    expect(() => validateAppConfigJson(serverConfig())).not.toThrow();
    const withLegacyLimits = {
      ...serverConfig(),
      limits: {
        per_user: { requests: { per_minute: 10_000 }, spending: { monthly_usd: 10_000 } },
        per_app: { requests: { per_minute: 10_000 }, spending: { monthly_usd: 10_000 } },
      },
    };
    // A configuration written before the change still parses; the block is read
    // by nothing and does not survive the round trip.
    expect(validateAppConfigJson(withLegacyLimits)).not.toHaveProperty("limits");
  });

  const billed = (limits?: unknown) =>
    ({ state: "billed", ...onPlan({ planKey: "growth", limits }) }) as GatewayBillingAccess;

  it.each([
    ["a plain number", 10_000, 10_000],
    ["a whole float", 100_000.0, 100_000],
    ["a JSON string", "1000000", 1_000_000],
    ["zero", 0, 0],
  ])("reads maxRequestsPerMonth given as %s", (_label, value, expected) => {
    expect(billingPlanLimits(billed({ maxRequestsPerMonth: value })))
      .toEqual({ maxRequestsPerMonth: expected });
  });

  it("recognises no other plan limit", () => {
    expect(billingPlanLimits(
      billed({ maxApps: 25, maxRpm: 500, maxRpd: 10_000, maxMonthlyUsd: 250 }),
    )).toEqual({});
  });

  it.each([
    ["a fraction", 10.5],
    ["a negative", -1],
    ["a non-numeric string", "lots"],
    ["a boolean", true],
    ["null", null],
    ["an object", { value: 10 }],
    ["beyond safe integers", 1e21],
  ])("fails closed on a malformed maxRequestsPerMonth given as %s", (_label, value) => {
    expect(() => billingPlanLimits(billed({ maxRequestsPerMonth: value })))
      .toThrowError(/maxRequestsPerMonth is invalid/u);
  });

  it("fails closed when the whole limits block is malformed", () => {
    expect(() => billingPlanLimits(billed("10000")))
      .toThrowError(/Billing plan limits are invalid/u);
  });

  it("treats self-hosted, unentitled and limit-less plans as unlimited", () => {
    expect(billingPlanLimits({ state: "self_hosted" })).toEqual({});
    expect(billingPlanLimits({ state: "billed", plan: null, subscription: null })).toEqual({});
    expect(billingPlanLimits(billed())).toEqual({});
    expect(billingPlanLimits(billed({}))).toEqual({});
  });

  /**
   * The free default plan is a plan like any other: it entitles traffic and it
   * carries the allowance the gateway enforces. Nothing here may treat
   * "resolved from the service default" as "not really subscribed".
   */
  it("reads the allowance of a default plan exactly like a paid one", () => {
    const free = {
      state: "billed",
      ...onPlan({ planKey: "free", limits: { maxRequestsPerMonth: 1_000 }, isDefault: true }),
    } as GatewayBillingAccess;
    expect(billingPlanLimits(free)).toEqual({ maxRequestsPerMonth: 1_000 });
    expect(() => requireActiveBilling(free)).not.toThrow();
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
        return onPlan();
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

  /**
   * The allowance is the thing customers pay for, and nothing else reports it:
   * the count lives in a Durable Object only the dispatch path writes, and the
   * usage tables record spend rather than headroom. Without this an operator
   * first learns the month is gone from their users.
   */
  it("reports the month against the plan's allowance beside the subscription", async () => {
    const billingEnv = withBilling(stub({
      getTenantAccess: async () => onPlan({
        planKey: "growth",
        limits: { maxRequestsPerMonth: 50 },
      }),
    }));
    const quota = env.ORG_QUOTA.getByName(TEST_ORGANIZATION_ID);
    const now = Date.now();
    expect((await quota.admit({ now, limit: 50 })).allowed).toBe(true);
    expect((await quota.admit({ now, limit: 50 })).allowed).toBe(true);

    const response = await worker.request(
      `${ORIGIN}/v1/admin/billing/status`,
      { headers: MANAGEMENT_HEADERS },
      billingEnv,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access: { state: "billed", plan: { planKey: "growth", isDefault: false } },
      quota: {
        month: new Date(now).toISOString().slice(0, 7),
        used: 2,
        limit: 50,
        resetAt: expect.stringMatching(/^\d{4}-\d{2}-01T00:00:00\.000Z$/) as unknown as string,
      },
    });
  });

  /** A plan with no ceiling still reports the count; it just has nothing to be measured against. */
  it("reports a plan without a ceiling as an uncapped count", async () => {
    const billingEnv = withBilling(stub({
      getTenantAccess: async () => onPlan({ planKey: "unlimited" }),
    }));
    const response = await worker.request(
      `${ORIGIN}/v1/admin/billing/status`,
      { headers: MANAGEMENT_HEADERS },
      billingEnv,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { quota: Record<string, unknown> };
    expect(body.quota).toMatchObject({ used: expect.any(Number) as unknown as number });
    expect(body.quota).not.toHaveProperty("limit");
  });

  /**
   * A self-hosted deployment has no allowance and must never be told it has one.
   * The whole subtree is refused rather than answering with an empty reading.
   */
  it("reports no allowance where there is no billing service", async () => {
    const response = await worker.request(
      `${ORIGIN}/v1/admin/billing/status`,
      { headers: MANAGEMENT_HEADERS },
      env,
    );
    expect(response.status).toBe(404);
  });

  /**
   * `402` says the customer must pay; a billing service that cannot be reached
   * has not said anything about the customer. Answering the outage as `503`
   * is what keeps a client from showing a paying customer an upsell.
   */
  it("separates an unreachable billing service from an unpaid one", async () => {
    const appId = "billing-service-down";
    await seedServerApp(appId);
    const down = withBilling(stub({
      getTenantAccess: async () => {
        throw new Error("billing service unreachable");
      },
    }));
    const response = await worker.request(
      `${ORIGIN}/v1/apps/${appId}/proxy/openai/v1/responses`,
      { method: "POST", body: JSON.stringify({ model: "gpt-5.6-terra" }) },
      down,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "billing_unavailable" },
    });
  });

  it("refuses control-plane writes without an entitlement, and caps nothing else", async () => {
    const inactiveCreate = await worker.request(`${ORIGIN}/v1/admin/apps`, {
      method: "POST",
      headers: { ...MANAGEMENT_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ id: "billing-inactive", name: "Inactive", config: serverConfig() }),
    }, withBilling(stub()));
    expect(inactiveCreate.status).toBe(402);
    await expect(inactiveCreate.json()).resolves.toMatchObject({
      error: { code: "payment_required" },
    });
    clearBillingAccessCache();

    // A plan that used to cap applications at zero, and a request rate a plan
    // used to refuse: both are simply not quotas any more.
    const legacyCeilingEnv = withBilling(stub({
      getTenantAccess: async () => onPlan({
        limits: { maxApps: 0, maxRpm: 5, maxRpd: 10, maxMonthlyUsd: 1 },
      }),
    }));
    for (const id of ["billing-uncapped-a", "billing-uncapped-b"]) {
      const created = await worker.request(`${ORIGIN}/v1/admin/apps`, {
        method: "POST",
        headers: { ...MANAGEMENT_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ id, name: id, config: serverConfig() }),
      }, legacyCeilingEnv);
      expect(created.status).toBe(201);
    }

    const updateId = "billing-update-uncapped";
    await seedServerApp(updateId);
    const updated = await worker.request(`${ORIGIN}/v1/admin/apps/${updateId}`, {
      method: "POST",
      headers: { ...MANAGEMENT_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ name: "Updated", config: serverConfig() }),
    }, legacyCeilingEnv);
    expect(updated.status).toBe(200);
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
    const row = await env.DB.prepare("SELECT status FROM app WHERE id = ?")
      .bind(appId)
      .first<{ status: string }>();
    expect(row?.status).toBe("active");
  });
});

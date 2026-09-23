import type { BillingAccess, BillingRuntime } from "../src/billing/contract";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BILLING_ACCESS_CACHE_TTL_MS,
  BILLING_STALE_MAX_MS,
  BILLING_UNAVAILABLE_RETRY_AFTER_SECONDS,
  billingPlanLimits,
  getBillingAccess,
  requireActiveBilling,
  type BillingRequestCache,
  type GatewayBillingAccess,
} from "../src/billing/gateway";
import worker from "../src/index";
import { resolveBillingQuota } from "../src/billing/quota";
import { accountLifecycleCache } from "../src/core/account-lifecycle";
import { clearAllCaches } from "../src/core/ttl-cache";
import { resolveDeployment, type Deployment } from "../src/policy/deployment";
import {
  clearIsolateCaches,
  seedHuman,
  seedServerApp,
  serverConfig,
  TEST_ORGANIZATION_ID,
  validateConfig,
} from "./helpers";

/** Resolves a quota the way a request does: with the deployment its environment describes. */
const quotaFor = (
  quotaEnv: Env,
  ...rest: Parameters<typeof resolveBillingQuota> extends [unknown, unknown, ...infer Rest] ? Rest : never
) => resolveBillingQuota(resolveDeployment(quotaEnv), quotaEnv, ...rest);

const ORIGIN = "https://example.test";
const MANAGEMENT_HEADERS = {
  authorization: "Bearer agw_mgmt_test-admin-secret",
};

let sessionHeaders: Record<string, string> | undefined;
async function humanHeaders() {
  if (!sessionHeaders) {
    const human = await seedHuman();
    await env.DB.prepare("UPDATE mgmt_organization_user SET organization_id=? WHERE user_id=?")
      .bind(TEST_ORGANIZATION_ID, human.userId)
      .run();
    sessionHeaders = { cookie: human.cookie, "x-console-request": "1", origin: ORIGIN };
  }
  return sessionHeaders;
}

beforeEach(() => {
  sessionHeaders = undefined;
  clearIsolateCaches();
  vi.restoreAllMocks();
});

/** No plan resolves at all: the one condition that still answers 402. */
const NO_PLAN: BillingAccess = { plan: null, subscription: null };

/** An entitled organization, on a subscription or on the service default. */
function onPlan(
  input: {
    planKey?: string;
    limits?: unknown;
    isDefault?: boolean;
  } = {},
): BillingAccess {
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
          subscriptionId: "sub-billing-test",
          status: "active",
          planKey,
          planName: planKey,
          billingPeriod: "month",
          renewsAt: null,
          endsAt: null,
          trialEndsAt: null,
          source: "lemon_squeezy",
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
          billingAnchorDay: 1,
          billingAnchorAt: "2025-01-01T00:00:00.000Z",
          billingScheduleUpdatedAt: "2025-01-01T00:00:00.000Z",
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

/** A deployment with no billing service, as `resolveDeployment` reports one. */
function selfHosted(): Deployment {
  return resolveDeployment({} as Env);
}

/** A deployment whose billing service is this binding. */
function hosted(binding: BillingRuntime): Deployment {
  return resolveDeployment({ BILLING: binding } as Env);
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
    await expect(getBillingAccess(selfHosted(), "org-self-hosted")).resolves.toEqual({
      state: "self_hosted",
    });
    const capabilities = await exports.default.fetch(`${ORIGIN}/v1/console/capabilities`);
    await expect(capabilities.json()).resolves.toEqual({
      billing: false,
      registrationOpen: false,
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
    await expect(
      getBillingAccess(hosted(binding), "org-active", new Map() as BillingRequestCache),
    ).resolves.toEqual(cached);
    await expect(
      getBillingAccess(hosted(binding), "org-active", new Map() as BillingRequestCache),
    ).resolves.toEqual(cached);
    expect(calls).toBe(1);

    now.mockReturnValue(1_000 + BILLING_ACCESS_CACHE_TTL_MS + 1);
    await expect(
      getBillingAccess(hosted(binding), "org-active", new Map() as BillingRequestCache),
    ).resolves.toEqual(cached);
    expect(calls).toBe(2);

    await expect(getBillingAccess(hosted(stub()), "org-unentitled")).resolves.toEqual({
      state: "billed",
      plan: null,
      subscription: null,
    });
  });

  it("invalidates cached access after a billing mutation", async () => {
    let accessCalls = 0;
    const billingEnv = withBilling(
      stub({
        getTenantAccess: async () => {
          accessCalls += 1;
          return onPlan();
        },
      }),
    );

    for (const expectedCalls of [1, 2]) {
      const status = await worker.request(
        `${ORIGIN}/v1/admin/billing/status`,
        { headers: await humanHeaders() },
        billingEnv,
      );
      expect(status.status).toBe(200);
      expect(accessCalls).toBe(expectedCalls);
      if (expectedCalls === 1) {
        const cancelled = await worker.request(
          `${ORIGIN}/v1/admin/billing/cancel`,
          { method: "POST", headers: await humanHeaders() },
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
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    await expect(getBillingAccess(hosted(binding), "org-error")).resolves.toEqual({
      state: "unavailable",
      billingErrorCode: "service_not_found",
    });
    now.mockReturnValue(1_000 + BILLING_UNAVAILABLE_RETRY_AFTER_SECONDS * 1_000 + 1);
    await expect(getBillingAccess(hosted(binding), "org-error")).resolves.toEqual({
      state: "billed",
      ...onPlan(),
    });
    expect(calls).toBe(2);
  });

  /**
   * The plan's limit is spent on the data plane, and it is the only thing the
   * plan decides. What an organization sets on its own app's end users is the
   * organization's business: no plan value may refuse such a write, however
   * large, which is what keeps the two quota systems independent.
   */
  it("imposes no plan ceiling on an application's own limits", () => {
    expect(() => validateConfig(serverConfig())).not.toThrow();
    const generous = {
      // Per-user limits need somebody to apply to, so this app identifies its
      // users. What matters here is that no plan value refuses the numbers.
      ...serverConfig({
        authentication: {
          type: "api_key",
          end_user: { source: "header", header: "x-end-user-id" },
        },
      }),
      limits: {
        per_user: {
          requests: { per_minute: 10_000, per_day: 1_000_000 },
          spending: { monthly_usd: 10_000 },
        },
        per_app: {
          requests: { per_minute: 10_000, per_day: 1_000_000 },
          spending: { monthly_usd: 10_000 },
        },
      },
    };
    expect(validateConfig(generous)).toHaveProperty("limits");
  });

  const billed = (limits?: unknown) =>
    ({ state: "billed", ...onPlan({ planKey: "growth", limits }) }) as GatewayBillingAccess;

  it.each([
    ["a plain number", 10_000, 10_000],
    ["a whole float", 100_000.0, 100_000],
    ["a JSON string", "1000000", 1_000_000],
    ["zero", 0, 0],
  ])("reads maxRequestsPerMonth given as %s", (_label, value, expected) => {
    expect(billingPlanLimits(billed({ maxRequestsPerMonth: value }))).toEqual({
      maxRequestsPerMonth: expected,
    });
  });

  it("reads every plan limit it knows and ignores the rest", () => {
    expect(
      billingPlanLimits(billed({
        maxRequestsPerMonth: 1_000,
        maxApps: 10,
        maxProviders: "20",
        maxProviderGateways: 10,
        maxActiveKeysPerApp: 5,
        maxRpm: 500,
        maxMonthlyUsd: 250,
      })),
    ).toEqual({
      maxRequestsPerMonth: 1_000,
      maxApps: 10,
      maxProviders: 20,
      maxProviderGateways: 10,
      maxActiveKeysPerApp: 5,
    });
  });

  it("names the offending key when a configuration ceiling is malformed", () => {
    expect(() => billingPlanLimits(billed({ maxApps: -1 }))).toThrowError(
      /maxApps is invalid/u,
    );
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
    expect(() => billingPlanLimits(billed({ maxRequestsPerMonth: value }))).toThrowError(
      /maxRequestsPerMonth is invalid/u,
    );
  });

  it("fails closed when the whole limits block is malformed", () => {
    expect(() => billingPlanLimits(billed("10000"))).toThrowError(
      /Billing plan limits are invalid/u,
    );
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
      headers: await humanHeaders(),
    });
    expect(absent.status).toBe(404);

    let tenantId = "";
    const billingEnv = withBilling(
      stub({
        getTenantAccess: async (input) => {
          tenantId = input.tenantId;
          return onPlan();
        },
        listPlans: async () => ({ plans: [] }),
      }),
    );
    const capabilities = await worker.request(
      `${ORIGIN}/v1/console/capabilities`,
      undefined,
      billingEnv,
    );
    await expect(capabilities.json()).resolves.toMatchObject({ billing: true });

    const status = await worker.request(
      `${ORIGIN}/v1/admin/billing/status`,
      { headers: await humanHeaders() },
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
    const billingEnv = withBilling(
      stub({
        getTenantAccess: async () =>
          onPlan({
            planKey: "growth",
            limits: { maxRequestsPerMonth: 50 },
          }),
      }),
    );
    const quota = env.ORG_QUOTA.getByName(TEST_ORGANIZATION_ID);
    const now = Date.now();
    const resolved = await quotaFor(billingEnv, TEST_ORGANIZATION_ID, undefined, now);
    expect((await quota.admit({ limit: 50, ...resolved.period })).allowed).toBe(true);
    expect((await quota.admit({ limit: 50, ...resolved.period })).allowed).toBe(true);

    const response = await worker.request(
      `${ORIGIN}/v1/admin/billing/status`,
      { headers: await humanHeaders() },
      billingEnv,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      access: { state: "billed", plan: { planKey: "growth", isDefault: false } },
      quota: {
        periodId: resolved.period.periodId,
        periodStart: resolved.period.periodStart,
        periodEnd: resolved.period.periodEnd,
        used: 2,
        limit: 50,
        resetAt: resolved.period.resetAt,
      },
    });
  });

  /** A plan with no ceiling still reports the count; it just has nothing to be measured against. */
  it("reports a plan without a ceiling as an uncapped count", async () => {
    const billingEnv = withBilling(
      stub({
        getTenantAccess: async () => onPlan({ planKey: "unlimited" }),
      }),
    );
    const response = await worker.request(
      `${ORIGIN}/v1/admin/billing/status`,
      { headers: await humanHeaders() },
      billingEnv,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { quota: Record<string, unknown> };
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
      { headers: await humanHeaders() },
      env,
    );
    expect(response.status).toBe(404);
  });

  /**
   * `402` says the customer must pay; a billing service that cannot be reached
   * has not said anything about the customer. Answering the outage as `503`
   * is what keeps a client from showing a paying customer an upsell.
   *
   * This isolate has never read this organization, so there is no last known
   * plan to fall back on and the request waits rather than being admitted on an
   * allowance nobody knows.
   */
  it("separates an unreachable billing service from an unpaid one", async () => {
    const appId = "billing-service-down";
    const key = await seedServerApp(appId, { endUser: "none" });
    const down = withBilling(
      stub({
        getTenantAccess: async () => {
          throw new Error("billing service unreachable");
        },
      }),
    );
    const response = await worker.request(
      `${ORIGIN}/v1/apps/${appId}/proxy/openai/v1/responses`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-terra" }),
      },
      down,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "billing_unavailable" },
    });
  });

  /**
   * A billing deploy, a D1 blip or a service-binding hiccup must not become an
   * outage for every customer at once. An organization this isolate has already
   * read keeps the plan it was last given, and the fallback is announced in the
   * log so the operator sees an outage rather than silence.
   */
  it("serves the last known plan to the data plane while billing is unreachable", async () => {
    const appId = "billing-stale-serve";
    // No end users: this is about billing state, so the request carries nothing
    // but its key.
    const key = await seedServerApp(appId, { endUser: "none" });
    let failing = false;
    const billingEnv = withBilling(
      stub({
        getTenantAccess: async () => {
          if (failing) throw new Error("billing service unreachable");
          return onPlan();
        },
      }),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const contexts: ExecutionContext[] = [];
    const proxy = async (): Promise<Response> => {
      const executionCtx = createExecutionContext();
      contexts.push(executionCtx);
      const response = await worker.fetch(
        new Request(`${ORIGIN}/v1/apps/${appId}/proxy/openai/v1/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-5.6-terra", input: "hello" }),
        }),
        billingEnv,
        executionCtx,
      );
      // The usage observer rides the client's own stream, so a body nobody
      // reads leaves the pipe, and the `waitUntil` recording behind it,
      // pending. Read it here, the way a real client would take it.
      return new Response(await response.arrayBuffer(), response);
    };

    expect((await proxy()).status).toBe(200);

    // Natural cache expiry retains the last known value; explicit transition
    // invalidation deliberately clears it so revoked access cannot come back.
    const later = Date.now() + BILLING_ACCESS_CACHE_TTL_MS + 1;
    vi.spyOn(Date, "now").mockReturnValue(later);
    failing = true;
    expect((await proxy()).status).toBe(200);
    expect(
      warn.mock.calls
        .flat()
        .filter((line) => typeof line === "string" && line.includes("billing_access_stale")),
    ).toHaveLength(1);

    await Promise.all(contexts.map((ctx) => waitOnExecutionContext(ctx)));
  });

  /**
   * Stale is a bridge over an outage, not a licence. Past the window the
   * allowance is unknown again and the data plane goes back to waiting.
   */
  it("stops serving the last known plan once the stale window closes", async () => {
    let failing = false;
    const binding = stub({
      getTenantAccess: async () => {
        if (failing) throw new Error("billing service unreachable");
        return onPlan();
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    await expect(getBillingAccess(hosted(binding), "org-stale")).resolves.toEqual({
      state: "billed",
      ...onPlan(),
    });

    failing = true;
    now.mockReturnValue(1_000 + BILLING_ACCESS_CACHE_TTL_MS + 1);
    const stale = await getBillingAccess(hosted(binding), "org-stale");
    expect(stale).toEqual({ state: "billed", ...onPlan(), stale: true });
    expect(() => requireActiveBilling(stale)).not.toThrow();

    now.mockReturnValue(1_000 + BILLING_STALE_MAX_MS + 1);
    const expired = await getBillingAccess(hosted(binding), "org-stale");
    expect(expired).toEqual({ state: "unavailable" });
    expect(() => requireActiveBilling(expired)).toThrowError(/Billing could not be reached/u);
  });

  /**
   * The fallback replays the last answer, it does not improve on it: an
   * organization that had no plan is still behind the paywall during an outage.
   */
  it("still answers 402 when the last known reading was no plan", async () => {
    let failing = false;
    const binding = stub({
      getTenantAccess: async () => {
        if (failing) throw new Error("billing service unreachable");
        return NO_PLAN;
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    await getBillingAccess(hosted(binding), "org-stale-unpaid");

    failing = true;
    now.mockReturnValue(1_000 + BILLING_ACCESS_CACHE_TTL_MS + 1);
    const stale = await getBillingAccess(hosted(binding), "org-stale-unpaid");
    expect(stale).toEqual({ state: "billed", ...NO_PLAN, stale: true });
    expect(() => requireActiveBilling(stale)).toThrowError(/No plan is available/u);
  });

  /**
   * A billing service that is down must not be hammered by every request that
   * arrives while it is: the failure is held for the same interval clients are
   * told to wait, so recovery is still noticed within seconds.
   */
  it("asks a failing billing service at most once per retry interval", async () => {
    let calls = 0;
    const binding = stub({
      getTenantAccess: async () => {
        calls += 1;
        throw new Error("billing service unreachable");
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(getBillingAccess(hosted(binding), "org-flapping")).resolves.toEqual({
        state: "unavailable",
      });
    }
    expect(calls).toBe(1);

    now.mockReturnValue(1_000 + BILLING_UNAVAILABLE_RETRY_AFTER_SECONDS * 1_000 + 1);
    await expect(getBillingAccess(hosted(binding), "org-flapping")).resolves.toEqual({
      state: "unavailable",
    });
    expect(calls).toBe(2);
  });

  it("refuses control-plane writes without an entitlement, and caps only what the plan names", async () => {
    const inactiveCreate = await worker.request(
      `${ORIGIN}/v1/admin/apps`,
      {
        method: "POST",
        headers: { ...MANAGEMENT_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ name: "Inactive", config: serverConfig() }),
      },
      withBilling(stub()),
    );
    expect(inactiveCreate.status).toBe(402);
    await expect(inactiveCreate.json()).resolves.toMatchObject({
      error: { code: "billing_payment_required" },
    });
    clearAllCaches();

    // `maxApps` is a ceiling the plan names, so zero refuses every create. The
    // rest are the vocabulary of the limits an organization sets on its own
    // app's end users; a plan does not get to speak it, and they stay ignored.
    const legacyCeilingEnv = withBilling(
      stub({
        getTenantAccess: async () =>
          onPlan({
            limits: { maxApps: 0, maxRpm: 5, maxRpd: 10, maxMonthlyUsd: 1 },
          }),
      }),
    );
    const capped = await worker.request(
      `${ORIGIN}/v1/admin/apps`,
      {
        method: "POST",
        headers: { ...MANAGEMENT_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ name: "billing-capped", config: serverConfig() }),
      },
      legacyCeilingEnv,
    );
    expect(capped.status).toBe(409);
    await expect(capped.json()).resolves.toMatchObject({
      error: { code: "billing_plan_limit_reached", data: { limit: 0 } },
    });

    clearAllCaches();
    const uncappedEnv = withBilling(
      stub({ getTenantAccess: async () => onPlan({ limits: { maxRpm: 5, maxRpd: 10 } }) }),
    );
    for (const name of ["billing-uncapped-a", "billing-uncapped-b"]) {
      const created = await worker.request(
        `${ORIGIN}/v1/admin/apps`,
        {
          method: "POST",
          headers: { ...MANAGEMENT_HEADERS, "content-type": "application/json" },
          body: JSON.stringify({ name, config: serverConfig() }),
        },
        uncappedEnv,
      );
      expect(created.status).toBe(201);
    }

    const updateId = "billing-update-uncapped";
    await seedServerApp(updateId);
    const updated = await worker.request(
      `${ORIGIN}/v1/admin/apps/${updateId}`,
      {
        method: "PUT",
        headers: { ...MANAGEMENT_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ name: "Updated", config: serverConfig(), revision: 1 }),
      },
      legacyCeilingEnv,
    );
    expect(updated.status).toBe(200);
  });

  /**
   * The ceilings that replaced a set of database triggers. They are plan data
   * now, so the interesting part is that the same enforcement reads whichever
   * number the plan carries, for a resource the plan names and for no other.
   *
   * Every ceiling here is derived from what the organization already owns
   * rather than from a fixed number, so the test states the rule without
   * depending on, or disturbing, what the rest of the suite has seeded.
   */
  const ownedCount = async (table: "provider" | "provider_gateway") =>
    (await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM ${table} WHERE organization_id = ?`,
    ).bind(TEST_ORGANIZATION_ID).first<{ total: number }>())!.total;

  it("caps every resource the plan puts a ceiling on, and frees a slot when one is released", async () => {
    const appId = "billing-key-ceiling";
    await seedServerApp(appId);
    await env.DB.prepare("DELETE FROM app_api_key WHERE app_id = ?").bind(appId).run();
    const providers = await ownedCount("provider");
    const gateways = await ownedCount("provider_gateway");

    const cappedEnv = withBilling(
      stub({
        getTenantAccess: async () =>
          onPlan({
            limits: {
              maxProviders: providers + 1,
              maxProviderGateways: gateways,
              maxActiveKeysPerApp: 1,
            },
          }),
      }),
    );
    const post = (path: string, body: unknown) =>
      worker.request(
        `${ORIGIN}${path}`,
        {
          method: "POST",
          headers: { ...MANAGEMENT_HEADERS, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        cappedEnv,
      );
    const providerBody = (slug: string) => ({
      type: "openai", slug, name: slug, secret: `sk-${slug}-secret-value`,
    });

    expect((await post("/v1/admin/providers", providerBody("billing-cap-a"))).status).toBe(201);
    const refused = await post("/v1/admin/providers", providerBody("billing-cap-b"));
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      error: { code: "billing_plan_limit_reached", data: { limit: providers + 1, used: providers + 1 } },
    });

    // A ceiling already met refuses the next write outright, and it refuses the
    // resource the plan named: providers had a slot left, gateways did not.
    const gateway = await post("/v1/admin/provider-gateways", {
      type: "cf_aig", name: "Capped gateway", accountId: "acct-1", gatewayId: "gw-1",
      token: "cf-aig-token-value",
    });
    expect(gateway.status).toBe(409);
    await expect(gateway.json()).resolves.toMatchObject({
      error: { code: "billing_plan_limit_reached", data: { limit: gateways, used: gateways } },
    });

    // Keys are counted per application, so the ceiling is that app's alone.
    const first = await post(`/v1/admin/apps/${appId}/keys`, { name: "First" });
    expect(first.status).toBe(201);
    const second = await post(`/v1/admin/apps/${appId}/keys`, { name: "Second" });
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({
      error: { code: "billing_plan_limit_reached", data: { limit: 1, used: 1 } },
    });

    // Nothing resets these on a schedule; releasing what you own is the remedy,
    // and a revoked key leaves the count because only active keys are in it.
    const keyId = ((await first.json()) as { id: string }).id;
    expect((await post(`/v1/admin/apps/${appId}/keys/${keyId}/revoke`, {})).status).toBe(200);
    expect((await post(`/v1/admin/apps/${appId}/keys`, { name: "Replacement" })).status).toBe(201);

    await env.DB.prepare("DELETE FROM provider WHERE organization_id = ? AND slug = ?")
      .bind(TEST_ORGANIZATION_ID, "billing-cap-a").run();
  });

  it("refuses a capped create the same way when it arrives under an idempotency receipt", async () => {
    const providers = await ownedCount("provider");
    const cappedEnv = withBilling(
      stub({ getTenantAccess: async () => onPlan({ limits: { maxProviders: providers } }) }),
    );
    const refused = await worker.request(
      `${ORIGIN}/v1/admin/providers`,
      {
        method: "POST",
        headers: {
          ...MANAGEMENT_HEADERS,
          "content-type": "application/json",
          "Idempotency-Key": "a".repeat(40),
          "X-Idempotency-Proof": "b".repeat(40),
        },
        body: JSON.stringify({
          type: "openai", slug: "billing-cap-receipt", name: "Receipted",
          secret: "sk-receipted-value",
        }),
      },
      cappedEnv,
    );
    // The receipt guard and the ceiling both refuse by matching no rows, so
    // without the second count this would be the generic "resource changed".
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      error: { code: "billing_plan_limit_reached", data: { limit: providers, used: providers } },
    });
    // The receipt is written only alongside a write that happened, so a refused
    // create leaves no record that would make a retry replay this refusal.
    const stored = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM mgmt_resource_receipt WHERE organization_id = ?",
    ).bind(TEST_ORGANIZATION_ID).first<{ total: number }>();
    expect(stored?.total).toBe(0);
  });

  /**
   * The account's own deadline is answered before anything else a served
   * request would do.
   *
   * The gate reads the provider rows alongside the lifecycle row now, so the
   * two reads land in either order; what must not move is which of them decides.
   * An account past its recovery deadline is refused with `account_expired`,
   * and the request never reaches its key, its provider or the upstream.
   */
  it("refuses an expired account before a proxy request is authenticated", async () => {
    const organizationId = "billing-expired-account";
    const createdAt = new Date(Date.now() - 200 * 86_400_000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO mgmt_user(id, name, email, email_verified, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
      ).bind(`${organizationId}-owner`, organizationId, `${organizationId}@example.test`,
        Date.parse(createdAt), Date.parse(createdAt)),
      env.DB.prepare(
        `INSERT OR IGNORE INTO mgmt_organization(id, name, created_by_user_id, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(organizationId, organizationId, `${organizationId}-owner`, createdAt, createdAt,
        new Date(Date.now() - 1000).toISOString()),
    ]);
    const appId = "billing-expired-app";
    const key = await seedServerApp(appId, { endUser: "none", organizationId });
    accountLifecycleCache.clear();
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
    const response = await worker.request(
      `${ORIGIN}/v1/apps/${appId}/proxy/openai/v1/responses`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-terra" }),
      },
      withBilling(stub()),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "account_expired" },
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects the data plane with stable 402 without disabling the app", async () => {
    const appId = "billing-payment-required";
    const key = await seedServerApp(appId, { endUser: "none" });
    const response = await worker.request(
      `${ORIGIN}/v1/apps/${appId}/proxy/openai/v1/responses`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-terra" }),
      },
      withBilling(stub()),
    );
    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "billing_payment_required" },
    });
    const row = await env.DB.prepare("SELECT status FROM app WHERE id = ?")
      .bind(appId)
      .first<{ status: string }>();
    expect(row?.status).toBe("active");
  });
});

it("preserves paid trial eligibility after using the initial free plan", async () => {
  const headers = { ...(await humanHeaders()), "content-type": "application/json" };
  const createCheckout = vi.fn(async (_input: Parameters<BillingRuntime["createCheckout"]>[0]) => ({ url: "https://checkout.example.test" }));
  const startTrial = vi.fn(async () => NO_PLAN);
  const runtime = withBilling(stub({ createCheckout, startTrial }));
  const post = (path: string, body: object) => worker.request(`${ORIGIN}/v1/admin/billing/${path}`,
    { method: "POST", headers, body: JSON.stringify(body) }, runtime);
  expect((await post("trial", { planKey: "pro" })).status).toBe(200);
  expect(startTrial).toHaveBeenCalledTimes(1);
  expect((await post("checkout", { planKey: "pro", billingPeriod: "month", skipTrial: true })).status).toBe(200);
  expect(createCheckout.mock.calls[0]?.[0]).not.toHaveProperty("skipTrial");
  // The gateway's own free window is nothing but the account's age, so an account
  // that long ago exhausted it must still be offered an untouched paid trial.
  const created = await env.DB.prepare("SELECT created_at AS createdAt FROM mgmt_organization WHERE id=?")
    .bind(TEST_ORGANIZATION_ID).first<{ createdAt: string }>();
  await env.DB.prepare("UPDATE mgmt_organization SET created_at=? WHERE id=?")
    .bind("2020-01-01T00:00:00.000Z", TEST_ORGANIZATION_ID).run();
  try {
    const trial = await post("trial", { planKey: "pro" });
    expect(trial.status).toBe(200);
    expect(startTrial).toHaveBeenCalledTimes(2);
    expect((await post("checkout", { planKey: "pro", billingPeriod: "month", skipTrial: true })).status).toBe(200);
    expect(createCheckout.mock.calls[1]?.[0]).toEqual(createCheckout.mock.calls[0]?.[0]);
  } finally {
    await env.DB.prepare("UPDATE mgmt_organization SET created_at=? WHERE id=?")
      .bind(created!.createdAt, TEST_ORGANIZATION_ID).run();
    accountLifecycleCache.clear();
  }
});

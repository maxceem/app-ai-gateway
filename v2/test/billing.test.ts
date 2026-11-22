/**
 * Step 7b-8: the hosted billing page's operations (v1's `billing.test.ts` and
 * `plan-features.test.ts`, ported), the entitlement gate on the token
 * exchange and `/me`, and the plan and allowance `account status` shows.
 *
 * The billing service is always a fake here: nothing is bought, charged or
 * sent to a payment provider.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { clearCaches, LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement, seedHuman, seedManagementKey } from "./helpers.ts";

beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

const API = "https://gateway.test";
const CONSOLE = "https://console.gateway.test";

beforeEach(() => {
  clearCaches();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Holds the clock still at the moment the test runs, and answers the monthly
 * period the fake subscription (anchored on the 1st) is in then, so no
 * expectation depends on the day the suite runs.
 */
function frozenPeriod(): { periodStart: string; resetAt: string } {
  const now = Date.now();
  vi.useFakeTimers({ toFake: ["Date"], now });
  const at = new Date(now);
  return {
    periodStart: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString(),
    resetAt: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)).toISOString(),
  };
}

type Caller = { cookie: string } | { key: string };

async function send(caller: Caller, method: string, path: string, body?: unknown, environment: Env = env) {
  const headers = new Headers({ "content-type": "application/json" });
  if ("key" in caller) headers.set("authorization", `Bearer ${caller.key}`);
  else {
    headers.set("cookie", caller.cookie);
    headers.set("x-console-request", "1");
  }
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${API}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    environment,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, any> };
}

const SUBSCRIPTION = {
  subscriptionId: "sub_1",
  status: "active",
  planKey: "growth",
  planName: "Growth",
  billingPeriod: "month",
  renewsAt: "2027-01-01T00:00:00.000Z",
  endsAt: null,
  trialEndsAt: null,
  source: "lemon_squeezy",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  billingAnchorDay: 1,
  billingAnchorAt: "2026-11-01T00:00:00.000Z",
  billingScheduleUpdatedAt: "2026-11-01T00:00:00.000Z",
} as const;

const PLANS = [
  { planKey: "free", name: "Free", description: "To start", features: ["1,000 requests"], trialDays: 0, prices: [] },
  {
    planKey: "growth",
    name: "Growth",
    description: "For apps in production",
    features: ["100,000 requests"],
    trialDays: 14,
    prices: [{ billingPeriod: "month", priceAmountCents: 1900, priceCurrency: "USD" }],
  },
];

/** A billing service fake that records every call, answering with `access` until told otherwise. */
function billingFake(initial: { plan: unknown; subscription: unknown } | "down") {
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  const state = { access: initial, fail: null as string | null };
  const record = (method: string, input: Record<string, unknown>) => {
    calls.push({ method, input });
    if (state.fail !== null) {
      const error = new Error("refused");
      error.name = `BillingHttpError:${state.fail}`;
      throw error;
    }
  };
  const service = {
    getTenantAccess: async (input: Record<string, unknown>) => {
      calls.push({ method: "getTenantAccess", input });
      if (state.access === "down") throw new Error("billing down");
      return state.access;
    },
    listPlans: async (input: Record<string, unknown>) => (record("listPlans", input), { plans: PLANS }),
    createCheckout: async (input: Record<string, unknown>) => (record("createCheckout", input), { url: "https://checkout.example.test/c/1" }),
    changePlan: async (input: Record<string, unknown>) => (record("changePlan", input), { ok: true }),
    resumeSubscription: async (input: Record<string, unknown>) => (record("resumeSubscription", input), { ok: true, requiredActionUrl: "https://pay.example.test/confirm" }),
    cancelSubscription: async (input: Record<string, unknown>) => (record("cancelSubscription", input), { ok: true }),
    startTrial: async (input: Record<string, unknown>) => {
      record("startTrial", input);
      return { plan: { planKey: "growth", planName: "Growth", isDefault: false }, subscription: { ...SUBSCRIPTION, status: "on_trial" } };
    },
  };
  return { env: { ...env, BILLING: service } as unknown as Env, calls, state };
}

const growth = (limits: Record<string, unknown> = { maxRequestsPerMonth: 100 }) => ({
  plan: { planKey: "growth", planName: "Growth", isDefault: false, limits },
  subscription: SUBSCRIPTION,
});

async function person() {
  const human = await seedHuman();
  return { ...human, caller: { cookie: human.cookie } as const };
}

async function apiKeyApp(caller: Caller, environment: Env) {
  const created = await send(caller, "POST", "/v2/admin/apps", {
    name: "Billed",
    config: { authentication: { type: "api_key", end_user: { source: "none" } }, routing: { providers: {} } },
  }, environment);
  expect(created.status).toBe(201);
  return { id: created.body.app.id as string, key: created.body.api_key.key as string };
}

describe("billing operations", () => {
  it("answer 404 on a deployment without billing, and the session carries no plan", async () => {
    const { caller } = await person();
    for (const [method, path, body] of [
      ["GET", "/v2/admin/billing/plans"],
      ["GET", "/v2/admin/billing/status"],
      ["POST", "/v2/admin/billing/checkout", { planKey: "growth", billingPeriod: "month" }],
      ["POST", "/v2/admin/billing/change", { planKey: "growth", billingPeriod: "month" }],
      ["POST", "/v2/admin/billing/resume", { planKey: "growth", billingPeriod: "month" }],
      ["POST", "/v2/admin/billing/cancel"],
      ["POST", "/v2/admin/billing/trial", { planKey: "growth" }],
    ] as const) {
      expect(await send(caller, method, path, body), path).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    }
    const session = await send(caller, "GET", "/v2/admin/session");
    expect(session.status).toBe(200);
    expect(session.body.session).not.toHaveProperty("billing");
  });

  it("need a person in the console: a management key is refused", async () => {
    const { env: hosted } = billingFake(growth());
    const key = await seedManagementKey();
    expect(await send({ key }, "GET", "/v2/admin/billing/status", undefined, hosted)).toMatchObject({
      status: 403,
      body: { error: { code: "session_required" } },
    });
  });

  it("report the plan, its enforced limits and features, this period's allowance, and the subscription's actions", async () => {
    const { caller } = await person();
    const { env: hosted } = billingFake(growth({ maxRequestsPerMonth: "100", maxApps: 3, includes: [] }));
    const period = frozenPeriod();
    const status = await send(caller, "GET", "/v2/admin/billing/status", undefined, hosted);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      access: { state: "billed", plan: { planKey: "growth" } },
      limits: { maxRequestsPerMonth: 100, maxApps: 3 },
      features: { conversationStorage: false },
      allowance: { used: 0, limit: 100, periodStart: period.periodStart, resetAt: period.resetAt },
      actions: { cancel: true, resume: false, manual: false },
    });
    const plans = await send(caller, "GET", "/v2/admin/billing/plans", undefined, hosted);
    expect(plans).toMatchObject({ status: 200, body: { plans: [{ planKey: "free" }, { planKey: "growth" }] } });
  });

  it("report no allowance for a plan without a monthly limit, and offer resume for a cancelled subscription", async () => {
    const { caller } = await person();
    const { env: hosted } = billingFake({
      plan: { planKey: "free", planName: "Free", isDefault: true },
      subscription: { ...SUBSCRIPTION, status: "cancelled" },
    });
    const status = await send(caller, "GET", "/v2/admin/billing/status", undefined, hosted);
    expect(status.body).toMatchObject({ allowance: null, features: { conversationStorage: true }, actions: { cancel: false, resume: true } });
  });

  it("start a checkout for the account, with console return pages only, and read the plan afresh after it", async () => {
    const { caller, accountId } = await person();
    const fake = billingFake({ plan: { planKey: "free", planName: "Free", isDefault: true }, subscription: null });
    await send(caller, "GET", "/v2/admin/billing/status", undefined, fake.env);
    const checkout = await send(caller, "POST", "/v2/admin/billing/checkout", {
      planKey: "growth",
      billingPeriod: "month",
      successUrl: `${CONSOLE}/v2/billing?done=1`,
      cancelUrl: `${API}/v2/billing`,
    }, fake.env);
    expect(checkout).toMatchObject({ status: 200, body: { url: "https://checkout.example.test/c/1" } });
    expect(fake.calls.find((call) => call.method === "createCheckout")?.input).toEqual({
      serviceId: "app-ai-gateway",
      tenantId: accountId,
      planKey: "growth",
      billingPeriod: "month",
      successUrl: `${CONSOLE}/v2/billing?done=1`,
      cancelUrl: `${API}/v2/billing`,
    });
    // The checkout dropped this isolate's cached plan: the next status asks again.
    fake.state.access = growth();
    const after = await send(caller, "GET", "/v2/admin/billing/status", undefined, fake.env);
    expect(after.body).toMatchObject({ access: { plan: { planKey: "growth" } } });
    // A return page anywhere else is refused before the billing service is asked.
    const elsewhere = await send(caller, "POST", "/v2/admin/billing/checkout", {
      planKey: "growth",
      billingPeriod: "month",
      successUrl: "https://evil.example/thanks",
    }, fake.env);
    expect(elsewhere).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    expect(fake.calls.filter((call) => call.method === "createCheckout")).toHaveLength(1);
  });

  it("change, resume, cancel and start a trial for the account", async () => {
    const { caller, accountId } = await person();
    const fake = billingFake(growth());
    const selection = { planKey: "growth", billingPeriod: "month" };
    expect(await send(caller, "POST", "/v2/admin/billing/change", selection, fake.env)).toMatchObject({ status: 200, body: { ok: true } });
    expect(await send(caller, "POST", "/v2/admin/billing/resume", selection, fake.env)).toMatchObject({
      status: 200,
      body: { ok: true, requiredActionUrl: "https://pay.example.test/confirm" },
    });
    expect(await send(caller, "POST", "/v2/admin/billing/cancel", undefined, fake.env)).toMatchObject({ status: 200, body: { ok: true } });
    expect(await send(caller, "POST", "/v2/admin/billing/trial", { planKey: "growth" }, fake.env)).toMatchObject({
      status: 200,
      body: { plan: { planKey: "growth" }, subscription: { status: "on_trial" } },
    });
    for (const method of ["changePlan", "resumeSubscription", "cancelSubscription", "startTrial"]) {
      expect(fake.calls.find((call) => call.method === method)?.input, method).toMatchObject({ serviceId: "app-ai-gateway", tenantId: accountId });
    }
  });

  it("leave buying, changing and cancelling to owners and admins; a member may read", async () => {
    const { caller, accountId, userId } = await person();
    await env.DB.prepare("UPDATE mgmt_organization_user SET role = 'member' WHERE organization_id = ? AND user_id = ?").bind(accountId, userId).run();
    const fake = billingFake(growth());
    expect((await send(caller, "GET", "/v2/admin/billing/status", undefined, fake.env)).status).toBe(200);
    for (const [path, body] of [
      ["/v2/admin/billing/checkout", { planKey: "growth", billingPeriod: "month" }],
      ["/v2/admin/billing/change", { planKey: "growth", billingPeriod: "month" }],
      ["/v2/admin/billing/cancel", undefined],
      ["/v2/admin/billing/trial", { planKey: "growth" }],
    ] as const) {
      expect(await send(caller, "POST", path, body, fake.env), path).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
    }
    expect(fake.calls.filter((call) => call.method !== "getTenantAccess")).toEqual([]);
  });

  it("turn the billing service's refusals into the gateway's codes", async () => {
    const { caller } = await person();
    const fake = billingFake(growth());
    const selection = { planKey: "growth", billingPeriod: "month" };
    for (const [code, status, ours] of [
      ["billing_plan_not_found", 404, "billing_not_found"],
      ["billing_manually_managed", 403, "billing_action_forbidden"],
      ["billing_subscription_already_active", 409, "billing_conflict"],
      ["something_new", 502, "billing_unavailable"],
    ] as const) {
      fake.state.fail = code;
      expect(await send(caller, "POST", "/v2/admin/billing/change", selection, fake.env), code).toMatchObject({
        status,
        body: { error: { code: ours } },
      });
    }
  });
});

describe("the entitlement gate on the token exchange and /me", () => {
  it("refuses an account with no plan at all (402), and admits one while billing cannot be read", async () => {
    const { caller } = await person();
    const fake = billingFake(growth());
    const app = await apiKeyApp(caller, fake.env);
    const call = (method: string, path: string) => send({ key: app.key }, method, path, method === "POST" ? {} : undefined, fake.env);

    fake.state.access = { plan: null, subscription: null };
    clearCaches();
    expect(await call("GET", `/v2/apps/${app.id}/me`)).toMatchObject({ status: 402, body: { error: { code: "billing_payment_required" } } });
    expect(await call("POST", `/v2/apps/${app.id}/auth/token`)).toMatchObject({ status: 402, body: { error: { code: "billing_payment_required" } } });

    // Billing down: past the gate, to the app's own answer (this app names no end users and signs nobody in).
    fake.state.access = "down";
    clearCaches();
    expect(await call("GET", `/v2/apps/${app.id}/me`)).toMatchObject({ status: 404, body: { error: { code: "auth_method_not_supported" } } });
    expect(await call("POST", `/v2/apps/${app.id}/auth/token`)).toMatchObject({ status: 400, body: { error: { code: "auth_method_not_supported" } } });
  });
});

describe("account status", () => {
  it("shows the plan and this period's allowance on a hosted deployment, and only that it is unavailable when billing is down", async () => {
    const key = await seedManagementKey();
    const fake = billingFake(growth());
    const { resetAt } = frozenPeriod();
    const session = await send({ key }, "GET", "/v2/admin/session", undefined, fake.env);
    expect(session.body.session.billing).toEqual({ state: "billed", planName: "Growth", allowance: { used: 0, limit: 100, resetAt } });
    // `agw account status` reads it through the get_account tool, whose summary states it.
    const tool = await send({ key }, "POST", "/v2/cli/tools/get_account", {}, fake.env);
    expect(tool.status).toBe(200);
    expect(tool.body.summary).toContain("Plan: Growth. 0 of 100 requests used this period");
    fake.state.access = "down";
    clearCaches();
    const down = await send({ key }, "GET", "/v2/admin/session", undefined, fake.env);
    expect(down.status).toBe(200);
    expect(down.body.session.billing).toEqual({ state: "unavailable", planName: null, allowance: null });
  });
});

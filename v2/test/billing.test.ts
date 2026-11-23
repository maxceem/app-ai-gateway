/**
 * Step 7b-8: the hosted billing page's operations (v1's `billing.test.ts` and
 * `plan-features.test.ts`, ported), the token exchange and `/me` left free of
 * billing, and the plan and allowance `account status` shows.
 *
 * The billing service is always a fake here: nothing is bought, charged or
 * sent to a payment provider.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { getAppTrafficBillingAccess, getBillingAccess } from "../src/billing/access.ts";
import { readCatalog } from "../src/admin/billing.ts";
import type { BillingRuntime } from "../src/billing/contract.ts";
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
function billingFake(initial: { plan: unknown; subscription: unknown } | "down" | "stalled") {
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  const state = {
    access: initial,
    fail: null as string | null,
    /** What createCheckout waits for before answering; unset answers at once. */
    checkoutGate: null as Promise<void> | null,
    checkoutUrl: "https://checkout.example.test/c/1",
    actionUrl: "https://pay.example.test/confirm",
  };
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
      if (state.access === "stalled") return new Promise(() => undefined);
      if (state.access === "down") throw new Error("billing down");
      return state.access;
    },
    listPlans: async (input: Record<string, unknown>) => (record("listPlans", input), { plans: PLANS }),
    createCheckout: async (input: Record<string, unknown>) => {
      record("createCheckout", input);
      if (state.checkoutGate) await state.checkoutGate;
      return { url: state.checkoutUrl };
    },
    changePlan: async (input: Record<string, unknown>) => (record("changePlan", input), { ok: true }),
    resumeSubscription: async (input: Record<string, unknown>) => (record("resumeSubscription", input), { ok: true, requiredActionUrl: state.actionUrl }),
    cancelSubscription: async (input: Record<string, unknown>) => (record("cancelSubscription", input), { ok: true }),
    startTrial: async (input: Record<string, unknown>) => {
      record("startTrial", input);
      return { plan: { planKey: "growth", planName: "Growth", isDefault: false }, subscription: { ...SUBSCRIPTION, status: "on_trial" } };
    },
  };
  // The fake's pages are on example.test, the only payment host these tests allow.
  return { env: { ...env, BILLING: service, BILLING_PAYMENT_HOSTS: "example.test" } as unknown as Env, calls, state };
}

/** The subscription as the console showed it: the fake's own. */
const SHOWN = { subscriptionId: "sub_1", subscriptionStatus: "active", subscriptionPeriod: "month" } as const;
/** The price the console showed for growth, monthly: the fake catalog's. */
const SHOWN_PRICE = { priceAmountCents: 1900, priceCurrency: "USD" } as const;

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
      ["POST", "/v2/admin/billing/change", { planKey: "growth", billingPeriod: "month", subscriptionId: null }],
      ["POST", "/v2/admin/billing/resume", { planKey: "growth", billingPeriod: "month", subscriptionId: null }],
      ["POST", "/v2/admin/billing/cancel", { subscriptionId: null }],
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

  it("start a checkout for the account, returning to the console's own pages whatever the caller sends, and read the plan afresh after it", async () => {
    const { caller, accountId } = await person();
    const fake = billingFake({ plan: { planKey: "free", planName: "Free", isDefault: true }, subscription: null });
    const checkout = await send(caller, "POST", "/v2/admin/billing/checkout", {
      planKey: "growth",
      billingPeriod: "month",
      accountId,
      // Ignored: the gateway picks the return pages (Sol 7b-8).
      successUrl: "https://evil.example/thanks",
    }, fake.env);
    expect(checkout).toMatchObject({ status: 200, body: { url: "https://checkout.example.test/c/1" } });
    expect(fake.calls.find((call) => call.method === "createCheckout")?.input).toEqual({
      serviceId: "app-ai-gateway",
      tenantId: accountId,
      planKey: "growth",
      billingPeriod: "month",
      successUrl: `${CONSOLE}/v2/apps?checkout=success&plan=growth&account=${encodeURIComponent(accountId)}`,
      cancelUrl: `${CONSOLE}/v2/billing`,
    });
    // The status reads the billing service every time: the plan bought shows at once.
    fake.state.access = growth();
    const after = await send(caller, "GET", "/v2/admin/billing/status", undefined, fake.env);
    expect(after.body).toMatchObject({ access: { plan: { planKey: "growth" } } });
  });

  it("leave each checkout to the billing service: the gateway holds no reservation of its own (Sol 7b-8)", async () => {
    const { caller } = await person();
    const fake = billingFake({ plan: { planKey: "free", planName: "Free", isDefault: true }, subscription: null });
    const body = { planKey: "growth", billingPeriod: "month" };
    expect(await send(caller, "POST", "/v2/admin/billing/checkout", body, fake.env)).toMatchObject({ status: 200 });
    // A refusal from the billing service leaves nothing behind: the next one is asked again.
    fake.state.fail = "billing_subscription_already_active";
    expect(await send(caller, "POST", "/v2/admin/billing/checkout", body, fake.env)).toMatchObject({ status: 409, body: { error: { code: "billing_conflict" } } });
    fake.state.fail = null;
    expect(await send(caller, "POST", "/v2/admin/billing/checkout", body, fake.env)).toMatchObject({ status: 200 });
    expect(fake.calls.filter((call) => call.method === "createCheckout")).toHaveLength(3);
  });

  it("pass on a payment page only on an HTTPS payment host (Sol 7b-8)", async () => {
    const { caller } = await person();
    const fake = billingFake({ plan: { planKey: "free", planName: "Free", isDefault: true }, subscription: null });
    fake.state.checkoutUrl = "https://evil.example/pay";
    expect(await send(caller, "POST", "/v2/admin/billing/checkout", { planKey: "growth", billingPeriod: "month" }, fake.env)).toMatchObject({
      status: 502,
      body: { error: { code: "billing_unavailable" } },
    });
    const paid = billingFake(growth());
    paid.state.actionUrl = "http://pay.example.test/confirm";
    expect(await send(caller, "POST", "/v2/admin/billing/resume", { planKey: "growth", billingPeriod: "month", ...SHOWN }, paid.env)).toMatchObject({
      status: 502,
      body: { error: { code: "billing_unavailable" } },
    });
  });

  it("refuse a write on a subscription whose id, status or period changed since the dialog opened (Sol 7b-8)", async () => {
    const { caller } = await person();
    const fake = billingFake(growth());
    const selection = { planKey: "growth", billingPeriod: "month" };
    // Shown a different subscription, or the same one in another status or period: each is refused.
    for (const shown of [
      { ...SHOWN, subscriptionId: "sub_old" },
      { ...SHOWN, subscriptionStatus: "cancelled" },
      { ...SHOWN, subscriptionPeriod: "year" },
      { subscriptionId: null, subscriptionStatus: null, subscriptionPeriod: null },
    ] as const) {
      for (const [path, body] of [
        ["/v2/admin/billing/change", { ...selection, ...shown, price: SHOWN_PRICE }],
        ["/v2/admin/billing/resume", { ...selection, ...shown }],
        ["/v2/admin/billing/cancel", { ...shown }],
      ] as const) {
        expect(await send(caller, "POST", path, body, fake.env), `${path} ${JSON.stringify(shown)}`).toMatchObject({
          status: 409,
          body: { error: { code: "subscription_changed" } },
        });
      }
    }
    expect(fake.calls.filter((call) => call.method !== "getTenantAccess")).toEqual([]);
    // A subscription that cannot be read to check it answers 503, and nothing is asked of billing.
    fake.state.access = "down";
    expect(await send(caller, "POST", "/v2/admin/billing/cancel", { ...SHOWN }, fake.env)).toMatchObject({
      status: 503,
      body: { error: { code: "billing_unavailable" } },
    });
    expect(fake.calls.filter((call) => call.method !== "getTenantAccess")).toEqual([]);
  });

  it("refuse a write on a subscription changed in place since the dialog opened, as its updatedAt shows (Sol 7b-8)", async () => {
    const { caller } = await person();
    // The subscription moved to another plan: the same id, status and period, a later updatedAt.
    const fake = billingFake({ ...growth(), subscription: { ...SUBSCRIPTION, planKey: "pro", planName: "Pro", updatedAt: "2026-11-20T00:00:00.000Z" } });
    const selection = { planKey: "growth", billingPeriod: "month" };
    const shown = { ...SHOWN, subscriptionUpdatedAt: SUBSCRIPTION.updatedAt };
    for (const [path, body] of [
      ["/v2/admin/billing/change", { ...selection, ...shown, price: SHOWN_PRICE }],
      ["/v2/admin/billing/resume", { ...selection, ...shown }],
      ["/v2/admin/billing/cancel", { ...shown }],
    ] as const) {
      expect(await send(caller, "POST", path, body, fake.env), path).toMatchObject({ status: 409, body: { error: { code: "subscription_changed" } } });
    }
    expect(fake.calls.filter((call) => call.method !== "getTenantAccess")).toEqual([]);
    // Shown as it is now, the write goes ahead; a client that sends no updatedAt is checked on the rest.
    expect(await send(caller, "POST", "/v2/admin/billing/cancel", { ...SHOWN, subscriptionUpdatedAt: "2026-11-20T00:00:00.000Z" }, fake.env)).toMatchObject({ status: 200 });
    expect(await send(caller, "POST", "/v2/admin/billing/cancel", { ...SHOWN }, fake.env)).toMatchObject({ status: 200 });
  });

  it("answer billing_unavailable when the plans on offer cannot be read in time (Sol 7b-8)", async () => {
    const stalled = { listPlans: () => new Promise(() => undefined) } as unknown as BillingRuntime;
    await expect(readCatalog(stalled, 20)).rejects.toMatchObject({ status: 502, code: "billing_unavailable" });
  });

  it("change, resume, cancel and start a trial for the account", async () => {
    const { caller, accountId } = await person();
    const fake = billingFake(growth());
    const selection = { planKey: "growth", billingPeriod: "month", ...SHOWN };
    expect(await send(caller, "POST", "/v2/admin/billing/change", { ...selection, price: SHOWN_PRICE }, fake.env)).toMatchObject({ status: 200, body: { ok: true } });
    expect(await send(caller, "POST", "/v2/admin/billing/resume", selection, fake.env)).toMatchObject({
      status: 200,
      body: { ok: true, requiredActionUrl: "https://pay.example.test/confirm" },
    });
    expect(await send(caller, "POST", "/v2/admin/billing/cancel", { ...SHOWN }, fake.env)).toMatchObject({ status: 200, body: { ok: true } });
    expect(await send(caller, "POST", "/v2/admin/billing/trial", { planKey: "growth" }, fake.env)).toMatchObject({
      status: 200,
      body: { plan: { planKey: "growth" }, subscription: { status: "on_trial" } },
    });
    for (const method of ["changePlan", "resumeSubscription", "cancelSubscription", "startTrial"]) {
      expect(fake.calls.find((call) => call.method === method)?.input, method).toMatchObject({ serviceId: "app-ai-gateway", tenantId: accountId });
    }
  });

  it("refuse a change whose price moved since it was shown, before asking billing to change anything (Sol 7b-8)", async () => {
    const { caller } = await person();
    const fake = billingFake(growth());
    const selection = { planKey: "growth", billingPeriod: "month", ...SHOWN };
    for (const price of [{ priceAmountCents: 1500, priceCurrency: "USD" }, { priceAmountCents: 1900, priceCurrency: "EUR" }]) {
      expect(await send(caller, "POST", "/v2/admin/billing/change", { ...selection, price }, fake.env), JSON.stringify(price)).toMatchObject({
        status: 409,
        body: { error: { code: "price_changed" } },
      });
    }
    // A period the catalog does not sell is the billing service's not-found.
    expect(await send(caller, "POST", "/v2/admin/billing/change", { ...selection, billingPeriod: "year", price: SHOWN_PRICE }, fake.env)).toMatchObject({
      status: 404,
      body: { error: { code: "billing_not_found" } },
    });
    expect(fake.calls.some((call) => call.method === "changePlan")).toBe(false);
  });

  it("leave buying, changing and cancelling to owners and admins; a member may read", async () => {
    const { caller, accountId, userId } = await person();
    await env.DB.prepare("UPDATE mgmt_organization_user SET role = 'member' WHERE organization_id = ? AND user_id = ?").bind(accountId, userId).run();
    const fake = billingFake(growth());
    expect((await send(caller, "GET", "/v2/admin/billing/status", undefined, fake.env)).status).toBe(200);
    for (const [path, body] of [
      ["/v2/admin/billing/checkout", { planKey: "growth", billingPeriod: "month" }],
      ["/v2/admin/billing/change", { planKey: "growth", billingPeriod: "month", ...SHOWN, price: SHOWN_PRICE }],
      ["/v2/admin/billing/cancel", { ...SHOWN }],
      ["/v2/admin/billing/trial", { planKey: "growth" }],
    ] as const) {
      expect(await send(caller, "POST", path, body, fake.env), path).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
    }
    expect(fake.calls.filter((call) => call.method !== "getTenantAccess")).toEqual([]);
  });

  it("turn the billing service's refusals into the gateway's codes", async () => {
    const { caller } = await person();
    const fake = billingFake(growth());
    const selection = { planKey: "growth", billingPeriod: "month", ...SHOWN, price: SHOWN_PRICE };
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

describe("the token exchange and /me, left free of billing (Sol 7b-8)", () => {
  it("never ask billing: an account with no plan is served as before, and a billing service that never answers holds nothing up", async () => {
    const { caller } = await person();
    const fake = billingFake(growth());
    const app = await apiKeyApp(caller, fake.env);
    const call = (method: string, path: string) => send({ key: app.key }, method, path, method === "POST" ? {} : undefined, fake.env);
    for (const access of [{ plan: null, subscription: null }, "stalled"] as const) {
      fake.state.access = access;
      clearCaches();
      fake.calls.length = 0;
      // Straight to the app's own answer (this app names no end users and signs nobody in):
      // a billing read that never resolves would hang these calls if either awaited it.
      expect(await call("GET", `/v2/apps/${app.id}/me`)).toMatchObject({ status: 404, body: { error: { code: "auth_method_not_supported" } } });
      expect(await call("POST", `/v2/apps/${app.id}/auth/token`)).toMatchObject({ status: 400, body: { error: { code: "auth_method_not_supported" } } });
      expect(fake.calls.filter((entry) => entry.method === "getTenantAccess")).toEqual([]);
    }
  });
});

describe("the billing page's allowance", () => {
  it("shows no figure, and still loads, when the account's limiter cannot answer (Sol 7b-8)", async () => {
    const { caller } = await person();
    const fake = billingFake(growth());
    const failing = {
      ...fake.env,
      ACCOUNT_LIMITER: { getByName: () => ({ usage: async () => { throw new Error("limiter down"); } }) },
    } as unknown as Env;
    const status = await send(caller, "GET", "/v2/admin/billing/status", undefined, failing);
    expect(status).toMatchObject({ status: 200, body: { access: { plan: { planKey: "growth" } }, allowance: null } });
  });
});

describe("the console's own billing read, apart from app traffic's (Sol 7b-8)", () => {
  /** The fake's `getTenantAccess`, to hold its answers back. */
  function tenantAccess(fake: ReturnType<typeof billingFake>) {
    return (fake.env as unknown as { BILLING: { getTenantAccess: (input: Record<string, unknown>) => Promise<unknown> } }).BILLING;
  }
  const asked = (fake: ReturnType<typeof billingFake>) => fake.calls.filter((call) => call.method === "getTenantAccess").length;

  it("never takes away the plan app traffic falls back on while billing cannot answer", async () => {
    const { caller, accountId } = await person();
    const fake = billingFake(growth());
    const waitUntil = () => undefined;
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now });
    // App traffic has read the plan.
    expect(await getAppTrafficBillingAccess(fake.env, accountId, waitUntil)).toMatchObject({ state: "billed", plan: { planKey: "growth" } });
    // Billing goes down; the console starts a checkout, and the billing page says billing is unavailable.
    fake.state.access = "down";
    await send(caller, "POST", "/v2/admin/billing/checkout", { planKey: "growth", billingPeriod: "month" }, fake.env);
    expect(await send(caller, "GET", "/v2/admin/billing/status", undefined, fake.env)).toMatchObject({
      status: 503,
      body: { error: { code: "billing_unavailable" } },
    });
    // Once the isolate's cached reading has expired, app traffic still has its known plan, marked stale.
    vi.setSystemTime(now + 31_000);
    expect(await getAppTrafficBillingAccess(fake.env, accountId, waitUntil)).toMatchObject({ state: "billed", stale: true, plan: { planKey: "growth" } });
  });

  it("asks billing every time, but not again within 5 s of a failed read", async () => {
    const { caller } = await person();
    const fake = billingFake(growth());
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now });
    expect(await send(caller, "GET", "/v2/admin/billing/status", undefined, fake.env)).toMatchObject({ status: 200 });
    expect(await send(caller, "GET", "/v2/admin/billing/status", undefined, fake.env)).toMatchObject({ status: 200 });
    expect(asked(fake)).toBe(2);
    fake.state.access = "down";
    expect((await send(caller, "GET", "/v2/admin/billing/status", undefined, fake.env)).status).toBe(503);
    // Within the 5 s, billing is not asked again: the page answers 503 at once.
    fake.state.access = growth();
    const failed = await send(caller, "GET", "/v2/admin/billing/status", undefined, fake.env);
    expect(failed).toMatchObject({ status: 503, body: { error: { code: "billing_unavailable" } } });
    expect(asked(fake)).toBe(3);
    vi.setSystemTime(now + 6_000);
    expect(await send(caller, "GET", "/v2/admin/billing/status", undefined, fake.env)).toMatchObject({ status: 200, body: { access: { plan: { planKey: "growth" } } } });
    expect(asked(fake)).toBe(4);
  });

  it("drops a read that answers too late: it never shows up in a later read, the console's or app traffic's", async () => {
    const { caller, accountId } = await person();
    const fake = billingFake({ plan: { planKey: "free", planName: "Free", isDefault: true }, subscription: null });
    const service = tenantAccess(fake);
    const original = service.getTenantAccess;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    service.getTenantAccess = async (input) => {
      const answer = await original(input);
      await gate;
      return answer;
    };
    // The console's read is held past its 1 s deadline.
    expect((await send(caller, "GET", "/v2/admin/billing/status", undefined, fake.env)).status).toBe(503);
    // Its old answer arrives late, after the plan has changed.
    service.getTenantAccess = original;
    fake.state.access = growth();
    release();
    await gate;
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: now + 6_000 });
    expect(await send(caller, "GET", "/v2/admin/billing/status", undefined, fake.env)).toMatchObject({ status: 200, body: { access: { plan: { planKey: "growth" } } } });
    expect(await getAppTrafficBillingAccess(fake.env, accountId, () => undefined)).toMatchObject({ plan: { planKey: "growth" } });
  });
});

describe("app traffic's plan cache across a change the account makes (Sol 7b-8)", () => {
  it("never keeps the old plan from a read that began before the change and finished after it", async () => {
    const { caller, accountId } = await person();
    const fake = billingFake({ plan: { planKey: "free", planName: "Free", isDefault: true }, subscription: null });
    const service = (fake.env as unknown as { BILLING: { getTenantAccess: (input: Record<string, unknown>) => Promise<unknown> } }).BILLING;
    const original = service.getTenantAccess;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    service.getTenantAccess = async (input) => {
      const answer = await original(input);
      await gate;
      return answer;
    };
    // App traffic starts reading the free plan, and is held.
    const before = getAppTrafficBillingAccess(fake.env, accountId, () => undefined, 60_000);
    // Meanwhile the account buys growth.
    service.getTenantAccess = original;
    expect((await send(caller, "POST", "/v2/admin/billing/checkout", { planKey: "growth", billingPeriod: "month" }, fake.env)).status).toBe(200);
    fake.state.access = growth();
    release();
    expect(await before).toMatchObject({ plan: { planKey: "free" } });
    // The next read asks billing again rather than serving the old answer from the cache.
    expect(await getAppTrafficBillingAccess(fake.env, accountId, () => undefined)).toMatchObject({ plan: { planKey: "growth" } });
    // And the old plan was never kept to fall back on: with billing down and the cache expired,
    // app traffic falls back on growth, read after the change.
    fake.state.access = "down";
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 31_000 });
    expect(await getAppTrafficBillingAccess(fake.env, accountId, () => undefined)).toMatchObject({ stale: true, plan: { planKey: "growth" } });
  });

  it("does not keep the old plan to fall back on when nothing read after the change", async () => {
    const { caller, accountId } = await person();
    const fake = billingFake({ plan: { planKey: "free", planName: "Free", isDefault: true }, subscription: null });
    const service = (fake.env as unknown as { BILLING: { getTenantAccess: (input: Record<string, unknown>) => Promise<unknown> } }).BILLING;
    const original = service.getTenantAccess;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    service.getTenantAccess = async (input) => {
      const answer = await original(input);
      await gate;
      return answer;
    };
    const before = getAppTrafficBillingAccess(fake.env, accountId, () => undefined, 60_000);
    service.getTenantAccess = original;
    expect((await send(caller, "POST", "/v2/admin/billing/checkout", { planKey: "growth", billingPeriod: "month" }, fake.env)).status).toBe(200);
    release();
    await before;
    fake.state.access = "down";
    expect(await getAppTrafficBillingAccess(fake.env, accountId, () => undefined)).toMatchObject({ state: "unavailable" });
  });
});

describe("the last known plan (Sol 7b-8)", () => {
  it("is never overwritten by an older read that a newer one replaced", async () => {
    const { accountId } = await person();
    const fake = billingFake({ plan: { planKey: "free", planName: "Free", isDefault: true }, subscription: null });
    const service = (fake.env as unknown as { BILLING: { getTenantAccess: (input: Record<string, unknown>) => Promise<unknown> } }).BILLING;
    const original = service.getTenantAccess;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    service.getTenantAccess = async (input) => {
      const answer = await original(input);
      await gate;
      return answer;
    };
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now });
    // An old read of the free plan is held.
    const older = getBillingAccess(fake.env, accountId);
    // Once the cache's 30 s are up, a newer read replaces it and answers growth.
    service.getTenantAccess = original;
    fake.state.access = growth();
    vi.setSystemTime(now + 31_000);
    expect(await getBillingAccess(fake.env, accountId)).toMatchObject({ plan: { planKey: "growth" } });
    // The older read lands last.
    release();
    expect(await older).toMatchObject({ plan: { planKey: "free" } });
    // With billing down and the cache expired, app traffic falls back on growth, not free.
    fake.state.access = "down";
    vi.setSystemTime(now + 70_000);
    expect(await getAppTrafficBillingAccess(fake.env, accountId, () => undefined)).toMatchObject({ stale: true, plan: { planKey: "growth" } });
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

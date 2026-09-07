import type { BillingAccess, BillingRuntime } from "../src/billing/contract";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { clearBillingAccessCache } from "../src/billing/gateway";
import { clearAppConfigCache } from "../src/core/config";
import { seedProvider, seedServerApp } from "./helpers";

/**
 * The limits an organization sets on its own application, applied to that
 * application's end users.
 *
 * The thing under test here is mostly the *boundary* with the other quota: that
 * these are decided first, that refusing by them spends none of the plan
 * allowance the organization is billed for, and that an app which sets none of
 * them costs exactly what it cost before the feature existed.
 */

const ORIGIN = "https://example.test";
const contexts: ExecutionContext[] = [];

async function seedOrganization(id: string): Promise<void> {
  const userId = `${id}-owner`;
  const now = new Date();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO console_user(id, name, email, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).bind(userId, `${id} owner`, `${id}@example.test`, now.getTime(), now.getTime()),
    env.DB.prepare(
      `INSERT OR IGNORE INTO console_organization(id, name, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(id, id, userId, now.toISOString(), now.toISOString()),
    env.DB.prepare(
      `INSERT OR IGNORE INTO console_organization_user(id, organization_id, user_id, role, status, joined_at)
       VALUES (?, ?, ?, 'owner', 'active', ?)`,
    ).bind(`${id}-membership`, id, userId, now.toISOString()),
  ]);
  await seedProvider({ type: "openai", organizationId: id });
}

function billingStub(limits: unknown): BillingRuntime {
  const access: BillingAccess = {
    plan: { planKey: "growth", planName: "Growth", limits, isDefault: false },
    subscription: {
      status: "active",
      planKey: "growth",
      planName: "Growth",
      billingPeriod: "month",
      renewsAt: null,
      endsAt: null,
      trialEndsAt: null,
      source: "lemon_squeezy",
    },
  };
  return {
    getTenantAccess: async () => access,
    listPlans: async () => ({ plans: [] }),
    createCheckout: async () => ({ url: "https://checkout.example.test" }),
    changePlan: async () => ({ ok: true }),
    resumeSubscription: async () => ({ ok: true }),
    cancelSubscription: async () => ({ ok: true }),
    startTrial: async () => ({ plan: null, subscription: null }),
    handleLemonWebhook: async () => ({ ok: true, duplicate: false, stale: false }),
  };
}

function hosted(limits: unknown): Env {
  const binding = billingStub(limits);
  return new Proxy(env, {
    get: (target, property, receiver) =>
      property === "BILLING" ? binding : Reflect.get(target, property, receiver),
  }) as Env;
}

async function proxyRequest(input: {
  appId: string;
  key: string;
  env?: Env;
  userId?: string;
}): Promise<Response> {
  const executionCtx = createExecutionContext();
  contexts.push(executionCtx);
  const response = await worker.fetch(
    new Request(`${ORIGIN}/v1/apps/${input.appId}/proxy/openai/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.key}`,
        "content-type": "application/json",
        "x-end-user-id": input.userId ?? "limits-user",
      },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
    }),
    input.env ?? env,
    executionCtx,
  );
  return new Response(await response.arrayBuffer(), response);
}

async function settle(): Promise<void> {
  await Promise.all(contexts.splice(0).map((ctx) => waitOnExecutionContext(ctx)));
}

const used = (organizationId: string): Promise<number> =>
  env.ORG_QUOTA.getByName(organizationId).usage(Date.now()).then((usage) => usage.used);

function mockUpstream(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }),
  );
}

beforeEach(() => {
  clearBillingAccessCache();
  clearAppConfigCache();
});

afterEach(async () => {
  await settle();
  vi.restoreAllMocks();
});

describe("an application's own limits", () => {
  it("refuses over the per-user rate with app_rate_limited and a user scope", async () => {
    const key = await seedServerApp("limits-user-rpm", { limits: { rpm: 1 } });
    mockUpstream();

    expect((await proxyRequest({ appId: "limits-user-rpm", key })).status).toBe(200);
    const refused = await proxyRequest({ appId: "limits-user-rpm", key });

    expect(refused.status).toBe(429);
    const body = await refused.json<{ error: { code: string; data?: { scope: string } } }>();
    expect(body.error.code).toBe("app_rate_limited");
    expect(body.error.data?.scope).toBe("user");
    // Something to retry after, and never longer than the window it names.
    const retryAfter = Number(refused.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("scopes the per-user limit to one user, not to the app", async () => {
    const key = await seedServerApp("limits-user-scope", { limits: { rpm: 1 } });
    mockUpstream();

    expect((await proxyRequest({ appId: "limits-user-scope", key, userId: "a" })).status).toBe(200);
    expect((await proxyRequest({ appId: "limits-user-scope", key, userId: "a" })).status).toBe(429);
    // A second user has their own window and is untouched by the first's.
    expect((await proxyRequest({ appId: "limits-user-scope", key, userId: "b" })).status).toBe(200);
  });

  it("refuses over the app-wide rate with an app scope, whoever is calling", async () => {
    const key = await seedServerApp("limits-app-rpm", { limits: { app_rpm: 1 } });
    mockUpstream();

    expect((await proxyRequest({ appId: "limits-app-rpm", key, userId: "a" })).status).toBe(200);
    const refused = await proxyRequest({ appId: "limits-app-rpm", key, userId: "b" });

    expect(refused.status).toBe(429);
    const body = await refused.json<{ error: { code: string; data?: { scope: string } } }>();
    expect(body.error.code).toBe("app_rate_limited");
    expect(body.error.data?.scope).toBe("app");
  });

  /**
   * The ordering the whole feature turns on. A request the organization's own
   * limits refused must not consume the allowance the organization is billed
   * for: charging a customer for traffic they themselves rejected would be
   * indefensible, and is what putting the allowance last prevents.
   */
  it("spends none of the plan allowance on a request its own limits refused", async () => {
    const organizationId = "limits-before-quota-org";
    await seedOrganization(organizationId);
    const key = await seedServerApp("limits-before-quota", {
      organizationId,
      limits: { rpm: 1 },
    });
    const billing = hosted({ maxRequestsPerMonth: 100 });
    mockUpstream();

    expect((await proxyRequest({ appId: "limits-before-quota", key, env: billing })).status).toBe(200);
    expect(await used(organizationId)).toBe(1);

    expect((await proxyRequest({ appId: "limits-before-quota", key, env: billing })).status).toBe(429);
    // Still one: the second request never reached the allowance at all.
    expect(await used(organizationId)).toBe(1);
  });

  it("still refuses on the plan allowance for a request inside its own limits", async () => {
    const organizationId = "quota-after-limits-org";
    await seedOrganization(organizationId);
    const key = await seedServerApp("quota-after-limits", {
      organizationId,
      limits: { rpm: 100 },
    });
    const billing = hosted({ maxRequestsPerMonth: 1 });
    mockUpstream();

    expect((await proxyRequest({ appId: "quota-after-limits", key, env: billing })).status).toBe(200);
    const refused = await proxyRequest({ appId: "quota-after-limits", key, env: billing });

    expect(refused.status).toBe(429);
    expect((await refused.json<{ error: { code: string } }>()).error.code)
      .toBe("billing_request_quota_exceeded");
  });

  it("records the refusal under the status naming the app, not the plan", async () => {
    const key = await seedServerApp("limits-event", { limits: { rpm: 1 } });
    mockUpstream();

    expect((await proxyRequest({ appId: "limits-event", key })).status).toBe(200);
    expect((await proxyRequest({ appId: "limits-event", key })).status).toBe(429);
    await settle();

    const row = await env.DB.prepare(
      `SELECT status, model, cost_usd FROM app_usage_event
        WHERE app_id = ? AND status LIKE 'blocked_%'`,
    ).bind("limits-event").first<{ status: string; model: string; cost_usd: number }>();
    expect(row).toEqual({ status: "blocked_app_rate", model: "gpt-5.6-sol", cost_usd: 0 });
  });

  /**
   * A blocked user is answered before any limit is consulted, so their attempts
   * cannot exhaust the app-wide window and lock out everybody else. That is the
   * whole reason the cached block flag stays first and unconditional.
   */
  it("spends no app-wide rate token on a blocked user's attempt", async () => {
    const key = await seedServerApp("limits-blocked-first", { limits: { app_rpm: 1 } });
    await env.DB.prepare("INSERT INTO app_user(app_id, id) VALUES (?, ?)")
      .bind("limits-blocked-first", "banned")
      .run();
    await env.USER_LIMITER.getByName("limits-blocked-first:banned").setBlocked(true);
    mockUpstream();

    const blocked = await proxyRequest({ appId: "limits-blocked-first", key, userId: "banned" });
    expect(blocked.status).toBe(403);

    // The app's one-per-minute window is still whole for everybody else.
    expect((await proxyRequest({ appId: "limits-blocked-first", key, userId: "ok" })).status).toBe(200);
  });

  /**
   * Ordering within the app's own limits. One caller over their own limit must
   * not drain the window every other user shares — that would let a single
   * misbehaving client deny the app to everybody, which is the opposite of what
   * a per-user limit is for.
   */
  it("spends no app-wide token on a request the per-user limit refused", async () => {
    const key = await seedServerApp("limits-scope-order", {
      limits: { rpm: 1, app_rpm: 2 },
    });
    mockUpstream();

    expect((await proxyRequest({ appId: "limits-scope-order", key, userId: "greedy" })).status)
      .toBe(200);
    // Refused on their own limit, twice. Neither attempt may touch the app-wide
    // window, which still has one of its two tokens left.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const refused = await proxyRequest({ appId: "limits-scope-order", key, userId: "greedy" });
      expect(refused.status).toBe(429);
      expect((await refused.json<{ error: { data?: { scope: string } } }>()).error.data?.scope)
        .toBe("user");
    }

    expect((await proxyRequest({ appId: "limits-scope-order", key, userId: "polite" })).status)
      .toBe(200);
  });

  /**
   * The counter is only kept while a per-user limit is set, because an app with
   * none never reaches the limiter. Reporting the resulting zero as a day's
   * traffic would be a lie, so it reads as unknown.
   */
  it("reports an uncounted day as null rather than as zero", async () => {
    const key = await seedServerApp("limits-me-uncounted");
    mockUpstream();

    expect((await proxyRequest({ appId: "limits-me-uncounted", key, userId: "u" })).status).toBe(200);
    await settle();

    const executionCtx = createExecutionContext();
    contexts.push(executionCtx);
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v1/apps/limits-me-uncounted/me`, {
        headers: { authorization: `Bearer ${key}`, "x-end-user-id": "u" },
      }),
      env,
      executionCtx,
    );

    const body = await response.json<{ limits: { requests_today: number | null } }>();
    expect(body.limits.requests_today).toBeNull();
  });

  /**
   * The fast path. An app that configures no limits must make exactly the
   * Durable Object calls it made before this feature existed: the cached block
   * flag, and nothing else.
   */
  it("calls no limiter at all for an app that configures no limits", async () => {
    let checks = 0;
    const limiter = new Proxy(env.USER_LIMITER, {
      get: (target, property) => {
        if (property !== "getByName") return Reflect.get(target, property);
        return (name: string) => {
          const stub = target.getByName(name);
          return new Proxy(stub, {
            get: (stubTarget, stubProperty) =>
              stubProperty === "checkAndIncrement"
                ? (...args: unknown[]) => {
                    checks += 1;
                    return (stubTarget.checkAndIncrement as (...a: unknown[]) => unknown)(...args);
                  }
                : Reflect.get(stubTarget, stubProperty),
          });
        };
      },
    });
    const counted = new Proxy(env, {
      get: (target, property, receiver) =>
        property === "USER_LIMITER" ? limiter : Reflect.get(target, property, receiver),
    }) as Env;

    const key = await seedServerApp("limits-none");
    mockUpstream();

    expect((await proxyRequest({ appId: "limits-none", key, env: counted })).status).toBe(200);
    expect(checks).toBe(0);
  });

  it("consults only the scope that is configured", async () => {
    const names: string[] = [];
    const limiter = new Proxy(env.USER_LIMITER, {
      get: (target, property) => {
        if (property !== "getByName") return Reflect.get(target, property);
        return (name: string) => {
          const stub = target.getByName(name);
          return new Proxy(stub, {
            get: (stubTarget, stubProperty) =>
              stubProperty === "checkAndIncrement"
                ? (...args: unknown[]) => {
                    names.push(name);
                    return (stubTarget.checkAndIncrement as (...a: unknown[]) => unknown)(...args);
                  }
                : Reflect.get(stubTarget, stubProperty),
          });
        };
      },
    });
    const counted = new Proxy(env, {
      get: (target, property, receiver) =>
        property === "USER_LIMITER" ? limiter : Reflect.get(target, property, receiver),
    }) as Env;

    const key = await seedServerApp("limits-user-only", { limits: { rpm: 5 } });
    mockUpstream();

    expect((await proxyRequest({ appId: "limits-user-only", key, env: counted, userId: "u" })).status)
      .toBe(200);
    // The per-user object only; the app-wide one is never addressed.
    expect(names).toEqual(["limits-user-only:u"]);
  });

  it("refuses once a settled month's spend passes the budget", async () => {
    const key = await seedServerApp("limits-budget", { budgetUsd: 0.000001 });
    mockUpstream();

    // The first request is admitted on a budget nothing has been spent against
    // yet, and its cost settles behind it.
    expect((await proxyRequest({ appId: "limits-budget", key, userId: "spender" })).status).toBe(200);
    await settle();

    const refused = await proxyRequest({ appId: "limits-budget", key, userId: "spender" });
    expect(refused.status).toBe(429);
    const body = await refused.json<{ error: { code: string; data?: { scope: string } } }>();
    expect(body.error.code).toBe("app_budget_exhausted");
    expect(body.error.data?.scope).toBe("user");
    // No instant of its own to name, so it points at the month it is measured over.
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  /**
   * The end user's own view of the policy that applies to them. The plan
   * allowance is deliberately not here: it is the organization's arrangement
   * with the gateway, not its users' business.
   */
  it("reports the caller's own limits and standing on /me", async () => {
    const key = await seedServerApp("limits-me", { limits: { rpm: 10, rpd: 4 }, budgetUsd: 2 });
    mockUpstream();

    expect((await proxyRequest({ appId: "limits-me", key, userId: "me-user" })).status).toBe(200);
    await settle();

    const executionCtx = createExecutionContext();
    contexts.push(executionCtx);
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v1/apps/limits-me/me`, {
        headers: { authorization: `Bearer ${key}`, "x-end-user-id": "me-user" },
      }),
      env,
      executionCtx,
    );
    expect(response.status).toBe(200);

    const body = await response.json<{
      user_id: string;
      limits: Record<string, unknown>;
    }>();
    expect(body.user_id).toBe("me-user");
    expect(body.limits).toMatchObject({
      requests_today: 1,
      requests_remaining: 3,
      requests_per_minute: 10,
      requests_per_day: 4,
      monthly_budget_usd: 2,
      blocked: false,
    });
    // Nothing about the organization's plan allowance leaks into a user's own
    // view: no limit, no used, no resetAt.
    expect(Object.keys(body.limits).sort()).toEqual([
      "blocked",
      "monthly_budget_usd",
      "monthly_cost_usd",
      "requests_per_day",
      "requests_per_minute",
      "requests_remaining",
      "requests_today",
    ]);
  });

  it("settles one event against both ledgers when the app keeps an app-wide one", async () => {
    const key = await seedServerApp("limits-both-ledgers", { appBudgetUsd: 100 });
    mockUpstream();

    expect((await proxyRequest({ appId: "limits-both-ledgers", key, userId: "u" })).status).toBe(200);
    await settle();

    const perUser = await env.USER_LIMITER
      .getByName("limits-both-ledgers:u")
      .getStatus(Date.now());
    const perApp = await env.USER_LIMITER.getByName("limits-both-ledgers").getStatus(Date.now());
    expect(perUser.monthlyCostMicrousd).toBeGreaterThan(0);
    expect(perApp.monthlyCostMicrousd).toBe(perUser.monthlyCostMicrousd);
  });
});

import type { BillingAccess, BillingRuntime } from "cf-billing";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { clearBillingAccessCache } from "../src/billing/gateway";
import { clearAppConfigCache } from "../src/core/config";
import { seedProvider, seedServerApp } from "./helpers";

const ORIGIN = "https://example.test";

/**
 * The organization-wide allowance is keyed by organization, so every case needs
 * its own tenant or it would be spending a neighbour's month.
 */
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

/** An entitled organization on a paid plan carrying `limits`. */
function onPlan(limits?: unknown): BillingAccess {
  return {
    plan: {
      planKey: "growth",
      planName: "Growth",
      limits,
      isDefault: false,
    },
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
}

/** No plan resolves at all: the only remaining reason to answer 402. */
const NO_PLAN: BillingAccess = { plan: null, subscription: null };

function billingStub(access: () => BillingAccess | Promise<BillingAccess>): BillingRuntime {
  return {
    getTenantAccess: async () => access(),
    listPlans: async () => ({ plans: [] }),
    createCheckout: async () => ({ url: "https://checkout.example.test" }),
    changePlan: async () => ({ ok: true }),
    resumeSubscription: async () => ({ ok: true }),
    cancelSubscription: async () => ({ ok: true }),
    startTrial: async () => NO_PLAN,
    handleLemonWebhook: async () => ({ ok: true, duplicate: false, stale: false }),
  };
}

/** A hosted deployment: the same bindings, plus a billing service. */
function hosted(limits: unknown): Env {
  const binding = billingStub(() => onPlan(limits));
  return new Proxy(env, {
    get: (target, property, receiver) =>
      property === "BILLING" ? binding : Reflect.get(target, property, receiver),
  }) as Env;
}

const contexts: ExecutionContext[] = [];

async function proxyRequest(input: {
  appId: string;
  key: string;
  env?: Env;
  userId?: string;
  body?: Record<string, unknown>;
}): Promise<Response> {
  const executionCtx = createExecutionContext();
  contexts.push(executionCtx);
  return worker.fetch(
    new Request(`${ORIGIN}/v1/apps/${input.appId}/proxy/openai/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.key}`,
        "content-type": "application/json",
        "x-end-user-id": input.userId ?? "quota-user",
      },
      body: JSON.stringify(input.body ?? { model: "gpt-5.6-sol", input: "hello" }),
    }),
    input.env ?? env,
    executionCtx,
  );
}

async function settle(): Promise<void> {
  await Promise.all(contexts.splice(0).map((ctx) => waitOnExecutionContext(ctx)));
}

function used(organizationId: string): Promise<number> {
  return env.ORG_QUOTA.getByName(organizationId).usage(Date.now()).then((usage) => usage.used);
}

function mockUpstream(responder: (attempt: number) => Response | Promise<Response>): void {
  let attempt = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => responder(attempt++));
}

const ok = () => Response.json({ usage: { input_tokens: 1, output_tokens: 1 } });

beforeEach(() => {
  clearBillingAccessCache();
  clearAppConfigCache();
});

afterEach(async () => {
  await settle();
  vi.restoreAllMocks();
});

describe("organization monthly request quota", () => {
  it("shares one allowance across every app and user in the organization", async () => {
    const organizationId = "quota-shared-org";
    await seedOrganization(organizationId);
    const first = await seedServerApp("quota-shared-a", { organizationId });
    const second = await seedServerApp("quota-shared-b", { organizationId });
    const billing = hosted({ maxRequestsPerMonth: 3 });
    mockUpstream(ok);

    expect((await proxyRequest({ appId: "quota-shared-a", key: first, env: billing, userId: "u1" })).status).toBe(200);
    expect((await proxyRequest({ appId: "quota-shared-b", key: second, env: billing, userId: "u2" })).status).toBe(200);
    expect((await proxyRequest({ appId: "quota-shared-a", key: first, env: billing, userId: "u3" })).status).toBe(200);
    expect(await used(organizationId)).toBe(3);

    const refused = await proxyRequest({
      appId: "quota-shared-b",
      key: second,
      env: billing,
      userId: "u4",
    });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = await refused.json<{ error: { code: string; data: Record<string, unknown> } }>();
    expect(body.error.code).toBe("monthly_request_quota_exceeded");
    expect(body.error.data).toEqual({
      limit: 3,
      used: 3,
      resetAt: expect.stringMatching(/^\d{4}-\d{2}-01T00:00:00\.000Z$/u),
    });
    // The reset instant is the start of the next UTC month, exactly.
    const resetAt = new Date(body.error.data.resetAt as string);
    const now = new Date();
    expect(resetAt.getTime()).toBe(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    );
    // A refused request never reaches a provider and never spends the allowance
    // it was refused by.
    expect(await used(organizationId)).toBe(3);
  });

  it("leaves a self-hosted deployment unlimited and touches no quota object", async () => {
    const organizationId = "quota-self-hosted-org";
    await seedOrganization(organizationId);
    const key = await seedServerApp("quota-self-hosted", { organizationId });
    mockUpstream(ok);

    for (let index = 0; index < 5; index += 1) {
      expect((await proxyRequest({ appId: "quota-self-hosted", key })).status).toBe(200);
    }
    // No BILLING binding means no allowance to spend, and nothing recorded.
    expect(await used(organizationId)).toBe(0);
  });

  it("leaves a billed organization whose plan states no allowance unlimited", async () => {
    const organizationId = "quota-no-limit-org";
    await seedOrganization(organizationId);
    const key = await seedServerApp("quota-no-limit", { organizationId });
    const billing = hosted(undefined);
    mockUpstream(ok);

    for (let index = 0; index < 4; index += 1) {
      expect((await proxyRequest({ appId: "quota-no-limit", key, env: billing })).status).toBe(200);
    }
    expect(await used(organizationId)).toBe(0);
  });

  it("counts a request whose provider then fails", async () => {
    const organizationId = "quota-upstream-fail-org";
    await seedOrganization(organizationId);
    const key = await seedServerApp("quota-upstream-fail", { organizationId });
    const billing = hosted({ maxRequestsPerMonth: 5 });
    mockUpstream(() => Response.json({ error: "boom" }, { status: 500 }));

    const response = await proxyRequest({ appId: "quota-upstream-fail", key, env: billing });
    expect(response.status).toBe(500);
    await response.text();
    // Admission is the boundary; what the provider then did with the request is
    // not a reason to hand the allowance back.
    expect(await used(organizationId)).toBe(1);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const failed = await proxyRequest({ appId: "quota-upstream-fail", key, env: billing });
    expect(failed.status).toBe(502);
    expect(await used(organizationId)).toBe(2);
  });

  it.each([
    {
      label: "a rejected credential",
      key: "agw_not-a-real-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      body: { model: "gpt-5.6-sol", input: "hello" },
      status: 401,
    },
    {
      label: "a disallowed model",
      body: { model: "gpt-not-allowed", input: "hello" },
      status: 403,
    },
  ])("does not spend the allowance on $label", async ({ label, key, body, status }) => {
    const organizationId = `quota-predispatch-${label.replace(/\W+/gu, "-")}`;
    await seedOrganization(organizationId);
    const appKey = await seedServerApp(`app-${organizationId}`, {
      organizationId,
      proxy: {
        openai: { allowed_paths: ["v1/responses"], allowed_models: ["gpt-5.6-sol"] },
      },
    });
    const billing = hosted({ maxRequestsPerMonth: 10 });
    mockUpstream(ok);

    const response = await proxyRequest({
      appId: `app-${organizationId}`,
      key: key ?? appKey,
      env: billing,
      body,
    });
    expect(response.status).toBe(status);
    expect(await used(organizationId)).toBe(0);
  });

  it("does not spend the allowance on a malformed body or an unconfigured provider", async () => {
    const organizationId = "quota-malformed-org";
    await seedOrganization(organizationId);
    const key = await seedServerApp("quota-malformed", { organizationId });
    const billing = hosted({ maxRequestsPerMonth: 10 });
    mockUpstream(ok);

    const executionCtx = createExecutionContext();
    contexts.push(executionCtx);
    const malformed = await worker.fetch(
      new Request(`${ORIGIN}/v1/apps/quota-malformed/proxy/openai/v1/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "x-end-user-id": "quota-user",
        },
        body: "{",
      }),
      billing,
      executionCtx,
    );
    expect(malformed.status).toBe(400);

    const unconfigured = createExecutionContext();
    contexts.push(unconfigured);
    const missing = await worker.fetch(
      new Request(`${ORIGIN}/v1/apps/quota-malformed/proxy/anthropic/v1/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "x-end-user-id": "quota-user",
        },
        body: JSON.stringify({ model: "claude-sonnet-5", messages: [], max_tokens: 8 }),
      }),
      billing,
      unconfigured,
    );
    expect(missing.status).toBe(502);
    expect(await used(organizationId)).toBe(0);
  });

  it("does not spend the allowance on a billing rejection", async () => {
    const organizationId = "quota-unpaid-org";
    await seedOrganization(organizationId);
    const key = await seedServerApp("quota-unpaid", { organizationId });
    const binding = billingStub(() => NO_PLAN);
    const billing = new Proxy(env, {
      get: (target, property, receiver) =>
        property === "BILLING" ? binding : Reflect.get(target, property, receiver),
    }) as Env;
    mockUpstream(ok);

    const response = await proxyRequest({ appId: "quota-unpaid", key, env: billing });
    expect(response.status).toBe(402);
    expect(await used(organizationId)).toBe(0);
  });

  /**
   * The distinction the data plane turns on: an organization with no plan at
   * all has to go and pay, and one whose billing service is down has to
   * wait. Answering the second with the first tells every paying customer they
   * are unsubscribed for the length of an outage, and clients are built to treat
   * `402` as final.
   */
  it("refuses a billing outage as retryable, and recovers on the next request", async () => {
    const organizationId = "quota-billing-down-org";
    await seedOrganization(organizationId);
    const key = await seedServerApp("quota-billing-down", { organizationId });
    let calls = 0;
    const binding = billingStub(() => {
      calls += 1;
      if (calls === 1) throw new Error("billing service unreachable");
      return onPlan({ maxRequestsPerMonth: 5 });
    });
    const billing = new Proxy(env, {
      get: (target, property, receiver) =>
        property === "BILLING" ? binding : Reflect.get(target, property, receiver),
    }) as Env;
    const upstream = vi.fn(async () => ok());
    vi.spyOn(globalThis, "fetch").mockImplementation(upstream);

    const refused = await proxyRequest({ appId: "quota-billing-down", key, env: billing });
    expect(refused.status).toBe(503);
    await expect(refused.json()).resolves.toMatchObject({
      error: { code: "billing_unavailable" },
    });
    expect(refused.headers.get("retry-after")).toBe("5");
    expect(upstream).not.toHaveBeenCalled();
    expect(await used(organizationId)).toBe(0);

    // The failed lookup must not be held for the cache TTL, or the advertised
    // retry would replay the same failure rather than reach billing again.
    const admitted = await proxyRequest({ appId: "quota-billing-down", key, env: billing });
    expect(admitted.status).toBe(200);
    expect(await used(organizationId)).toBe(1);
    expect(calls).toBe(2);
  });

  /**
   * A plan the organization has outgrown mid-month — downgraded, or shrunk on
   * the billing side — is not a state the counter can undo. It reports what was
   * spent, which is more than is now allowed, and admits nothing further.
   */
  it("refuses a month already past a newly lowered allowance", async () => {
    const organizationId = "quota-downgrade-org";
    await seedOrganization(organizationId);
    const quota = env.ORG_QUOTA.getByName(organizationId);
    const now = Date.now();
    for (let request = 0; request < 3; request += 1) {
      expect((await quota.admit({ now, limit: 10 })).allowed).toBe(true);
    }

    const refused = await quota.admit({ now, limit: 2 });
    expect(refused).toMatchObject({ allowed: false, limit: 2, used: 3 });
    expect(await used(organizationId)).toBe(3);
  });

  it("refuses without dispatching when the plan's allowance is malformed", async () => {
    const organizationId = "quota-malformed-plan-org";
    await seedOrganization(organizationId);
    const key = await seedServerApp("quota-malformed-plan", { organizationId });
    const billing = hosted({ maxRequestsPerMonth: "unlimited" });
    const upstream = vi.fn(async () => ok());
    vi.spyOn(globalThis, "fetch").mockImplementation(upstream);

    const response = await proxyRequest({ appId: "quota-malformed-plan", key, env: billing });
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "billing_unavailable" },
    });
    expect(upstream).not.toHaveBeenCalled();
    expect(await used(organizationId)).toBe(0);
  });

  it("refuses a blocked user before the allowance is spent", async () => {
    const organizationId = "quota-blocked-org";
    await seedOrganization(organizationId);
    const key = await seedServerApp("quota-blocked", { organizationId });
    const billing = hosted({ maxRequestsPerMonth: 10 });
    mockUpstream(ok);
    await env.USER_LIMITER.getByName("quota-blocked:blocked-user").setBlocked(true);

    const refused = await proxyRequest({
      appId: "quota-blocked",
      key,
      env: billing,
      userId: "blocked-user",
    });
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "auth_required" } });
    expect(await used(organizationId)).toBe(0);

    // Everyone else still gets served out of the untouched allowance.
    expect((await proxyRequest({
      appId: "quota-blocked",
      key,
      env: billing,
      userId: "allowed-user",
    })).status).toBe(200);
    expect(await used(organizationId)).toBe(1);
  });

  it("spends one request for a named endpoint however many targets it tries", async () => {
    const organizationId = "quota-fallback-org";
    await seedOrganization(organizationId);
    await seedProvider({
      type: "openai",
      organizationId,
      slug: "openai-backup",
      id: `provider-${organizationId}-backup`,
    });
    const key = await seedServerApp("quota-fallback", {
      organizationId,
      endpoints: {
        chat: {
          api_style: "responses",
          provider: "openai",
          model: "gpt-5.6-luna",
          fallback: [{ provider: "openai-backup", model: "gpt-5.6-luna" }],
        },
      },
    });
    const billing = hosted({ maxRequestsPerMonth: 10 });
    // The primary answers with a retryable status, so the chain moves on; both
    // attempts belong to one incoming gateway request.
    const attempts: number[] = [];
    let attempt = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      attempts.push(attempt);
      return attempt++ === 0 ? Response.json({ error: "busy" }, { status: 503 }) : ok();
    });

    const executionCtx = createExecutionContext();
    contexts.push(executionCtx);
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v1/apps/quota-fallback/endpoints/chat`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "x-end-user-id": "quota-user",
        },
        body: JSON.stringify({ input: "hello" }),
      }),
      billing,
      executionCtx,
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(attempts).toHaveLength(2);
    expect(await used(organizationId)).toBe(1);
  });

  it("records the refusal as a blocked usage event", async () => {
    const organizationId = "quota-event-org";
    await seedOrganization(organizationId);
    const key = await seedServerApp("quota-event", { organizationId });
    const billing = hosted({ maxRequestsPerMonth: 1 });
    mockUpstream(ok);

    expect((await proxyRequest({ appId: "quota-event", key, env: billing })).status).toBe(200);
    expect((await proxyRequest({ appId: "quota-event", key, env: billing })).status).toBe(429);
    await settle();

    for (let poll = 0; poll < 40; poll += 1) {
      const row = await env.DB.prepare(
        `SELECT model, route, cost_usd, input_tokens FROM app_usage_event
          WHERE app_id = ? AND status = 'blocked_rate'`,
      ).bind("quota-event").first<{
        model: string;
        route: string;
        cost_usd: number;
        input_tokens: number;
      }>();
      if (row) {
        expect(row).toEqual({
          model: "gpt-5.6-sol",
          route: "openai/v1/responses",
          cost_usd: 0,
          input_tokens: 0,
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("The refused request was not recorded as a blocked usage event");
  });
});

import type { BillingAccess, BillingRuntime } from "../src/billing/contract";
import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { billingQuota, type BillingQuota } from "../src/billing/quota";
import { BILLING_UNAVAILABLE_RETRY_AFTER_SECONDS, requireActiveBilling } from "../src/billing/gateway";
import { clearIsolateCaches, seedProvider, seedServerApp } from "./helpers";
import { resolveDeployment } from "../src/policy/deployment";
import { appUserBlocked, blockedUserCache, cachedAppUserBlocked, invalidateBlockedCache } from "../src/client-auth/user-status";

/** Resolves a metered quota the way admission does: with the deployment its environment describes. */
async function meteredFor(
  quotaEnv: Env,
  ...rest: Parameters<typeof billingQuota> extends [unknown, unknown, ...infer Rest] ? Rest : never
): Promise<Extract<BillingQuota, { kind: "metered" }>> {
  const quota = await billingQuota(resolveDeployment(quotaEnv), quotaEnv, ...rest);
  requireActiveBilling(quota.access);
  if (quota.kind !== "metered") throw new Error("Expected a metered quota");
  return quota;
}

const ORIGIN = "https://example.test";

async function blockUser(appId: string, userId: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO app_user(app_id, id, status) VALUES (?, ?, 'blocked') " +
    "ON CONFLICT(app_id, id) DO UPDATE SET status = 'blocked'",
  ).bind(appId, userId).run();
}

/**
 * The organization-wide allowance is keyed by organization, so every case needs
 * its own tenant or it would be spending a neighbour's month.
 */
async function seedOrganization(id: string): Promise<void> {
  const userId = `${id}-owner`;
  const now = new Date();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO mgmt_user(id, name, email, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).bind(userId, `${id} owner`, `${id}@example.test`, now.getTime(), now.getTime()),
    env.DB.prepare(
      `INSERT OR IGNORE INTO mgmt_organization(id, name, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(id, id, userId, now.toISOString(), now.toISOString()),
    env.DB.prepare(
      `INSERT OR IGNORE INTO mgmt_organization_user(id, organization_id, user_id, role, status, joined_at)
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
      subscriptionId: "sub-quota-gate",
      status: "active",
      planKey: "growth",
      planName: "Growth",
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
  const response = await worker.fetch(
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
  // The usage observer rides the client's own stream, so a body nobody reads
  // leaves the pipe, and the `waitUntil` recording behind it, pending. Read it
  // here and hand it back whole, the way a real client would take it.
  return new Response(await response.arrayBuffer(), response);
}

async function settle(): Promise<void> {
  await Promise.all(contexts.splice(0).map((ctx) => waitOnExecutionContext(ctx)));
}

function used(organizationId: string): Promise<number> {
  const quota = env.ORG_QUOTA.getByName(organizationId);
  return runInDurableObject(quota, (_instance, state) => state.storage.sql
    .exec<{ used: number }>("SELECT COALESCE(SUM(used), 0) AS used FROM allowance")
    .one().used);
}

function mockUpstream(responder: (attempt: number) => Response | Promise<Response>): void {
  let attempt = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => responder(attempt++));
}

const ok = () => Response.json({ usage: { input_tokens: 1, output_tokens: 1 } });

beforeEach(() => {
  clearIsolateCaches();
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
    expect(body.error.code).toBe("billing_request_quota_exceeded");
    expect(body.error.data).toEqual({
      limit: 3,
      used: 3,
      periodId: expect.stringMatching(/^(free|paid):.+Z:.+Z$/u),
      periodStart: expect.stringMatching(/Z$/u),
      periodEnd: expect.stringMatching(/Z$/u),
      resetAt: expect.stringMatching(/Z$/u),
    });
    expect(body.error.data.resetAt).toBe(body.error.data.periodEnd);
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
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);

    const refused = await proxyRequest({ appId: "quota-billing-down", key, env: billing });
    expect(refused.status).toBe(503);
    await expect(refused.json()).resolves.toMatchObject({
      error: { code: "billing_unavailable" },
    });
    expect(refused.headers.get("retry-after")).toBe("5");
    expect(upstream).not.toHaveBeenCalled();
    expect(await used(organizationId)).toBe(0);

    // The failed lookup is held for exactly the interval the client was told to
    // wait — not the full cache TTL — so the advertised retry reaches billing
    // again rather than replaying the same failure.
    clock.mockReturnValue(start + BILLING_UNAVAILABLE_RETRY_AFTER_SECONDS * 1_000 + 1);
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
    const resolved = await meteredFor(
      hosted({ maxRequestsPerMonth: 10 }),
      organizationId,
      undefined,
      now,
    );
    for (let request = 0; request < 3; request += 1) {
      expect((await quota.admit({ limit: 10, ...resolved.period })).allowed).toBe(true);
    }

    const refused = await quota.admit({ limit: 2, ...resolved.period });
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
    await blockUser("quota-blocked", "blocked-user");

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

  /**
   * The gate reads the block flag and the allowance concurrently, so which of
   * the two answers first must not decide the response. Being blocked is a fact
   * about the user; it does not depend on what the organization may spend, and
   * a billing failure must not turn a blocked user into a retryable error.
   */
  it("answers a blocked user as blocked even when the allowance cannot be read", async () => {
    const organizationId = "quota-blocked-billing-org";
    await seedOrganization(organizationId);
    const key = await seedServerApp("quota-blocked-billing", { organizationId });
    // A plan that exists — so the entitlement gate admits the request — but
    // whose allowance the gate's own lookup refuses to resolve.
    const billing = hosted({ maxRequestsPerMonth: "unlimited" });
    const upstream = vi.fn(async () => ok());
    vi.spyOn(globalThis, "fetch").mockImplementation(upstream);
    await blockUser("quota-blocked-billing", "blocked-user");

    const refused = await proxyRequest({
      appId: "quota-blocked-billing",
      key,
      env: billing,
      userId: "blocked-user",
    });
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "auth_required" } });

    // Everyone else on the same organization gets the billing failure itself.
    const unavailable = await proxyRequest({
      appId: "quota-blocked-billing",
      key,
      env: billing,
      userId: "allowed-user",
    });
    expect(unavailable.status).toBe(502);
    await expect(unavailable.json()).resolves.toMatchObject({
      error: { code: "billing_unavailable" },
    });
    expect(upstream).not.toHaveBeenCalled();
    expect(await used(organizationId)).toBe(0);
  });

  /**
   * The same pair when billing cannot be reached at all. The allowance then
   * resolves as `unmetered`, and it is admission's own `requireActiveBilling`
   * that refuses — still only after the block has been answered.
   */
  it("answers a blocked user as blocked even when billing is unreachable", async () => {
    const organizationId = "quota-blocked-outage-org";
    await seedOrganization(organizationId);
    const key = await seedServerApp("quota-blocked-outage", { organizationId });
    const binding = billingStub(() => {
      throw new Error("billing service unreachable");
    });
    const billing = new Proxy(env, {
      get: (target, property, receiver) =>
        property === "BILLING" ? binding : Reflect.get(target, property, receiver),
    }) as Env;
    const upstream = vi.fn(async () => ok());
    vi.spyOn(globalThis, "fetch").mockImplementation(upstream);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await blockUser("quota-blocked-outage", "blocked-user");

    const refused = await proxyRequest({
      appId: "quota-blocked-outage",
      key,
      env: billing,
      userId: "blocked-user",
    });
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "auth_required" } });

    const unavailable = await proxyRequest({
      appId: "quota-blocked-outage",
      key,
      env: billing,
      userId: "allowed-user",
    });
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({
      error: { code: "billing_unavailable" },
    });
    expect(upstream).not.toHaveBeenCalled();
    expect(await used(organizationId)).toBe(0);
  });

  it("spends one request for a custom endpoint however many targets it tries", async () => {
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

  it("records the refusal as a rejection sample", async () => {
    const organizationId = "quota-event-org";
    await seedOrganization(organizationId);
    const key = await seedServerApp("quota-event", { organizationId });
    const billing = hosted({ maxRequestsPerMonth: 1 });
    mockUpstream(ok);

    expect((await proxyRequest({ appId: "quota-event", key, env: billing })).status).toBe(200);
    expect((await proxyRequest({ appId: "quota-event", key, env: billing })).status).toBe(429);
    await settle();

    const row = await env.DB.prepare(
      `SELECT model, route, reason, scope FROM app_rejection_event
        WHERE app_id = ? AND reason = 'blocked_billing'`,
    ).bind("quota-event").first<{
      model: string;
      route: string;
      reason: string;
      scope: string;
    }>();
    expect(row).toEqual({
      model: "gpt-5.6-sol",
      route: "openai/v1/responses",
      reason: "blocked_billing",
      scope: "account",
    });
  });
});

/** Controlled D1 reads expose races that a fast local database would conceal. */
function pendingStatusDb() {
  type Row = { status: "active" | "blocked" } | null;
  const reads: { resolve: (row: Row) => void; reject: (reason: Error) => void }[] = [];
  const db = {
    prepare: () => ({
      bind: () => ({
        first: () => new Promise<Row>((resolve, reject) => reads.push({ resolve, reject })),
      }),
    }),
  } as unknown as D1Database;
  return { db, reads };
}

describe("D1 user status cache", () => {
  it("treats a missing row as unblocked and shares concurrent reads", async () => {
    const { db, reads } = pendingStatusDb();
    const first = cachedAppUserBlocked(db, "cache-missing", "user");
    const second = cachedAppUserBlocked(db, "cache-missing", "user");
    expect(second).toBe(first);
    expect(reads).toHaveLength(1);
    reads[0]!.resolve(null);
    await expect(first).resolves.toBe(false);
    await expect(cachedAppUserBlocked(db, "cache-missing", "user")).resolves.toBe(false);
    expect(reads).toHaveLength(1);
  });

  it("does not put an invalidated in-flight read back in the cache", async () => {
    const { db, reads } = pendingStatusDb();
    const old = cachedAppUserBlocked(db, "cache-invalidate", "user");
    invalidateBlockedCache("cache-invalidate", "user");
    const current = cachedAppUserBlocked(db, "cache-invalidate", "user");
    expect(reads).toHaveLength(2);
    reads[0]!.resolve({ status: "active" });
    await expect(old).resolves.toBe(false);
    reads[1]!.resolve({ status: "blocked" });
    await expect(current).resolves.toBe(true);
    expect(cachedAppUserBlocked(db, "cache-invalidate", "user")).toBe(current);
  });

  it("lets a failed read retry without deleting a replacement", async () => {
    const { db, reads } = pendingStatusDb();
    const old = cachedAppUserBlocked(db, "cache-failure", "user");
    invalidateBlockedCache("cache-failure", "user");
    const current = cachedAppUserBlocked(db, "cache-failure", "user");
    reads[0]!.reject(new Error("old read failed"));
    await expect(old).rejects.toThrow("old read failed");
    expect(cachedAppUserBlocked(db, "cache-failure", "user")).toBe(current);
    reads[1]!.reject(new Error("current read failed"));
    await expect(current).rejects.toThrow("current read failed");
    const retry = cachedAppUserBlocked(db, "cache-failure", "user");
    expect(reads).toHaveLength(3);
    reads[2]!.resolve({ status: "active" });
    await expect(retry).resolves.toBe(false);
  });

  it("expires ten seconds after the read starts, even while it remains pending", async () => {
    const clock = vi.spyOn(Date, "now");
    const start = Date.now();
    clock.mockReturnValue(start);
    const { db, reads } = pendingStatusDb();
    const old = cachedAppUserBlocked(db, "cache-ttl", "user");
    clock.mockReturnValue(start + 10_000);
    const current = cachedAppUserBlocked(db, "cache-ttl", "user");
    expect(reads).toHaveLength(2);
    reads[0]!.resolve({ status: "active" });
    await old;
    expect(cachedAppUserBlocked(db, "cache-ttl", "user")).toBe(current);
    reads[1]!.resolve({ status: "blocked" });
    await expect(current).resolves.toBe(true);
  });

  it("reads D1 directly without using admission's stale cache", async () => {
    const { db, reads } = pendingStatusDb();
    const cached = cachedAppUserBlocked(db, "cache-direct", "user");
    reads[0]!.resolve({ status: "active" });
    await cached;
    const direct = appUserBlocked(db, "cache-direct", "user");
    expect(reads).toHaveLength(2);
    reads[1]!.resolve({ status: "blocked" });
    await expect(direct).resolves.toBe(true);
    expect(cachedAppUserBlocked(db, "cache-direct", "user")).toBe(cached);
    expect(blockedUserCache.size).toBe(1);
  });
});

/**
 * The block flag is read before every dispatch but changes only when an
 * operator acts, so the gate keeps a D1 read in a short per-isolate cache.
 */
describe("the per-user block flag", () => {
  /** A hosted environment that counts D1 status reads. */
  function withBlockReadCount(limits: unknown): { env: Env; reads: () => number } {
    let reads = 0;
    const billing = billingStub(() => onPlan(limits));
    const db = new Proxy(env.DB, {
      get: (target, property, receiver) => property === "prepare"
        ? (query: string) => {
            if (query.startsWith("SELECT status FROM app_user")) reads += 1;
            return target.prepare(query);
          }
        : Reflect.get(target, property, receiver),
    });
    const proxied = new Proxy(env, {
      get: (target, property, receiver) => {
        if (property === "BILLING") return billing;
        if (property === "DB") return db;
        return Reflect.get(target, property, receiver);
      },
    }) as Env;
    return { env: proxied, reads: () => reads };
  }

  it("reads the flag once for two requests inside the cache window", async () => {
    const organizationId = "block-cache-org";
    await seedOrganization(organizationId);
    // No per-user limits, so admission only reads this status from D1.
    const key = await seedServerApp("block-cache", { organizationId });
    const counted = withBlockReadCount({ maxRequestsPerMonth: 10 });
    mockUpstream(ok);

    for (let request = 0; request < 2; request += 1) {
      const response = await proxyRequest({
        appId: "block-cache",
        key,
        env: counted.env,
        userId: "cache-user",
      });
      expect(response.status).toBe(200);
    }
    expect(counted.reads()).toBe(1);
  });

  /**
   * Per-user limits also need the D1 status, but requests inside the same
   * cache window share that single read.
   */
  it("reads status once for an app with per-user limits", async () => {
    const organizationId = "block-skip-org";
    await seedOrganization(organizationId);
    const key = await seedServerApp("block-skip", { organizationId, limits: { rpm: 10 } });
    const counted = withBlockReadCount({ maxRequestsPerMonth: 10 });
    mockUpstream(ok);

    for (let request = 0; request < 2; request += 1) {
      const response = await proxyRequest({
        appId: "block-skip",
        key,
        env: counted.env,
        userId: "limited-user",
      });
      expect(response.status).toBe(200);
    }
    expect(counted.reads()).toBe(1);
  });

  it("still refuses a blocked user on such an app, and records it as blocked_user", async () => {
    const organizationId = "block-skip-blocked-org";
    await seedOrganization(organizationId);
    const key = await seedServerApp("block-skip-blocked", {
      organizationId,
      limits: { rpm: 10 },
    });
    await env.DB.prepare("INSERT INTO app_user(app_id, id) VALUES (?, ?)")
      .bind("block-skip-blocked", "banned-user")
      .run();
    await blockUser("block-skip-blocked", "banned-user");
    const counted = withBlockReadCount({ maxRequestsPerMonth: 10 });
    mockUpstream(ok);

    const refused = await proxyRequest({
      appId: "block-skip-blocked",
      key,
      env: counted.env,
      userId: "banned-user",
    });
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "auth_required" } });
    // The status check refuses before either quota is consumed.
    expect(counted.reads()).toBe(1);
    expect(await used(organizationId)).toBe(0);
    expect((await env.USER_LIMITER.getByName("block-skip-blocked:banned-user").getStatus(Date.now())).requestsToday)
      .toBe(0);

    await settle();
    const row = await env.DB.prepare(
      `SELECT reason, scope FROM app_rejection_event WHERE app_id = ?`,
    ).bind("block-skip-blocked").first<{ reason: string; scope: string }>();
    expect(row).toEqual({ reason: "blocked_user", scope: "user" });
  });

  it("refuses at once after a block through the admin route in the same isolate", async () => {
    // The management key is scoped to the operator's own organization, so the
    // app has to live there for the admin route to reach it.
    const key = await seedServerApp("block-admin");
    await env.DB.prepare("INSERT INTO app_user(app_id, id) VALUES (?, ?)")
      .bind("block-admin", "admin-blocked-user")
      .run();
    const billing = hosted({ maxRequestsPerMonth: 10 });
    mockUpstream(ok);

    const admitted = await proxyRequest({
      appId: "block-admin",
      key,
      env: billing,
      userId: "admin-blocked-user",
    });
    expect(admitted.status).toBe(200);

    const executionCtx = createExecutionContext();
    contexts.push(executionCtx);
    const blocked = await worker.fetch(
      new Request(`${ORIGIN}/v1/admin/apps/block-admin/users/admin-blocked-user/block`, {
        method: "POST",
        headers: { authorization: "Bearer agw_mgmt_test-admin-secret" },
      }),
      env,
      executionCtx,
    );
    expect(blocked.status).toBe(200);

    // The isolate that served the block drops its own cached answer, so it does
    // not keep serving the user for the rest of the window.
    const refused = await proxyRequest({
      appId: "block-admin",
      key,
      env: billing,
      userId: "admin-blocked-user",
    });
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "auth_required" } });

    const meContext = createExecutionContext();
    contexts.push(meContext);
    const me = await worker.fetch(
      new Request(`${ORIGIN}/v1/apps/block-admin/me`, {
        headers: { authorization: `Bearer ${key}`, "x-end-user-id": "admin-blocked-user" },
      }),
      env,
      meContext,
    );
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toMatchObject({ limits: { blocked: true } });

    const unblockContext = createExecutionContext();
    contexts.push(unblockContext);
    const unblocked = await worker.fetch(
      new Request(`${ORIGIN}/v1/admin/apps/block-admin/users/admin-blocked-user/unblock`, {
        method: "POST",
        headers: { authorization: "Bearer agw_mgmt_test-admin-secret" },
      }),
      env,
      unblockContext,
    );
    expect(unblocked.status).toBe(200);
    expect((await proxyRequest({
      appId: "block-admin", key, env: billing, userId: "admin-blocked-user",
    })).status).toBe(200);
  });

  it("honours a block written straight to D1 once the cache expires", async () => {
    const organizationId = "block-ttl-org";
    await seedOrganization(organizationId);
    const key = await seedServerApp("block-ttl", { organizationId });
    const billing = hosted({ maxRequestsPerMonth: 10 });
    mockUpstream(ok);
    const request = () =>
      proxyRequest({ appId: "block-ttl", key, env: billing, userId: "ttl-user" });
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);

    expect((await request()).status).toBe(200);
    await blockUser("block-ttl", "ttl-user");
    // A write nobody told this isolate about is served from the cache until the
    // entry expires; that ten-second tail is the documented behaviour.
    expect((await request()).status).toBe(200);

    const meContext = createExecutionContext();
    contexts.push(meContext);
    const me = await worker.fetch(
      new Request(`${ORIGIN}/v1/apps/block-ttl/me`, {
        headers: { authorization: `Bearer ${key}`, "x-end-user-id": "ttl-user" },
      }),
      env,
      meContext,
    );
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toMatchObject({ limits: { blocked: true } });

    clock.mockReturnValue(start + 10_001);
    expect((await request()).status).toBe(403);
  });
});

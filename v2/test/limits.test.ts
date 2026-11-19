/**
 * Step 1b: the three limiters in series, their deadlines and timeout rules,
 * app limits, the plan allowance and plan periods.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../src/index.ts";
import { billingPlanLimits } from "../src/billing/access.ts";
import { freeSchedule, paidSchedule, planPeriod } from "../src/billing/period.ts";
import { parseAppConfig } from "../src/contracts/app-config.ts";
import type { GatewayBillingAccess } from "../src/contracts/billing.ts";
import { GatewayError } from "../src/core/errors.ts";
import type { AppRecord, GatewayIdentity } from "../src/core/types.ts";
import { admitRequest, type AdmissionInput } from "../src/limits/admission.ts";
import { sealSecret } from "../src/vault/secrets.ts";
import { ACCOUNT_ID, clearCaches, seedAccount, seedAppKey, seedRoutedApp } from "./helpers.ts";

const ORIGIN = "https://gateway.test";

let warn: MockInstance<typeof console.warn>;
let error: MockInstance<typeof console.error>;
let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
  clearCaches();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => vi.restoreAllMocks());

/** The events logged at a level, by name. */
function logged(spy: MockInstance<(...args: unknown[]) => void>): string[] {
  return spy.mock.calls.map((call) => {
    try {
      return (JSON.parse(String(call[0])) as { message: string }).message;
    } catch {
      return "";
    }
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- admission, unit

function app(limits: Record<string, unknown> = {}, authentication: Record<string, unknown> = { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } }): AppRecord {
  const config = parseAppConfig({ authentication, limits });
  return {
    id: "app_unit",
    accountId: "acc_unit",
    name: "unit",
    status: "active",
    revision: 1,
    authentication: config.authentication,
    routing: config.routing,
    limits: config.limits,
  };
}

const userIdentity: GatewayIdentity = {
  appId: "app_unit",
  userId: "user-1",
  credentialType: "api_key",
  authMethod: "api_key",
  installId: null,
  appleAccountId: null,
};

const installIdentity: GatewayIdentity = {
  appId: "app_unit",
  userId: "install-1",
  credentialType: "gateway_token",
  authMethod: "attest",
  installId: "install-1",
  appleAccountId: null,
};

/** A stub limiter namespace: every method answers with `answer` after `delayMs`, and the calls are recorded. */
function limiter(name: string, calls: string[], answer: () => unknown, delayMs = 0) {
  const call = async () => {
    calls.push(name);
    if (delayMs > 0) await sleep(delayMs);
    return answer();
  };
  return { getByName: () => ({ check: call, checkRequest: call, admit: call, useCounter: call }) };
}

const allowed = () => ({ allowed: true, budget: "none" });

function input(overrides: Partial<AdmissionInput> & { env: Env }): AdmissionInput {
  return {
    app: app({ per_user: { requests: { per_minute: 10 } }, per_app: { requests: { per_minute: 10 } } }),
    identity: userIdentity,
    assertionCounter: null,
    waitUntil: () => undefined,
    refuse: (refusal) => refusal,
    ...overrides,
  };
}

/** A billing binding whose account has a plan with these limits. */
function billing(limits: Record<string, unknown> | undefined, delayMs = 0, fail = false) {
  return {
    getTenantAccess: async () => {
      if (delayMs > 0) await sleep(delayMs);
      if (fail) throw new Error("billing down");
      return { plan: { planKey: "p", planName: "P", isDefault: true, ...(limits === undefined ? {} : { limits }) }, subscription: null };
    },
  };
}

describe("admission order and timeout rules", () => {
  it("calls the end user's limiter, then the app's, then the account's", async () => {
    const calls: string[] = [];
    await seedAccount();
    const stubbed = {
      ...env,
      END_USER_LIMITER: limiter("user", calls, allowed),
      APP_LIMITER: limiter("app", calls, allowed),
      ACCOUNT_LIMITER: limiter("account", calls, () => ({ allowed: true, used: 1, limit: 100 })),
      BILLING: billing({ maxRequestsPerMonth: 100 }),
    } as unknown as Env;
    await admitRequest(input({ env: stubbed, app: { ...input({ env }).app, accountId: ACCOUNT_ID } }));
    expect(calls).toEqual(["user", "app", "account"]);
  });

  it("never uses the plan allowance for a request the app's own limits refuse", async () => {
    const calls: string[] = [];
    const stubbed = {
      ...env,
      END_USER_LIMITER: limiter("user", calls, allowed),
      APP_LIMITER: limiter("app", calls, () => ({ allowed: false, reason: "rate", retryAfterSeconds: 7 })),
      ACCOUNT_LIMITER: limiter("account", calls, () => ({ allowed: true, used: 1, limit: 100 })),
      BILLING: billing({ maxRequestsPerMonth: 100 }),
    } as unknown as Env;
    await expect(admitRequest(input({ env: stubbed }))).rejects.toMatchObject({ status: 429, code: "app_rate_limited", data: { scope: "app" } });
    expect(calls).toEqual(["user", "app"]);
  });

  it("serves a request when a limit check is slow or fails, and logs it", async () => {
    const calls: string[] = [];
    const stubbed = {
      ...env,
      END_USER_LIMITER: limiter("user", calls, allowed, 200),
      APP_LIMITER: { getByName: () => ({ checkRequest: async () => { throw new Error("object gone"); } }) },
    } as unknown as Env;
    await expect(admitRequest(input({ env: stubbed, limitsDeadlineMs: 30 }))).resolves.toBeUndefined();
    expect(logged(warn).filter((name) => name === "app_limits_unchecked")).toHaveLength(2);
  });

  it("shares one deadline: three slow limiters do not cost three deadlines", async () => {
    const calls: string[] = [];
    await seedAccount();
    const stubbed = {
      ...env,
      END_USER_LIMITER: limiter("user", calls, allowed, 300),
      APP_LIMITER: limiter("app", calls, allowed, 300),
      ACCOUNT_LIMITER: limiter("account", calls, () => ({ allowed: true, used: 1, limit: 100 }), 300),
      BILLING: billing({ maxRequestsPerMonth: 100 }),
    } as unknown as Env;
    const started = Date.now();
    await admitRequest(input({ env: stubbed, app: { ...input({ env }).app, accountId: ACCOUNT_ID }, limitsDeadlineMs: 60 }));
    expect(Date.now() - started).toBeLessThan(250);
    // The first ran out the deadline; the app's and the account's turns came after it, so they were skipped.
    expect(calls).toEqual(["user"]);
    expect(logged(warn)).toEqual(expect.arrayContaining(["app_limits_unchecked", "allowance_uncounted"]));
  });

  it("starts the shared deadline after the replay check, so a slow replay check never makes the budget checks skip", async () => {
    const calls: string[] = [];
    const stubbed = {
      ...env,
      END_USER_LIMITER: limiter("user", calls, allowed, 80),
      APP_LIMITER: limiter("app", calls, () => ({ allowed: false, reason: "budget" }), 10),
    } as unknown as Env;
    const attestApp = app(
      { per_app: { spending: { monthly_nano: 0 } } },
      { type: "apple_app_attest", end_user: { source: "app_install" }, app_attest: { team_id: "AAAAAAAAAA", bundle_id: "com.example.app" } },
    );
    await expect(
      admitRequest(input({ env: stubbed, app: attestApp, identity: installIdentity, assertionCounter: 5, replayDeadlineMs: 500, limitsDeadlineMs: 50 })),
    ).rejects.toMatchObject({ status: 429, code: "app_budget_exhausted", data: { scope: "app" } });
    expect(calls).toEqual(["user", "app"]);
  });

  it("refuses a request that needs the replay check when the end user's limiter does not answer", async () => {
    const attestApp = app({}, { type: "apple_app_attest", end_user: { source: "app_install" }, app_attest: { team_id: "AAAAAAAAAA", bundle_id: "com.example.app" } });
    const slow = { ...env, END_USER_LIMITER: limiter("user", [], allowed, 200) } as unknown as Env;
    await expect(
      admitRequest(input({ env: slow, app: attestApp, identity: installIdentity, assertionCounter: 5, replayDeadlineMs: 30 })),
    ).rejects.toMatchObject({ status: 503, code: "service_unavailable" });
    const failing = { ...env, END_USER_LIMITER: { getByName: () => ({ check: async () => { throw new Error("gone"); } }) } } as unknown as Env;
    await expect(
      admitRequest(input({ env: failing, app: attestApp, identity: installIdentity, assertionCounter: 5 })),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("refuses a replayed counter, and marks it as a replay", async () => {
    const attestApp = app({}, { type: "apple_app_attest", end_user: { source: "app_install" }, app_attest: { team_id: "AAAAAAAAAA", bundle_id: "com.example.app" } });
    const marks: string[] = [];
    const stubbed = { ...env, END_USER_LIMITER: limiter("user", [], () => ({ allowed: false, reason: "replay" })) } as unknown as Env;
    await expect(
      admitRequest(input({ env: stubbed, app: attestApp, identity: installIdentity, assertionCounter: 5, refuse: (e, reason, scope) => (marks.push(`${reason}/${scope}`), e) })),
    ).rejects.toMatchObject({ status: 403, code: "attest_failed" });
    expect(marks).toEqual(["blocked_replay/install"]);
  });

  it("calls no limiter at all for an app with no limits on a self-hosted deployment", async () => {
    const calls: string[] = [];
    const stubbed = {
      ...env,
      END_USER_LIMITER: limiter("user", calls, allowed),
      APP_LIMITER: limiter("app", calls, allowed),
      ACCOUNT_LIMITER: limiter("account", calls, allowed),
    } as unknown as Env;
    await admitRequest(input({ env: stubbed, app: app() }));
    expect(calls).toEqual([]);
  });
});

describe("the plan allowance", () => {
  it("serves a request when billing is slow or cannot be reached, and logs it", async () => {
    await seedAccount();
    const calls: string[] = [];
    const base = { ...env, ACCOUNT_LIMITER: limiter("account", calls, () => ({ allowed: true, used: 1, limit: 1 })) };
    const plain = { ...input({ env }).app, accountId: ACCOUNT_ID, limits: app().limits };
    await admitRequest(input({ env: { ...base, BILLING: billing({ maxRequestsPerMonth: 1 }, 200) } as unknown as Env, app: plain, billingDeadlineMs: 20 }));
    expect(logged(warn)).toContain("billing_access_slow");
    clearCaches();
    await admitRequest(input({ env: { ...base, BILLING: billing({ maxRequestsPerMonth: 1 }, 0, true) } as unknown as Env, app: plain }));
    expect(logged(warn)).toContain("billing_unavailable_admitted");
    expect(logged(error)).toContain("billing_access_failed");
    expect(calls).toEqual([]);
  });

  it("serves uncounted when the counter does not answer, and refuses once this isolate saw the plan used up", async () => {
    await seedAccount();
    const plain = { ...input({ env }).app, accountId: ACCOUNT_ID, limits: app().limits };
    const answering = { ...env, BILLING: billing({ maxRequestsPerMonth: 1 }) } as unknown as Env;
    await admitRequest(input({ env: answering, app: plain }));
    const slowCounter = { ...answering, ACCOUNT_LIMITER: limiter("account", [], () => ({ allowed: true, used: 1, limit: 1 }), 200) } as unknown as Env;
    // The counter's last answer said 1 of 1 is used, so the plan is known to be used up.
    await expect(admitRequest(input({ env: slowCounter, app: plain, limitsDeadlineMs: 30 }))).rejects.toMatchObject({
      status: 429,
      code: "billing_request_quota_exceeded",
    });
  });

  it("serves uncounted when plan data cannot be read as a limit", async () => {
    await seedAccount();
    const plain = { ...input({ env }).app, accountId: ACCOUNT_ID, limits: app().limits };
    await admitRequest(input({ env: { ...env, BILLING: billing({ maxRequestsPerMonth: -3 }) } as unknown as Env, app: plain }));
    expect(logged(warn)).toContain("allowance_uncounted");
  });

  it("refuses an account no plan resolves for with 402, as v1", async () => {
    await seedAccount();
    const plain = { ...input({ env }).app, accountId: ACCOUNT_ID, limits: app().limits };
    const none = { ...env, BILLING: { getTenantAccess: async () => ({ plan: null, subscription: null }) } } as unknown as Env;
    await expect(admitRequest(input({ env: none, app: plain }))).rejects.toMatchObject({ status: 402, code: "billing_payment_required" });
  });

  it("reads plan limits from plan data, including the minutes field", () => {
    const access = (limits: unknown): GatewayBillingAccess => ({
      state: "billed",
      plan: { planKey: "p", planName: "P", isDefault: true, limits },
      subscription: null,
    });
    expect(billingPlanLimits(access({ maxRequestsPerMonth: "1000", maxSessionMinutesPerMonth: 30.0, maxApps: 3 }))).toEqual({
      maxRequestsPerMonth: 1000,
      maxSessionMinutesPerMonth: 30,
    });
    expect(billingPlanLimits(access({}))).toEqual({});
    expect(() => billingPlanLimits(access({ maxSessionMinutesPerMonth: 1.5 }))).toThrow(GatewayError);
    expect(billingPlanLimits({ state: "self_hosted" })).toEqual({});
  });
});

describe("plan periods (D18)", () => {
  it("start at 00:00 UTC on the renewal day, never later", () => {
    const anchor = Date.parse("2026-03-10T15:30:00Z");
    const schedule = paidSchedule(anchor, 10, anchor);
    expect(planPeriod(schedule, Date.parse("2026-11-19T12:00:00Z"))).toMatchObject({
      periodStart: "2026-11-10T00:00:00.000Z",
      periodEnd: "2026-12-10T00:00:00.000Z",
    });
    // On the renewal day itself, before the anchor's own time, the new period has already begun.
    expect(planPeriod(schedule, Date.parse("2026-12-10T08:00:00Z"))).toMatchObject({ periodStart: "2026-12-10T00:00:00.000Z" });
  });

  it("clamp a renewal on the 31st to short months and come back", () => {
    const anchor = Date.parse("2026-01-31T09:00:00Z");
    const schedule = paidSchedule(anchor, 31, anchor);
    expect(planPeriod(schedule, Date.parse("2026-02-28T10:00:00Z")).periodStart).toBe("2026-02-28T00:00:00.000Z");
    expect(planPeriod(schedule, Date.parse("2026-03-31T00:00:00Z")).periodStart).toBe("2026-03-31T00:00:00.000Z");
  });

  it("run the default plan's months from the day the account was created", () => {
    const created = Date.parse("2026-06-05T23:59:00Z");
    expect(planPeriod(freeSchedule(created), Date.parse("2026-06-05T23:59:30Z"))).toMatchObject({
      periodStart: "2026-06-05T00:00:00.000Z",
      periodEnd: "2026-07-05T00:00:00.000Z",
    });
  });
});

// ---------------------------------------------------------------- limiter objects

describe("budget totals", () => {
  it("come from the rollups, cached and refreshed in the background every 10 s", async () => {
    const appId = `app_budget_${crypto.randomUUID().slice(0, 8)}`;
    const day = new Date().toISOString().slice(0, 10);
    const at = Date.now();
    const add = (nano: number) =>
      env.DB.prepare(
        `INSERT INTO budget_day (app_id, scope, scope_id, day, cost_nano, session_ms) VALUES (?, 'app', ?, ?, ?, 0)
         ON CONFLICT (app_id, scope, scope_id, day) DO UPDATE SET cost_nano = cost_nano + excluded.cost_nano`,
      ).bind(appId, appId, day, nano).run();
    const limiter = env.APP_LIMITER.getByName(appId);
    const check = (now: number) =>
      limiter.checkRequest({ now, rpm: null, rpd: null, budgetNano: 150, spend: { appId, scope: "app", key: appId } });
    await add(100);
    expect(await check(at)).toEqual({ allowed: true, budget: "checked" });
    await add(100);
    // Still the cached figure inside the 10 s.
    expect(await check(at + 5_000)).toEqual({ allowed: true, budget: "checked" });
    // Past it, the request still uses the cached figure, and starts one refresh.
    expect(await check(at + 11_000)).toEqual({ allowed: true, budget: "checked" });
    await vi.waitFor(async () => expect(await check(at + 11_100)).toMatchObject({ allowed: false, reason: "budget" }));
  });

  it("leave the budget unchecked when they cannot be read, and serve", async () => {
    const appId = `app_unread_${crypto.randomUUID().slice(0, 8)}`;
    const result = await env.APP_LIMITER.getByName(appId).checkRequest({
      now: Date.now(),
      rpm: null,
      rpd: null,
      budgetNano: 1,
      // A month the D1 query cannot bind turns the read into a failure.
      spend: { appId, scope: "app", key: undefined as unknown as string },
    });
    expect(result).toEqual({ allowed: true, budget: "unread" });
  });

  it("count requests per minute and per day, with v1's Retry-After", async () => {
    const limiter = env.APP_LIMITER.getByName(`windows_${crypto.randomUUID().slice(0, 8)}`);
    const now = Date.parse("2026-11-19T10:00:30Z");
    const check = () => limiter.checkRequest({ now, rpm: 2, rpd: 100, budgetNano: null, spend: null });
    expect(await check()).toMatchObject({ allowed: true });
    expect(await check()).toMatchObject({ allowed: true });
    expect(await check()).toEqual({ allowed: false, reason: "rate", retryAfterSeconds: 30 });
    expect(await limiter.requestsToday(now)).toBe(2);
  });
});

describe("plan minutes", () => {
  it("are the account's session time in the rollups over the period", async () => {
    await env.DB.prepare(
      `INSERT INTO usage_day (account_id, app_id, day, provider_type, provider_connection_id, model, outcome, unit, session_ms)
       VALUES ('acc_minutes', 'app_m', '2026-11-12', 'openai', '', '', 'ok', '', 90000),
              ('acc_minutes', 'app_m', '2026-12-12', 'openai', '', '', 'ok', '', 60000)`,
    ).run();
    const account = env.ACCOUNT_LIMITER.getByName("acc_minutes");
    expect(await account.sessionMs({ accountId: "acc_minutes", fromDay: "2026-11-10", toDay: "2026-12-10", now: Date.now() })).toBe(90_000);
  });
});

// ---------------------------------------------------------------- end to end

const SECRET = "sk-test-provider-key-1234";

async function routedApp(limits: Record<string, unknown>, accountId: string = ACCOUNT_ID) {
  await seedAccount();
  if (accountId !== ACCOUNT_ID) {
    const at = new Date().toISOString();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO mgmt_organization(id, name, created_by_user_id, created_at, updated_at) VALUES (?, 'Other', 'usr_test', ?, ?)",
    ).bind(accountId, at, at).run();
  }
  const connectionId = crypto.randomUUID().replaceAll("-", "");
  const slug = `openai-${connectionId.slice(0, 6)}`;
  const blob = await sealSecret(env, "providerKey", [accountId, connectionId, "openai", ""], SECRET);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO provider_connection (id, account_id, type, slug, name, status, secret_blob, secret_hint, revision, created_by, created_at, updated_at)
     VALUES (?, ?, 'openai', ?, 'OpenAI', 'active', ?, '1234', 1, 'usr_test', ?, ?)`,
  ).bind(connectionId, accountId, slug, blob, now, now).run();
  const appId = await seedRoutedApp(
    { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
    { providers: { [slug]: { operations: ["openai.chat"] } } },
  );
  await env.DB.prepare("UPDATE app SET account_id = ?, config_json = json_set(config_json, '$.limits', json(?)) WHERE id = ?")
    .bind(accountId, JSON.stringify(limits), appId)
    .run();
  const key = await seedAppKey(appId);
  return { appId, slug, key: key.key };
}

async function chat(target: { appId: string; slug: string; key: string }, environment: Env = env, user = "user-7") {
  fetchSpy.mockResolvedValue(Response.json({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}/v2/apps/${target.appId}/proxy/${target.slug}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${target.key}`, "content-type": "application/json", "x-end-user-id": user },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [] }),
    }),
    environment,
    ctx,
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  let body: Record<string, any> | null = null;
  try {
    body = JSON.parse(text) as Record<string, any>;
  } catch {
    body = null;
  }
  return { status: response.status, headers: response.headers, body };
}

async function rejections(appId: string) {
  const { results } = await env.DB.prepare("SELECT reason, scope FROM app_rejection_event WHERE app_id = ?").bind(appId).all();
  return results;
}

describe("limits on the proxy path", () => {
  it("refuses over a user's rate limit with v1's code, scope and Retry-After, and records it", async () => {
    const target = await routedApp({ per_user: { requests: { per_minute: 1 } } });
    expect((await chat(target)).status).toBe(200);
    const refused = await chat(target);
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: { code: "app_rate_limited", data: { scope: "user" } } });
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await rejections(target.appId)).toEqual([{ reason: "blocked_app_rate", scope: "user" }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses an app over its monthly budget, with Retry-After to the month's end", async () => {
    const target = await routedApp({ per_app: { spending: { monthly_nano: 0 } } });
    const refused = await chat(target);
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: { code: "app_budget_exhausted", data: { scope: "app" } } });
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await rejections(target.appId)).toEqual([{ reason: "blocked_app_budget", scope: "app" }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("counts the plan allowance only for admitted requests, and refuses with v1's code and data once it is used up", async () => {
    const accountId = `acc_plan_${crypto.randomUUID().slice(0, 8)}`;
    const target = await routedApp({ per_app: { requests: { per_minute: 2 } } }, accountId);
    const hosted = { ...env, BILLING: billing({ maxRequestsPerMonth: 3 }) } as unknown as Env;
    expect((await chat(target, hosted)).status).toBe(200);
    expect((await chat(target, hosted)).status).toBe(200);
    // Refused by the app's own limit, so the allowance is not touched.
    expect((await chat(target, hosted)).body).toMatchObject({ error: { code: "app_rate_limited" } });
    const { billingQuotaFor } = await import("../src/billing/quota.ts");
    const quota = await billingQuotaFor(
      { state: "billed", plan: { planKey: "p", planName: "P", isDefault: true, limits: { maxRequestsPerMonth: 3 } }, subscription: null },
      env,
      accountId,
    );
    if (quota.kind !== "metered") throw new Error("expected a metered plan");
    expect(await env.ACCOUNT_LIMITER.getByName(accountId).usage(quota.period.periodId)).toBe(2);

    // A new minute: the app's limit has room again; the plan's third request is the last.
    await env.DB.prepare("UPDATE app SET config_json = json_set(config_json, '$.limits', json('{}')) WHERE id = ?").bind(target.appId).run();
    clearCaches();
    expect((await chat(target, hosted)).status).toBe(200);
    // Another user: rejection events are sampled once a minute per user, whatever the reason.
    const refused = await chat(target, hosted, "user-8");
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({
      error: {
        code: "billing_request_quota_exceeded",
        data: {
          limit: 3,
          used: 3,
          periodId: quota.period.periodId,
          periodStart: quota.period.periodStart,
          periodEnd: quota.period.periodEnd,
          resetAt: quota.period.resetAt,
        },
      },
    });
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await rejections(target.appId)).toEqual(
      expect.arrayContaining([{ reason: "blocked_app_rate", scope: "app" }, { reason: "blocked_billing", scope: "account" }]),
    );
  });
});

describe("/me", () => {
  it("reports the user's limits and where they stand, with money in dollars", async () => {
    const target = await routedApp({ per_user: { requests: { per_day: 5 }, spending: { monthly_nano: 1_500_000_000 } } });
    expect((await chat(target)).status).toBe(200);
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v2/apps/${target.appId}/me`, { headers: { authorization: `Bearer ${target.key}`, "x-end-user-id": "user-7" } }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(await response.json()).toEqual({
      user_id: "user-7",
      install_id: null,
      limits: {
        requests_today: 1,
        requests_remaining: 4,
        requests_per_minute: null,
        requests_per_day: 5,
        monthly_cost_usd: expect.any(Number),
        monthly_budget_usd: 1.5,
        budget_scope: "user",
        blocked: false,
      },
    });
  });
});

describe("app limits settings", () => {
  const server = { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } };
  it("refuse per-user limits on an app that names no end users", () => {
    expect(() => parseAppConfig({ authentication: { type: "api_key", end_user: { source: "none" } }, limits: { per_user: { requests: { per_day: 5 } } } })).toThrow(/per_user/);
  });
  it("refuse an install budget on a server app, and keep money in whole nano-dollars", () => {
    expect(() => parseAppConfig({ authentication: server, limits: { per_user: { spending: { monthly_nano: 5, scope: "install" } } } })).toThrow(/server apps/);
    expect(() => parseAppConfig({ authentication: server, limits: { per_app: { spending: { monthly_nano: 1.5 } } } })).toThrow();
    expect(parseAppConfig({ authentication: server, limits: { per_app: { spending: { monthly_nano: 1_500_000_000 } } } }).limits.per_app).toEqual({
      requests: { per_minute: null, per_day: null },
      spending: { monthly_nano: 1_500_000_000 },
    });
  });
});


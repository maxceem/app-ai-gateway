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
import {
  ACCOUNT_ID,
  attestAuthentication,
  clearCaches,
  registerTestInstall,
  seedAccount,
  seedAppKey,
  seedRoutedApp,
  signedProof,
  slowFakes,
  tokenForInstall,
  useFakeClock,
  watch,
  ledger,
} from "./helpers.ts";
import { TEST_VAULT_ENV } from "./local-vault.ts";

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

/** Slow limiters, billing and D1 answer only when the test lets them, never on a real timer. */
const slow = slowFakes();

afterEach(() => {
  slow.release();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Runs `call` under fake time once a slow fake holds it, and checks the
 * deadline: still waiting 1 ms before `deadlineMs`, settled at it.
 */
async function settlesAtDeadline<T>(call: () => Promise<T>, deadlineMs: number): Promise<T> {
  useFakeClock();
  const pending = call();
  const done = watch(pending);
  await slow.reached();
  await vi.advanceTimersByTimeAsync(deadlineMs - 1);
  expect(done.settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(done.settled).toBe(true);
  return pending;
}

/** The `reason` of each `app_limits_unchecked` warning, in order. */
function uncheckedReasons(): string[] {
  return warn.mock.calls.flatMap((call) => {
    try {
      const event = JSON.parse(String(call[0])) as { message: string; reason?: string };
      return event.message === "app_limits_unchecked" ? [String(event.reason)] : [];
    } catch {
      return [];
    }
  });
}

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
    presets: config.presets ?? {},
    conversations: null,
    accountPending: false,
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


/** Passed as `slow`: the stub answers only once the test lets it, after any deadline. */
const SLOW = true;

/**
 * A stub limiter namespace, and the calls it got. `useCounter` (the replay
 * check) answers `counter`; the others `answer`. A `slow` one answers only
 * once the test releases it.
 */
function limiter(
  name: string,
  calls: string[],
  answer: () => unknown,
  isSlow = false,
  counter: () => unknown = () => ({ accepted: true }),
) {
  const call = (respond: () => unknown, label: string) => async () => {
    calls.push(label);
    if (isSlow) await slow.held();
    return respond();
  };
  return {
    getByName: () => ({
      checkRequest: call(answer, name),
      admit: call(answer, name),
      useCounter: call(counter, `${name}:replay`),
    }),
  };
}

const allowed = () => ({ allowed: true, budget: "none" });

function input(overrides: Partial<AdmissionInput> & { env: Env }): AdmissionInput {
  return {
    app: app({ per_user: { requests: { per_minute: 10 } }, per_app: { requests: { per_minute: 10 } } }),
    identity: userIdentity,
    waitUntil: () => undefined,
    refuse: (refusal) => refusal,
    ...overrides,
  };
}

/** A billing binding whose account has a plan with these limits. A `slow` one answers once the test releases it. */
function billing(limits: Record<string, unknown> | undefined, isSlow = false, fail = false) {
  return {
    getTenantAccess: async () => {
      if (isSlow) await slow.held();
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

  it("keeps the plan read alive when the app's own limits refuse first", async () => {
    const kept: Promise<unknown>[] = [];
    const stubbed = {
      ...env,
      END_USER_LIMITER: limiter("user", [], allowed),
      APP_LIMITER: limiter("app", [], () => ({ allowed: false, reason: "rate", retryAfterSeconds: 7 })),
      BILLING: billing({ maxRequestsPerMonth: 100 }, SLOW),
    } as unknown as Env;
    await expect(
      admitRequest(input({ env: stubbed, waitUntil: (promise) => void kept.push(promise) })),
    ).rejects.toMatchObject({ code: "app_rate_limited" });
    // The refusal came before the plan read answered; it is still handed to waitUntil.
    expect(kept.length).toBeGreaterThan(0);
    slow.release();
    await Promise.all(kept);
  });

  it("serves a request when a limit check is slow, and logs it", async () => {
    const calls: string[] = [];
    const stubbed = {
      ...env,
      END_USER_LIMITER: limiter("user", calls, allowed, SLOW),
      APP_LIMITER: limiter("app", calls, allowed),
    } as unknown as Env;
    await expect(settlesAtDeadline(() => admitRequest(input({ env: stubbed, limitsDeadlineMs: 30 })), 30)).resolves.toBeUndefined();
    expect(uncheckedReasons()).toEqual(["deadline", "deadline"]);
  });

  it("serves a request when a limit check fails, and logs it", async () => {
    const stubbed = {
      ...env,
      END_USER_LIMITER: limiter("user", [], allowed),
      APP_LIMITER: { getByName: () => ({ checkRequest: async () => { throw new Error("object gone"); } }) },
    } as unknown as Env;
    await expect(admitRequest(input({ env: stubbed }))).resolves.toBeUndefined();
    expect(uncheckedReasons()).toEqual(["failed"]);
  });

  it("shares one deadline: three slow limiters do not cost three deadlines", async () => {
    const calls: string[] = [];
    await seedAccount();
    const stubbed = {
      ...env,
      END_USER_LIMITER: limiter("user", calls, allowed, SLOW),
      APP_LIMITER: limiter("app", calls, allowed, SLOW),
      ACCOUNT_LIMITER: limiter("account", calls, () => ({ allowed: true, used: 1, limit: 100 }), SLOW),
      BILLING: billing({ maxRequestsPerMonth: 100 }),
    } as unknown as Env;
    // One deadline in all: the call answers at 60 ms, not after three of them.
    await settlesAtDeadline(() => admitRequest(input({ env: stubbed, app: { ...input({ env }).app, accountId: ACCOUNT_ID }, limitsDeadlineMs: 60 })), 60);
    // The first ran out the deadline; the app's and the account's turns came after it, so they were skipped.
    expect(calls).toEqual(["user"]);
    expect(logged(warn)).toEqual(expect.arrayContaining(["app_limits_unchecked", "allowance_uncounted"]));
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
    await settlesAtDeadline(
      () => admitRequest(input({ env: { ...base, BILLING: billing({ maxRequestsPerMonth: 1 }, SLOW) } as unknown as Env, app: plain, billingDeadlineMs: 20 })),
      20,
    );
    expect(logged(warn)).toContain("billing_access_slow");
    vi.useRealTimers();
    clearCaches();
    await admitRequest(input({ env: { ...base, BILLING: billing({ maxRequestsPerMonth: 1 }, false, true) } as unknown as Env, app: plain }));
    expect(logged(warn)).toContain("billing_unavailable_admitted");
    expect(logged(error)).toContain("billing_access_failed");
    expect(calls).toEqual([]);
  });

  it("serves uncounted when the counter does not answer, and refuses once this isolate saw the plan used up", async () => {
    await seedAccount();
    const plain = { ...input({ env }).app, accountId: ACCOUNT_ID, limits: app().limits };
    const answering = { ...env, BILLING: billing({ maxRequestsPerMonth: 1 }) } as unknown as Env;
    await admitRequest(input({ env: answering, app: plain }));
    const slowCounter = { ...answering, ACCOUNT_LIMITER: limiter("account", [], () => ({ allowed: true, used: 1, limit: 1 }), SLOW) } as unknown as Env;
    // The counter's last answer said 1 of 1 is used, so the plan is known to be used up.
    await expect(settlesAtDeadline(() => admitRequest(input({ env: slowCounter, app: plain, limitsDeadlineMs: 30 })), 30)).rejects.toMatchObject({
      status: 429,
      code: "billing_request_quota_exceeded",
    });
  });

  it("bounds working out the plan period by the shared deadline", async () => {
    const plain = { ...input({ env }).app, accountId: "acc_slow_created", limits: app().limits };
    const calls: string[] = [];
    // Billing answers at once; the account's creation day (D1) answers only after the deadline.
    const slowDb = {
      prepare: () => ({ bind: () => ({ first: async () => (await slow.held(), { created_at: new Date().toISOString() }) }) }),
    };
    const stubbed = {
      ...env,
      DB: slowDb,
      BILLING: billing({ maxRequestsPerMonth: 10 }),
      ACCOUNT_LIMITER: limiter("account", calls, () => ({ allowed: true, used: 1, limit: 10 })),
    } as unknown as Env;
    await settlesAtDeadline(() => admitRequest(input({ env: stubbed, app: plain, limitsDeadlineMs: 40 })), 40);
    expect(calls).toEqual([]);
    expect(logged(warn)).toContain("allowance_uncounted");
  });

  it("refuses without the counter only when the counter itself confirmed the plan used up", async () => {
    const { admitAllowance } = await import("../src/billing/allowance.ts");
    const period = { periodId: "free:x:2026-11-01T00:00:00.000Z", periodEnd: new Date(Date.now() + 86_400_000).toISOString(), limit: 3 };
    // The counter confirms 2 of 3.
    expect(await admitAllowance({ admit: () => ({ allowed: true, used: 2, limit: 3 }) }, "acc_s4", period, () => undefined, 100)).toMatchObject({
      kind: "answered",
    });
    // Then it fails twice: both requests are served uncounted, never refused on a guess.
    const failing = { admit: async () => { throw new Error("counter gone"); } };
    expect(await admitAllowance(failing, "acc_s4", period, () => undefined, 100)).toEqual({ kind: "uncounted" });
    expect(await admitAllowance(failing, "acc_s4", period, () => undefined, 100)).toEqual({ kind: "uncounted" });
    // Once the counter confirms the plan used up, a failure refuses.
    await admitAllowance({ admit: () => ({ allowed: false, used: 3, limit: 3, retryAfterSeconds: 60 }) }, "acc_s4", period, () => undefined, 100);
    expect(await admitAllowance(failing, "acc_s4", period, () => undefined, 100)).toMatchObject({ kind: "exhausted", used: 3 });
  });

  it("never refuses on the last known plan while billing is down, even one the counter saw used up", async () => {
    const accountId = `acc_stale_${crypto.randomUUID().slice(0, 8)}`;
    const at = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO mgmt_organization(id, name, created_by_user_id, created_at, updated_at) VALUES (?, 'Stale', 'usr_test', ?, ?)",
    ).bind(accountId, at, at).run();
    const plain = { ...input({ env }).app, accountId, limits: app().limits };
    let billingUp = true;
    const flaky = {
      getTenantAccess: async () => {
        if (!billingUp) throw new Error("billing down");
        return { plan: { planKey: "p", planName: "P", isDefault: true, limits: { maxRequestsPerMonth: 1 } }, subscription: null };
      },
    };
    const hosted = { ...env, BILLING: flaky } as unknown as Env;
    // The one request of the plan is used, and the counter confirmed it.
    await admitRequest(input({ env: hosted, app: plain }));
    // Billing goes down; once the short cache has expired, only the last known plan is left.
    billingUp = false;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);
    try {
      await expect(admitRequest(input({ env: hosted, app: plain }))).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    expect(logged(warn)).toEqual(expect.arrayContaining(["billing_access_stale", "allowance_uncounted"]));
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
    // A fixed time mid-month: the 11 s below never cross into another month's totals.
    const at = Date.parse("2026-11-19T10:00:00Z");
    const day = "2026-11-19";
    const add = (nano: number) =>
      ledger().prepare(
        `INSERT INTO budget_day (app_id, scope, scope_id, day, cost_nano, session_ms) VALUES (?, 'app', ?, ?, ?, 0)
         ON CONFLICT (app_id, scope, scope_id, day) DO UPDATE SET cost_nano = cost_nano + excluded.cost_nano`,
      ).bind(appId, appId, day, nano).run();
    const limiter = env.APP_LIMITER.getByName(appId);
    const check = (now: number) =>
      limiter.checkRequest({ now, rpm: null, rpd: null, budgetNano: 150, spend: { accountId: ACCOUNT_ID, appId, scope: "app", key: appId } });
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
      spend: { accountId: ACCOUNT_ID, appId, scope: "app", key: undefined as unknown as string },
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
    await ledger("acc_minutes").prepare(
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
  const blob = await sealSecret(TEST_VAULT_ENV, "providerKey", [accountId, connectionId, "openai", "", "", ""], SECRET);
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

async function rejections(appId: string, accountId: string = ACCOUNT_ID) {
  const { results } = await ledger(accountId).prepare("SELECT reason, scope FROM app_rejection_event WHERE app_id = ?").bind(appId).all();
  return results;
}

/**
 * Holds the clock still at the middle of the current minute, so requests a
 * per-minute limit counts together all land in one minute, however long the
 * test takes. Only `Date` is faked: admission reads the time there and passes
 * it to the limiters. `afterEach` restores the real clock.
 */
function pinClockMidMinute(): void {
  const minute = Math.floor(Date.now() / 60_000) * 60_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(minute + 30_000);
}

describe("limits on the proxy path", () => {
  it("refuses over a user's rate limit with v1's code, scope and Retry-After, and records it", async () => {
    pinClockMidMinute();
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
    pinClockMidMinute();
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
    expect(await rejections(target.appId, accountId)).toEqual(
      expect.arrayContaining([{ reason: "blocked_app_rate", scope: "app" }, { reason: "blocked_billing", scope: "account" }]),
    );
  });
});

describe("refusals that need no limiter", () => {
  it("refuse a request over the output cap before it spends a request limit or the plan allowance", async () => {
    const accountId = `acc_cap_${crypto.randomUUID().slice(0, 8)}`;
    const target = await routedApp({ per_app: { requests: { per_minute: 1 } } }, accountId);
    await env.DB.prepare("UPDATE app SET config_json = json_set(config_json, ?, 100) WHERE id = ?")
      .bind(`$.routing.providers.${target.slug}.max_output_tokens`, target.appId)
      .run();
    clearCaches();
    const hosted = { ...env, BILLING: billing({ maxRequestsPerMonth: 1 }) } as unknown as Env;
    fetchSpy.mockResolvedValue(Response.json({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    const ctx = createExecutionContext();
    const over = await worker.fetch(
      new Request(`${ORIGIN}/v2/apps/${target.appId}/proxy/${target.slug}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${target.key}`, "content-type": "application/json", "x-end-user-id": "user-7" },
        body: JSON.stringify({ model: "gpt-4o-mini", messages: [], max_tokens: 101 }),
      }),
      hosted,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(over.status).toBe(403);
    // The app's one request a minute and the plan's one request are both still there.
    expect((await chat(target, hosted)).status).toBe(200);
  });
});

describe("signed requests", () => {
  it("are single use whatever refuses them: one refused by the output cap cannot be sent again once the cap is raised", async () => {
    const { slug } = await routedApp({});
    const appId = await seedRoutedApp(attestAuthentication(), { providers: { [slug]: { operations: ["openai.chat"], max_output_tokens: 100 } } });
    const install = await registerTestInstall(appId);
    const token = await tokenForInstall(install);
    fetchSpy.mockResolvedValue(Response.json({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    const url = `${ORIGIN}/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`;
    const body = new TextEncoder().encode(JSON.stringify({ model: "gpt-4o-mini", messages: [], max_tokens: 101 }));
    const proof = await signedProof({ install, token, method: "POST", url, body, counter: 1 });
    const send = async () => {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-app-version": "1.0", "x-appattest-proof": proof },
          body,
        }),
        env,
        ctx,
      );
      const json = (await response.json()) as { error?: { code?: string } };
      await waitOnExecutionContext(ctx);
      return { status: response.status, code: json.error?.code };
    };
    expect(await send()).toEqual({ status: 403, code: "max_output_tokens_exceeded" });
    await env.DB.prepare("UPDATE app SET config_json = json_set(config_json, ?, 1000) WHERE id = ?")
      .bind(`$.routing.providers.${slug}.max_output_tokens`, appId)
      .run();
    clearCaches();
    expect(await send()).toEqual({ status: 403, code: "attest_failed" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("are single use even when refused for a missing X-App-Version, which is not signed", async () => {
    const { slug } = await routedApp({});
    const appId = await seedRoutedApp(attestAuthentication(), { providers: { [slug]: { operations: ["openai.chat"] } } });
    const install = await registerTestInstall(appId);
    const token = await tokenForInstall(install);
    fetchSpy.mockResolvedValue(Response.json({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    const url = `${ORIGIN}/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`;
    const body = new TextEncoder().encode(JSON.stringify({ model: "gpt-4o-mini", messages: [] }));
    const proof = await signedProof({ install, token, method: "POST", url, body, counter: 1 });
    const send = async (appVersion: string | null) => {
      const ctx = createExecutionContext();
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, "content-type": "application/json", "x-appattest-proof": proof };
      if (appVersion !== null) headers["x-app-version"] = appVersion;
      const response = await worker.fetch(new Request(url, { method: "POST", headers, body }), env, ctx);
      const json = (await response.json()) as { error?: { code?: string } };
      await waitOnExecutionContext(ctx);
      return { status: response.status, code: json.error?.code };
    };
    expect(await send(null)).toEqual({ status: 400, code: "invalid_request" });
    expect(await send("1.0")).toEqual({ status: 403, code: "attest_failed" });
    expect(fetchSpy).not.toHaveBeenCalled();
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


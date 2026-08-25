import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultProxyConfig, devToken, seedApp, seedServerApp } from "./helpers";

afterEach(() => vi.restoreAllMocks());

describe("UserLimiter", () => {
  it("enforces sliding RPM and resets outside the window", async () => {
    const limiter = env.USER_LIMITER.getByName("limiter:rpm");
    const now = Date.UTC(2026, 6, 23, 0, 0, 0);
    expect(await limiter.checkAndIncrement({ now, rpm: 2, rpd: 10, monthlyBudgetMicrousd: null })).toMatchObject({ allowed: true });
    expect(await limiter.checkAndIncrement({ now: now + 1, rpm: 2, rpd: 10, monthlyBudgetMicrousd: null })).toMatchObject({ allowed: true });
    expect(await limiter.checkAndIncrement({ now: now + 2, rpm: 2, rpd: 10, monthlyBudgetMicrousd: null })).toMatchObject({
      allowed: false,
      reason: "rate",
    });
    expect(await limiter.checkAndIncrement({ now: now + 60_001, rpm: 2, rpd: 10, monthlyBudgetMicrousd: null })).toMatchObject({
      allowed: true,
    });
  });

  it("enforces monthly budget and the instant blocked flag", async () => {
    const limiter = env.USER_LIMITER.getByName("limiter:budget");
    const now = Date.UTC(2026, 6, 23);
    await limiter.addCost(now, 100);
    expect(await limiter.checkAndIncrement({ now, rpm: 10, rpd: 10, monthlyBudgetMicrousd: 100 })).toEqual({
      allowed: false,
      reason: "budget",
    });
    await limiter.setBlocked(true);
    expect(await limiter.checkAndIncrement({ now, rpm: 10, rpd: 10, monthlyBudgetMicrousd: null })).toEqual({
      allowed: false,
      reason: "blocked",
    });
  });

  it("tracks UTC-day request status and monthly cost", async () => {
    const limiter = env.USER_LIMITER.getByName("limiter:status");
    const now = Date.UTC(2026, 6, 23, 12);
    await limiter.checkAndIncrement({ now, rpm: 10, rpd: 10, monthlyBudgetMicrousd: null });
    await limiter.addCost(now, 42);
    expect(await limiter.getStatus(now)).toEqual({ blocked: false, requestsToday: 1, monthlyCostMicrousd: 42 });
  });

  it("reschedules cleanup even when no request rows remain", async () => {
    const limiter = env.USER_LIMITER.getByName("limiter:empty-alarm");
    await limiter.getStatus(Date.now());
    await runInDurableObject(limiter, async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(limiter)).toBe(true);
    await runInDurableObject(limiter, async (_instance, state) => {
      const nextAlarm = await state.storage.getAlarm();
      expect(nextAlarm).not.toBeNull();
      expect(nextAlarm!).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    });
  });

  it("records a zero-token usage event when the limiter rejects a request", async () => {
    await seedApp("limiter-usage-event", { budgetUsd: 0 });
    const token = await devToken("limiter-usage-event");
    const path = "/v1/apps/limiter-usage-event/proxy/openai/v1/responses";
    const response = await exports.default.fetch(`https://example.test${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-app-version": "1.2.3",
      },
      body: JSON.stringify({ model: "gpt-5.6-terra", input: "hello" }),
    });
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "budget_exhausted" } });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const row = await env.DB.prepare(
        `SELECT provider, model, route, input_tokens, cached_input_tokens,
                cache_write_tokens, output_tokens, cost_usd, app_version, status, latency_ms
           FROM app_usage_event WHERE app_id = ? AND user_id = ?`,
      )
        .bind("limiter-usage-event", "user-1")
        .first<{
          provider: string;
          model: string;
          route: string;
          input_tokens: number;
          cached_input_tokens: number;
          cache_write_tokens: number;
          output_tokens: number;
          cost_usd: number;
          app_version: string | null;
          status: string;
          latency_ms: number | null;
        }>();
      if (row) {
        expect(row).toEqual({
          provider: "openai",
          model: "gpt-5.6",
          route: "openai/v1/responses",
          input_tokens: 0,
          cached_input_tokens: 0,
          cache_write_tokens: 0,
          output_tokens: 0,
          cost_usd: 0,
          app_version: "1.2.3",
          status: "blocked_budget",
          latency_ms: expect.any(Number),
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Blocked usage event was not persisted");
  });

  it("checks app-wide rate limits before per-user limits", async () => {
    const key = await seedServerApp("app-rate-limit", {
      limits: { rpm: 100, rpd: 1000, app_rpm: 1 },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }),
    );
    const request = (userId: string) =>
      exports.default.fetch(
        "https://example.test/v1/apps/app-rate-limit/proxy/openai/v1/responses",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
            "x-end-user-id": userId,
          },
          body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
        },
      );

    expect((await request("user-a")).status).toBe(200);
    const blocked = await request("user-b");
    expect(blocked.status).toBe(429);
    await expect(blocked.json()).resolves.toMatchObject({
      error: { code: "rate_limited" },
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const row = await env.DB.prepare(
        `SELECT model, route FROM app_usage_event
          WHERE app_id = ? AND user_id = ? AND status = 'blocked_rate'`,
      )
        .bind("app-rate-limit", "user-b")
        .first<{ model: string; route: string }>();
      if (row) {
        expect(row).toEqual({ model: "gpt-5.6-sol", route: "openai/v1/responses" });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Rate-limited usage event was not persisted");
  });

  it.each([
    {
      provider: "openai",
      path: "v1/responses",
      invalidBody: { model: "not-allowed", input: "hello" },
      validBody: { model: "gpt-5.6-sol", input: "hello" },
    },
    {
      provider: "anthropic",
      path: "v1/messages",
      invalidBody: { model: "not-allowed", messages: [] },
      validBody: { model: "claude-sonnet-5", messages: [], max_tokens: 32 },
    },
    {
      provider: "xai",
      path: "v1/responses",
      invalidBody: { model: "not-allowed", input: "hello" },
      validBody: { model: "grok-4.5", input: "hello" },
    },
    {
      provider: "gemini",
      path: "v1beta/models/not-allowed:generateContent",
      validPath: "v1beta/models/gemini-3.5-flash:generateContent",
      invalidBody: { contents: [] },
      validBody: { contents: [] },
    },
    {
      provider: "perplexity",
      path: "chat/completions",
      invalidBody: { model: "not-allowed", messages: [] },
      validBody: { model: "sonar", messages: [] },
    },
  ])("does not charge $provider validation failures against rate limits", async (testCase) => {
    const appId = `validation-limit-${testCase.provider}`;
    const proxy = defaultProxyConfig();
    proxy.perplexity = {
      allowed_paths: ["chat/completions"],
      allowed_models: ["sonar"],
      max_output_tokens: 128,
    };
    const key = await seedServerApp(appId, {
      proxy,
      limits: { rpm: 1, rpd: 100, app_rpm: 1, app_rpd: 100 },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ usage: { input_tokens: 1, output_tokens: 1 } }),
    );
    const request = (path: string, body: Record<string, unknown>) =>
      exports.default.fetch(
        `https://example.test/v1/apps/${appId}/proxy/${testCase.provider}/${path}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
            "x-end-user-id": "validation-user",
          },
          body: JSON.stringify(body),
        },
      );

    const invalid = await request(testCase.path, testCase.invalidBody);
    expect(invalid.status).toBe(403);
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: "model_not_allowed" },
    });

    const userLimiter = env.USER_LIMITER.getByName(`${appId}:validation-user`);
    const appLimiter = env.USER_LIMITER.getByName(appId);
    expect((await userLimiter.getStatus(Date.now())).requestsToday).toBe(0);
    expect((await appLimiter.getStatus(Date.now())).requestsToday).toBe(0);

    const valid = await request(testCase.validPath ?? testCase.path, testCase.validBody);
    expect(valid.status).toBe(200);
    await valid.text();
    expect((await userLimiter.getStatus(Date.now())).requestsToday).toBe(1);
    expect((await appLimiter.getStatus(Date.now())).requestsToday).toBe(1);
  });

  it("does not charge malformed proxy requests against rate limits", async () => {
    const appId = "malformed-limit";
    const key = await seedServerApp(appId, {
      limits: { rpm: 1, rpd: 100, app_rpm: 1, app_rpd: 100 },
    });

    const response = await exports.default.fetch(
      `https://example.test/v1/apps/${appId}/proxy/openai/v1/responses`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "x-end-user-id": "malformed-user",
        },
        body: "{",
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
    const userLimiter = env.USER_LIMITER.getByName(`${appId}:malformed-user`);
    const appLimiter = env.USER_LIMITER.getByName(appId);
    expect((await userLimiter.getStatus(Date.now())).requestsToday).toBe(0);
    expect((await appLimiter.getStatus(Date.now())).requestsToday).toBe(0);
  });

  it("mirrors cost to the app limiter for app-wide monthly budgets", async () => {
    const key = await seedServerApp("app-budget-limit", {
      appBudgetUsd: 0.00015,
      limits: { rpm: 100, rpd: 1000 },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ usage: { input_tokens: 6, output_tokens: 4 } }),
    );
    const request = (userId: string) =>
      exports.default.fetch(
        "https://example.test/v1/apps/app-budget-limit/proxy/openai/v1/responses",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
            "x-end-user-id": userId,
          },
          body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
        },
      );

    const first = await request("budget-user-a");
    expect(first.status).toBe(200);
    await first.text();
    const appLimiter = env.USER_LIMITER.getByName("app-budget-limit");
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if ((await appLimiter.getStatus(Date.now())).monthlyCostMicrousd === 150) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await appLimiter.getStatus(Date.now())).monthlyCostMicrousd).toBe(150);

    const blocked = await request("budget-user-b");
    expect(blocked.status).toBe(429);
    await expect(blocked.json()).resolves.toMatchObject({
      error: { code: "budget_exhausted" },
    });
  });
});

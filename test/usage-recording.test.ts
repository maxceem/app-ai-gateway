import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  persistUsageEvent,
  recordBlockedUsageEvent,
  recordUsageEvent,
  type UsageEvent,
} from "../src/core/usage";

afterEach(() => vi.restoreAllMocks());

/** A D1 binding that fails its first `failures` statements, then behaves normally. */
function flakyDatabase(failures: number): { database: D1Database; attempts: () => number } {
  let attempts = 0;
  const database = {
    prepare(query: string) {
      attempts += 1;
      if (attempts <= failures) throw new Error("D1 is unavailable");
      return env.DB.prepare(query);
    },
    batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
    exec: (query: string) => env.DB.exec(query),
  } as unknown as D1Database;
  return { database, attempts: () => attempts };
}

function withDatabase(database: D1Database): Env {
  return { ...env, DB: database };
}

function usageEvent(input: {
  appId: string;
  userId?: string;
  costUsd: number;
  appLevelLimitsEnabled?: boolean;
  eventId?: string;
  model?: string;
}): UsageEvent {
  const eventId = input.eventId ?? crypto.randomUUID();
  const userId = input.userId ?? "user-1";
  return {
    eventId,
    row: {
      eventId,
      appId: input.appId,
      userId,
      apiKeyId: null,
      providerType: "openai",
      providerId: "provider-test",
      providerSlug: "openai",
      model: input.model ?? "gpt-5.6-sol",
      route: "openai/v1/responses",
      endpointSlug: null,
      inputTokens: 6,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 4,
      costUsd: input.costUsd,
      appVersion: null,
      authMethod: "api_key",
      status: "ok",
      latencyMs: 12,
    },
    costMicrousd: Math.round(input.costUsd * 1_000_000),
    appLevelLimitsEnabled: input.appLevelLimitsEnabled ?? false,
  };
}

async function rowCount(appId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM app_usage_event WHERE app_id = ?")
    .bind(appId)
    .first<{ count: number }>();
  return row!.count;
}

function monthlyCost(name: string): Promise<number> {
  return env.USER_LIMITER.getByName(name)
    .getStatus(Date.now())
    .then((status) => status.monthlyCostMicrousd);
}

function errorCodes(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])).message as string);
}

describe("usage recording idempotency", () => {
  it("stores one row and charges once when the same event is recorded twice", async () => {
    const appId = "usage-record-twice";
    const event = usageEvent({ appId, costUsd: 0.000123, appLevelLimitsEnabled: true });

    await persistUsageEvent(env, event);
    await persistUsageEvent(env, event);

    expect(await rowCount(appId)).toBe(1);
    expect(await monthlyCost(`${appId}:user-1`)).toBe(123);
    expect(await monthlyCost(appId)).toBe(123);
  });

  it("converges without double charging when a re-run follows a failed insert", async () => {
    const appId = "usage-record-partial";
    const event = usageEvent({ appId, costUsd: 0.00005, appLevelLimitsEnabled: true });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    // The limiters settle, then D1 stays down for every retry: the event is
    // half-recorded, exactly the state a re-run has to repair.
    await persistUsageEvent(withDatabase(flakyDatabase(Number.MAX_SAFE_INTEGER).database), event);
    expect(await rowCount(appId)).toBe(0);
    expect(await monthlyCost(`${appId}:user-1`)).toBe(50);
    const failure = JSON.parse(String(errors.mock.calls.at(-1)?.[0]));
    expect(failure).toMatchObject({
      level: "error",
      message: "usage_record_failed",
      step: "usage_insert",
      eventId: event.eventId,
      appId,
      userId: "user-1",
    });

    await persistUsageEvent(env, event);

    expect(await rowCount(appId)).toBe(1);
    expect(await monthlyCost(`${appId}:user-1`)).toBe(50);
    expect(await monthlyCost(appId)).toBe(50);
  });

  it("retries a transient insert failure instead of losing the event", async () => {
    const appId = "usage-record-transient";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const flaky = flakyDatabase(1);

    await persistUsageEvent(withDatabase(flaky.database), usageEvent({ appId, costUsd: 0.00002 }));

    expect(flaky.attempts()).toBe(2);
    expect(await rowCount(appId)).toBe(1);
    expect(await monthlyCost(`${appId}:user-1`)).toBe(20);
    expect(errorCodes(errors)).not.toContain("usage_record_failed");
  });

  /**
   * The billability gate refuses unpriced models before they proxy, so reaching
   * the recorder means a price was deleted inside the configuration cache
   * window. Nothing computed a cost for the request, so recording it as
   * `computed` at $0 would make it indistinguishable from a genuinely free one:
   * the cost is unknown, and unknown is what the column has to say.
   */
  it("records an unpriced model as unresolved, not as a computed zero", async () => {
    const appId = "usage-record-unpriced";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await recordUsageEvent({
      env,
      stream: new Response(JSON.stringify({ usage: { input_tokens: 5, output_tokens: 7 } })).body,
      contentType: "application/json",
      appId,
      userId: "user-1",
      authMethod: "api_key",
      appLevelLimitsEnabled: false,
      provider: "openai",
      providerId: "provider-test",
      providerSlug: "openai",
      model: "gpt-model-nobody-priced",
      route: "openai/v1/responses",
      appVersion: null,
      status: "ok",
      latencyMs: 9,
    });

    const row = await env.DB.prepare(
      `SELECT event_id, cost_usd, cost_source, reported_cost_usd, input_tokens, output_tokens
         FROM app_usage_event WHERE app_id = ?`,
    )
      .bind(appId)
      .first<{
        event_id: string | null;
        cost_usd: number;
        cost_source: string | null;
        reported_cost_usd: number | null;
        input_tokens: number;
        output_tokens: number;
      }>();
    // The tokens were readable and are kept; only the cost is missing.
    expect(row).toMatchObject({
      cost_usd: 0,
      cost_source: "unresolved",
      reported_cost_usd: null,
      input_tokens: 5,
      output_tokens: 7,
    });
    expect(row?.event_id).toEqual(expect.any(String));
    const logged = errors.mock.calls.map((call) => JSON.parse(String(call[0])));
    // The mispricing alert stays: it names the model an operator has to fix.
    expect(logged.find((entry) => entry.message === "usage_unpriced_model")).toMatchObject({
      level: "error",
      appId,
      provider: "openai",
      model: "gpt-model-nobody-priced",
      eventId: row?.event_id,
    });
    // And the event surfaces as unresolved, with the reason it is unresolved.
    expect(logged.find((entry) => entry.message === "usage_unresolved_cost")).toMatchObject({
      level: "error",
      appId,
      model: "gpt-model-nobody-priced",
      reason: "no_local_price",
      eventId: row?.event_id,
    });
    expect(errorCodes(errors)).not.toContain("usage_record_failed");
  });

  it("logs the billed duration for a time-priced model", async () => {
    const appId = "usage-record-audio";
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});

    await recordUsageEvent({
      env,
      stream: new Response(JSON.stringify({ text: "hello", duration: 90 })).body,
      contentType: "application/json",
      appId,
      userId: "user-1",
      authMethod: "api_key",
      appLevelLimitsEnabled: false,
      provider: "openai",
      providerId: "provider-test",
      providerSlug: "openai",
      // Priced per minute, so tokens stay zero and duration is the only input
      // the cost can be checked against.
      model: "whisper-1",
      route: "openai/v1/audio/transcriptions",
      appVersion: null,
      status: "ok",
      latencyMs: 40,
    });

    const recorded = logs.mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .find((entry) => entry.message === "usage_recorded" && entry.appId === appId);
    expect(recorded).toMatchObject({
      level: "info",
      model: "whisper-1",
      audioSeconds: 90,
      inputTokens: 0,
      outputTokens: 0,
    });
    // 90 seconds at $0.006 per minute.
    expect(recorded?.costUsd).toBeCloseTo(0.009, 8);
    expect(await monthlyCost(`${appId}:user-1`)).toBe(9000);
    const row = await env.DB.prepare("SELECT cost_usd FROM app_usage_event WHERE app_id = ?")
      .bind(appId)
      .first<{ cost_usd: number }>();
    expect(row?.cost_usd).toBeCloseTo(0.009, 8);
  });

  it("marks a successful response with an unreadable usage shape as unresolved", async () => {
    const appId = "usage-record-unresolved";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await recordUsageEvent({
      env,
      // Cohere's shape: the request proxied fine, and nothing here is priceable.
      stream: new Response(
        JSON.stringify({ text: "hello", usage: { billed_units: { input_tokens: 120 } } }),
      ).body,
      contentType: "application/json",
      appId,
      userId: "user-1",
      authMethod: "api_key",
      appLevelLimitsEnabled: false,
      provider: "openai",
      providerId: "provider-test",
      providerSlug: "openai",
      model: "gpt-5.6-sol",
      route: "openai/v1/responses",
      appVersion: null,
      status: "ok",
      latencyMs: 11,
    });

    const row = await env.DB.prepare(
      "SELECT event_id, cost_source, cost_usd, input_tokens, output_tokens, status FROM app_usage_event WHERE app_id = ?",
    )
      .bind(appId)
      .first<{
        event_id: string | null;
        cost_source: string | null;
        cost_usd: number;
        input_tokens: number;
        output_tokens: number;
        status: string;
      }>();
    expect(row).toMatchObject({
      cost_source: "unresolved",
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      // The client got its 200; only the metering is in doubt.
      status: "ok",
    });
    const unresolved = errors.mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .find((entry) => entry.message === "usage_unresolved_cost");
    expect(unresolved).toMatchObject({
      level: "error",
      appId,
      provider: "openai",
      model: "gpt-5.6-sol",
      route: "openai/v1/responses",
      eventId: row?.event_id,
    });
  });

  it("records a provider-reported zero as a measured cost, not an unresolved one", async () => {
    const appId = "usage-record-reported-zero";

    await recordUsageEvent({
      env,
      stream: new Response(JSON.stringify({ usage: { input_tokens: 0, output_tokens: 0 } })).body,
      contentType: "application/json",
      appId,
      userId: "user-1",
      authMethod: "api_key",
      appLevelLimitsEnabled: false,
      provider: "openai",
      providerId: "provider-test",
      providerSlug: "openai",
      model: "gpt-5.6-sol",
      route: "openai/v1/responses",
      appVersion: null,
      status: "ok",
      latencyMs: 5,
    });

    const row = await env.DB.prepare("SELECT cost_source, cost_usd FROM app_usage_event WHERE app_id = ?")
      .bind(appId)
      .first<{ cost_source: string | null; cost_usd: number }>();
    expect(row).toMatchObject({ cost_source: "computed", cost_usd: 0 });
  });

  it("leaves a failed provider response computed, since an error owes no usage", async () => {
    const appId = "usage-record-provider-error";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await recordUsageEvent({
      env,
      stream: new Response(JSON.stringify({ error: { message: "rate limited" } })).body,
      contentType: "application/json",
      appId,
      userId: "user-1",
      authMethod: "api_key",
      appLevelLimitsEnabled: false,
      provider: "openai",
      providerId: "provider-test",
      providerSlug: "openai",
      model: "gpt-5.6-sol",
      route: "openai/v1/responses",
      appVersion: null,
      status: "provider_error",
      latencyMs: 7,
    });

    const row = await env.DB.prepare("SELECT cost_source, cost_usd FROM app_usage_event WHERE app_id = ?")
      .bind(appId)
      .first<{ cost_source: string | null; cost_usd: number }>();
    expect(row).toMatchObject({ cost_source: "computed", cost_usd: 0 });
    expect(errorCodes(errors)).not.toContain("usage_unresolved_cost");
  });

  it("leaves a blocked event without a cost source, having metered nothing", async () => {
    const appId = "usage-record-blocked-source";
    await recordBlockedUsageEvent({
      env,
      appId,
      userId: "user-1",
      authMethod: "api_key",
      provider: "openai",
      providerId: "provider-test",
      providerSlug: "openai",
      model: "gpt-5.6-sol",
      route: "openai/v1/responses",
      appVersion: null,
      status: "blocked_rate",
      latencyMs: 2,
    });

    const row = await env.DB.prepare("SELECT cost_source FROM app_usage_event WHERE app_id = ?")
      .bind(appId)
      .first<{ cost_source: string | null }>();
    expect(row?.cost_source).toBeNull();
  });

  it("gives blocked events an identity that makes a replay a no-op", async () => {
    const appId = "usage-record-blocked";
    await recordBlockedUsageEvent({
      env,
      appId,
      userId: "user-1",
      authMethod: "api_key",
      provider: "openai",
      providerId: "provider-test",
      providerSlug: "openai",
      model: "gpt-5.6-sol",
      route: "openai/v1/responses",
      appVersion: null,
      status: "blocked_budget",
      latencyMs: 3,
    });

    const stored = await env.DB.prepare(
      "SELECT event_id, model, status FROM app_usage_event WHERE app_id = ?",
    )
      .bind(appId)
      .first<{ event_id: string | null; model: string; status: string }>();
    expect(stored?.event_id).toEqual(expect.any(String));
    expect(stored).toMatchObject({ model: "gpt-5.6-sol", status: "blocked_budget" });

    // Replaying the stored identity must not add a second row or rewrite the first.
    await persistUsageEvent(
      env,
      usageEvent({ appId, costUsd: 0, eventId: stored!.event_id!, model: "replayed-model" }),
    );

    expect(await rowCount(appId)).toBe(1);
    const after = await env.DB.prepare("SELECT model FROM app_usage_event WHERE app_id = ?")
      .bind(appId)
      .first<{ model: string }>();
    expect(after?.model).toBe("gpt-5.6-sol");
  });
});

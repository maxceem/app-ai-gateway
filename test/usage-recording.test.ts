import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeUpstreamBody, type ObservedBody } from "../src/usage/body-observer";
import {
  persistUsageEvent,
  recordUsageEvent,
  type UsageEvent,
} from "../src/usage/usage-record";
import { seedApp, testAttribution, testIdentity } from "./helpers";
import { microusd, shippedRates } from "./shipped-rates";
import { recordRejectionEvent } from "../src/diagnostics/rejection-events";
import { TEST_ORGANIZATION_ID } from "./apply-migrations";
import { monthlySpendMicrousd } from "../src/usage/app-usage-accounting";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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

/** What the observer sees of a body the client read to the end, through the real pipe. */
function observedBody(text: string): Promise<ObservedBody> {
  const { stream, observed } = observeUpstreamBody(new Response(text).body!);
  return new Response(stream).arrayBuffer().then(() => observed);
}

function withDatabase(database: D1Database): Env {
  return { ...env, DB: database };
}

function usageEvent(input: {
  appId: string;
  userId?: string;
  costUsd: number;
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
      organizationId: TEST_ORGANIZATION_ID,
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
      createdAt: new Date().toISOString(),
    },
  };
}

async function rowCount(appId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM app_usage_event WHERE app_id = ?")
    .bind(appId)
    .first<{ count: number }>();
  return row!.count;
}

/** The month's spend for a limiter name: `app` or `app:user`. */
function monthlyCost(name: string): Promise<number> {
  const [appId, userKey] = name.split(":");
  return monthlySpendMicrousd(
    env.DB,
    { appId: appId!, userKey: userKey ?? null },
    new Date().toISOString().slice(0, 7),
  );
}

function errorCodes(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])).message as string);
}

describe("usage recording idempotency", () => {
  it("stores one row and charges once when the same event is recorded twice", async () => {
    const appId = "usage-record-twice";
    const event = usageEvent({ appId, costUsd: 0.000123 });

    await persistUsageEvent(env, event);
    await persistUsageEvent(env, event);

    expect(await rowCount(appId)).toBe(1);
    expect(await monthlyCost(`${appId}:user-1`)).toBe(123);
  });

  it("does not project spend until a re-run successfully stores the event", async () => {
    const appId = "usage-record-partial";
    const event = usageEvent({ appId, costUsd: 0.00005 });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    // D1 stays down for every retry. No limiter may claim spend for an event
    // that never became a canonical row.
    await persistUsageEvent(withDatabase(flakyDatabase(Number.MAX_SAFE_INTEGER).database), event);
    expect(await rowCount(appId)).toBe(0);
    expect(await monthlyCost(`${appId}:user-1`)).toBe(0);
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
  });

  it("retries a transient insert failure instead of losing the event", async () => {
    const appId = "usage-record-transient";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const flaky = flakyDatabase(1);

    await persistUsageEvent(withDatabase(flaky.database), usageEvent({ appId, costUsd: 0.00002 }));

    // Two insert attempts; the insert's own trigger moved the totals.
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
      organizationId: "operator-test-organization",
      env,
      observed: observedBody(JSON.stringify({ usage: { input_tokens: 5, output_tokens: 7 } })),
      contentType: "application/json",
      identity: testIdentity({ appId, userId: "user-1" }),
      attribution: testAttribution({ model: "gpt-model-nobody-priced", route: "openai/v1/responses" }),
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
      organizationId: "operator-test-organization",
      env,
      observed: observedBody(JSON.stringify({ text: "hello", duration: 90 })),
      contentType: "application/json",
      identity: testIdentity({ appId, userId: "user-1" }),
      attribution: testAttribution({
        // Priced per minute, so tokens stay zero and duration is the only input
        // the cost can be checked against.
        model: "whisper-1",
        route: "openai/v1/audio/transcriptions",
        apiStyle: "audio_transcription",
      }),
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
    // 90 seconds at the per-minute rate.
    const cost = (90 / 60) * shippedRates("openai", "whisper-1").per_minute;
    expect(recorded?.costUsd).toBeCloseTo(cost, 12);
    expect(await monthlyCost(`${appId}:user-1`)).toBe(microusd(cost));
    const row = await env.DB.prepare("SELECT cost_usd FROM app_usage_event WHERE app_id = ?")
      .bind(appId)
      .first<{ cost_usd: number }>();
    expect(row?.cost_usd).toBeCloseTo(cost, 12);
  });

  it("prices a token-priced transcription from the tokens it reports", async () => {
    const appId = "usage-record-audio-tokens";

    await recordUsageEvent({
      organizationId: "operator-test-organization",
      env,
      observed: observedBody(JSON.stringify({
        text: "hello",
        usage: { type: "tokens", input_tokens: 140, output_tokens: 12, total_tokens: 152 },
      })),
      contentType: "application/json",
      identity: testIdentity({ appId, userId: "user-1" }),
      attribution: testAttribution({
        model: "gpt-4o-transcribe",
        route: "openai/v1/audio/transcriptions",
        apiStyle: "audio_transcription",
      }),
      appVersion: null,
      status: "ok",
      latencyMs: 40,
    });

    const rates = shippedRates("openai", "gpt-4o-transcribe");
    const cost = (140 * rates.input + 12 * rates.output) / 1e6;
    const row = await env.DB.prepare(
      "SELECT cost_source, cost_usd, input_tokens, output_tokens FROM app_usage_event WHERE app_id = ?",
    )
      .bind(appId)
      .first<{ cost_source: string; cost_usd: number; input_tokens: number; output_tokens: number }>();
    expect(row).toMatchObject({ cost_source: "computed", input_tokens: 140, output_tokens: 12 });
    expect(row?.cost_usd).toBeCloseTo(cost, 12);
    expect(await monthlyCost(`${appId}:user-1`)).toBe(microusd(cost));
  });

  it("marks a transcription that reports only another unit as unresolved", async () => {
    const appId = "usage-record-audio-mismeasured";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await recordUsageEvent({
      organizationId: "operator-test-organization",
      env,
      // Tokens, for a model billed by the minute: pricing them would read $0.
      observed: observedBody(JSON.stringify({
        text: "hello",
        usage: { type: "tokens", input_tokens: 140, output_tokens: 12 },
      })),
      contentType: "application/json",
      identity: testIdentity({ appId, userId: "user-1" }),
      attribution: testAttribution({
        model: "whisper-1",
        route: "openai/v1/audio/transcriptions",
        apiStyle: "audio_transcription",
      }),
      appVersion: null,
      status: "ok",
      latencyMs: 40,
    });

    const row = await env.DB.prepare(
      "SELECT event_id, cost_source, cost_usd FROM app_usage_event WHERE app_id = ?",
    )
      .bind(appId)
      .first<{ event_id: string; cost_source: string; cost_usd: number }>();
    expect(row).toMatchObject({ cost_source: "unresolved", cost_usd: 0 });
    const unresolved = errors.mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .find((entry) => entry.message === "usage_unresolved_cost");
    expect(unresolved).toMatchObject({
      appId,
      model: "whisper-1",
      reason: "no_priced_measure",
      eventId: row?.event_id,
    });
  });

  it("marks a successful response with an unreadable usage shape as unresolved", async () => {
    const appId = "usage-record-unresolved";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await recordUsageEvent({
      organizationId: "operator-test-organization",
      env,
      // Cohere's shape: the request proxied fine, and nothing here is priceable.
      observed: observedBody(
        JSON.stringify({ text: "hello", usage: { billed_units: { input_tokens: 120 } } }),
      ),
      contentType: "application/json",
      identity: testIdentity({ appId, userId: "user-1" }),
      attribution: testAttribution(),
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
      organizationId: "operator-test-organization",
      env,
      observed: observedBody(JSON.stringify({ usage: { input_tokens: 0, output_tokens: 0 } })),
      contentType: "application/json",
      identity: testIdentity({ appId, userId: "user-1" }),
      attribution: testAttribution(),
      appVersion: null,
      status: "ok",
      latencyMs: 5,
    });

    const row = await env.DB.prepare("SELECT cost_source, cost_usd FROM app_usage_event WHERE app_id = ?")
      .bind(appId)
      .first<{ cost_source: string | null; cost_usd: number }>();
    expect(row).toMatchObject({ cost_source: "computed", cost_usd: 0 });
  });

  it("reports the observer windows only for a body too big to keep whole", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const usage = '"usage":{"prompt_tokens":11,"completion_tokens":3}';
    const record = (appId: string, body: string) =>
      recordUsageEvent({
        organizationId: "operator-test-organization",
        env,
        observed: observedBody(body),
        contentType: "application/json",
        identity: testIdentity({ appId, userId: "user-1" }),
        attribution: testAttribution(),
        appVersion: null,
        status: "ok",
        latencyMs: 9,
      });

    await record("usage-record-small-body", `{"id":"resp_1",${usage}}`);
    await record("usage-record-large-body", `{"filler":"${"x".repeat(6 * 1024 * 1024)}",${usage}}`);

    const truncated = logs.mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .filter((entry) => entry.message === "usage_observer_truncated");
    // One line, for the one body that did not fit; a normal response says
    // nothing, so the count is a usable signal on its own.
    expect(truncated).toHaveLength(1);
    expect(truncated[0]).toMatchObject({ level: "info", appId: "usage-record-large-body" });
    expect(truncated[0].totalBytes).toBeGreaterThan(6 * 1024 * 1024);
    // Both were still priced off the usage at the end of the body.
    for (const appId of ["usage-record-small-body", "usage-record-large-body"]) {
      const row = await env.DB
        .prepare("SELECT cost_source, input_tokens, output_tokens FROM app_usage_event WHERE app_id = ?")
        .bind(appId)
        .first<{ cost_source: string; input_tokens: number; output_tokens: number }>();
      expect(row).toMatchObject({ cost_source: "computed", input_tokens: 11, output_tokens: 3 });
    }
  });

  it("leaves a failed provider response computed, since an error owes no usage", async () => {
    const appId = "usage-record-provider-error";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    await recordUsageEvent({
      organizationId: "operator-test-organization",
      env,
      observed: observedBody(JSON.stringify({ error: { message: "rate limited" } })),
      contentType: "application/json",
      identity: testIdentity({ appId, userId: "user-1" }),
      attribution: testAttribution(),
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

  it("records refusal samples separately from usage, without accounting fields", async () => {
    const appId = "usage-record-blocked-source";
    await seedApp(appId);
    await recordRejectionEvent({
      env,
      identity: testIdentity({ appId, userId: "user-1" }),
      attribution: testAttribution(),
      appVersion: null,
      reason: "blocked_app_rate",
      scope: "app",
      latencyMs: 2,
    });
    expect(await rowCount(appId)).toBe(0);
    const row = await env.DB.prepare("SELECT event_id, reason, scope, model FROM app_rejection_event WHERE app_id = ?")
      .bind(appId).first<{ event_id: string; reason: string; scope: string; model: string }>();
    expect(row).toMatchObject({ event_id: expect.any(String), reason: "blocked_app_rate", scope: "app", model: "gpt-5.6-sol" });
    await env.DB.prepare(
      `INSERT INTO app_rejection_event(event_id,app_id,reason)
       VALUES (?, ?, 'blocked_user') ON CONFLICT(event_id) DO NOTHING`,
    ).bind(row!.event_id, appId).run();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM app_rejection_event WHERE app_id=?")
      .bind(appId).first<{ n: number }>())?.n).toBe(1);
  });

  it("samples by authenticated identity per minute, independent of route and reason", async () => {
    const anchor = Math.floor((Date.now() + 86_400_000) / 60_000) * 60_000 + 10_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(anchor);
    const appId = "usage-record-blocked-sampled";
    const otherApp = "usage-record-blocked-sampled-other";
    await seedApp(appId);
    await seedApp(otherApp);
    const blocked = (
      userId: string | null,
      reason: "blocked_user" | "blocked_app_rate" = "blocked_user",
      overrides: { appId?: string; apiKeyId?: string; model?: string; version?: string } = {},
    ) =>
      recordRejectionEvent({
        env,
        identity: testIdentity({ appId: overrides.appId ?? appId, userId, apiKeyId: overrides.apiKeyId }),
        attribution: testAttribution({ route: `${userId}/${reason}`, model: overrides.model ?? "gpt-5.6-sol" }),
        appVersion: overrides.version ?? `release-${"x".repeat(100)}`,
        reason,
        scope: "user",
        latencyMs: 2,
      });
    await blocked("sampled-user");
    await blocked("sampled-user", "blocked_app_rate", { model: "varied-model", version: "varied-version" });
    await Promise.all([blocked("concurrent-user"), blocked("concurrent-user", "blocked_app_rate")]);
    await blocked(null, "blocked_user", { apiKeyId: "key-a" });
    await blocked(null, "blocked_app_rate", { apiKeyId: "key-a", model: "varied-key-model" });
    await blocked(null, "blocked_user", { apiKeyId: "key-b" });
    await blocked("sampled-user", "blocked_user", { appId: otherApp });
    vi.setSystemTime(anchor + 60_000);
    await blocked("sampled-user");
    const rows = await env.DB.prepare("SELECT user_id, reason, app_version FROM app_rejection_event WHERE app_id = ? ORDER BY id")
      .bind(appId).all<{ user_id: string | null; reason: string; app_version: string }>();
    expect(rows.results).toHaveLength(5);
    expect(rows.results.filter((row) => row.user_id === "sampled-user")).toHaveLength(2);
    expect(rows.results.filter((row) => row.user_id === "concurrent-user")).toHaveLength(1);
    expect(rows.results.filter((row) => row.user_id === null)).toHaveLength(2);
    expect(rows.results[0]?.app_version).toBe(`release-${"x".repeat(56)}`);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM app_rejection_event WHERE app_id=?")
      .bind(otherApp).first<{ n: number }>())?.n).toBe(1);
  });

  it("drops diagnostics when the sampler is unavailable", async () => {
    const appId = "usage-record-blocked-sampler-down";
    await seedApp(appId);
    let prepares = 0;
    const countedDatabase = {
      prepare(query: string) { prepares++; return env.DB.prepare(query); },
    } as unknown as D1Database;
    const testEnv = {
      ...env,
      DB: countedDatabase,
      ENDPOINT_RATE_LIMITER: {
        getByName: () => ({ check: () => Promise.reject(new Error("sampler unavailable")) }),
      },
    } as unknown as Env;
    await recordRejectionEvent({
      env: testEnv,
      identity: testIdentity({ appId, userId: "user-1", apiKeyId: "unavailable-key" }),
      attribution: testAttribution(),
      appVersion: null,
      reason: "blocked_app_rate",
      scope: "user",
      latencyMs: 2,
    });
    expect(prepares).toBe(0);
    expect(await env.DB.prepare("SELECT id FROM app_rejection_event WHERE app_id = ?").bind(appId).first()).toBeNull();
  });

  it("does no D1 work when the identity's minute is already sampled", async () => {
    const appId = "usage-record-blocked-sample-spent";
    await seedApp(appId);
    let prepares = 0;
    const testEnv = {
      ...env,
      DB: { prepare(query: string) { prepares++; return env.DB.prepare(query); } },
      ENDPOINT_RATE_LIMITER: {
        getByName: () => ({ check: () => Promise.resolve({ allowed: false, retryAfterSeconds: 30 }) }),
      },
    } as unknown as Env;
    await recordRejectionEvent({
      env: testEnv,
      identity: testIdentity({ appId, userId: null, apiKeyId: "spent-key" }),
      attribution: testAttribution(),
      appVersion: null,
      reason: "blocked_app_rate",
      scope: "app",
      latencyMs: 2,
    });
    expect(prepares).toBe(0);
  });

  it("cannot restore a deleted app's diagnostics from a late waitUntil task", async () => {
    const appId = "usage-record-blocked-deleted";
    await seedApp(appId);
    await env.DB.prepare("DELETE FROM app WHERE id = ?").bind(appId).run();
    await recordRejectionEvent({
      env,
      identity: testIdentity({ appId, userId: "user-1" }),
      attribution: testAttribution(),
      appVersion: null,
      reason: "blocked_user",
      scope: "user",
      latencyMs: 2,
    });
    expect(await env.DB.prepare("SELECT id FROM app_rejection_event WHERE app_id = ?").bind(appId).first()).toBeNull();
  });
});

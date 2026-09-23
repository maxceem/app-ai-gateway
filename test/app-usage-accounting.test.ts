import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { monthlySpendMicrousd, pruneSettledUsageSpend } from "../src/core/app-usage-accounting";
import { wholeBody, type ObservedBody } from "../src/core/body-observer";
import {
  persistUsageEvent,
  recordUsageEvent,
  type UsageEvent,
} from "../src/core/usage-record";
import { testAttribution, testIdentity } from "./helpers";
import app, { MAINTENANCE_CRON } from "../src/index";

const PREFIX = "accounting-";

afterEach(async () => {
  vi.useRealTimers();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM app_usage_event WHERE app_id LIKE ?").bind(`${PREFIX}%`),
    env.DB.prepare("DELETE FROM app_usage_spend WHERE app_id LIKE ?").bind(`${PREFIX}%`),
  ]);
});

async function insertEvent(input: {
  appId: string;
  userId: string | null;
  costUsd: number;
  createdAt?: string;
  eventId?: string;
}): Promise<string> {
  const eventId = input.eventId ?? crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO app_usage_event(
       event_id, app_id, user_id, provider_type, model, route,
       cost_usd, status, created_at
     ) VALUES (?, ?, ?, 'openai', 'gpt-5.6-sol', 'openai/v1/responses', ?, 'ok', ?)`,
  ).bind(
    eventId,
    input.appId,
    input.userId,
    input.costUsd,
    input.createdAt ?? new Date().toISOString(),
  ).run();
  return eventId;
}

async function spend(appId: string): Promise<Array<{
  scope: string;
  user_key: string;
  month: string;
  microusd: number;
}>> {
  const { results } = await env.DB.prepare(
    `SELECT scope, user_key, month, microusd
     FROM app_usage_spend WHERE app_id = ? ORDER BY scope, user_key`,
  ).bind(appId).all<{
    scope: string;
    user_key: string;
    month: string;
    microusd: number;
  }>();
  return results;
}

describe("app usage accounting", () => {
  it("atomically tracks app and user totals through duplicate, decrease, zero, and raw deletion", async () => {
    const appId = `${PREFIX}triggers`;
    const eventId = await insertEvent({ appId, userId: "", costUsd: 0.000184 });
    await env.DB.prepare(
      `INSERT OR IGNORE INTO app_usage_event(
         event_id, app_id, user_id, provider_type, model, route, cost_usd, status
       ) VALUES (?, ?, '', 'openai', 'gpt-5.6-sol', 'openai/v1/responses', 9, 'ok')`,
    ).bind(eventId, appId).run();

    expect(await spend(appId)).toEqual([
      expect.objectContaining({ scope: "app", user_key: "", microusd: 184 }),
      expect.objectContaining({ scope: "user", user_key: "", microusd: 184 }),
    ]);

    await env.DB.prepare("UPDATE app_usage_event SET cost_usd = 0.000037 WHERE event_id = ?")
      .bind(eventId).run();
    expect((await spend(appId)).map((row) => row.microusd)).toEqual([37, 37]);
    await env.DB.prepare("UPDATE app_usage_event SET cost_usd = 0 WHERE event_id = ?")
      .bind(eventId).run();
    expect((await spend(appId)).map((row) => row.microusd)).toEqual([0, 0]);
    await env.DB.prepare("UPDATE app_usage_event SET cost_usd = 0.000009 WHERE event_id = ?")
      .bind(eventId).run();
    await env.DB.prepare("DELETE FROM app_usage_event WHERE event_id = ?").bind(eventId).run();
    expect((await spend(appId)).map((row) => row.microusd)).toEqual([9, 9]);
  });

  it("creates no invented user scope for a null user", async () => {
    const appId = `${PREFIX}null-user`;
    await insertEvent({ appId, userId: null, costUsd: 0.000011 });
    expect(await spend(appId)).toEqual([
      expect.objectContaining({ scope: "app", user_key: "", microusd: 11 }),
    ]);
  });

  it("reads a scope's month as the one row the triggers keep", async () => {
    const appId = `${PREFIX}read`;
    await insertEvent({ appId, userId: "u1", costUsd: 0.000030, createdAt: "2026-07-10T00:00:00.000Z" });
    await insertEvent({ appId, userId: "u2", costUsd: 0.000012, createdAt: "2026-07-11T00:00:00.000Z" });
    expect(await monthlySpendMicrousd(env.DB, { appId, userKey: null }, "2026-07")).toBe(42);
    expect(await monthlySpendMicrousd(env.DB, { appId, userKey: "u1" }, "2026-07")).toBe(30);
    expect(await monthlySpendMicrousd(env.DB, { appId, userKey: "u3" }, "2026-07")).toBe(0);
    expect(await monthlySpendMicrousd(env.DB, { appId, userKey: null }, "2026-08")).toBe(0);
  });

  it("runs nightly maintenance on its own trigger and nothing on any other", async () => {
    const waitUntil = vi.fn();
    const ctx = { waitUntil, passThroughOnException: () => {} } as unknown as ExecutionContext;
    app.scheduled({ cron: "0 * * * *", scheduledTime: Date.now() } as ScheduledController, env, ctx);
    expect(waitUntil).not.toHaveBeenCalled();
    const run = createExecutionContext();
    app.scheduled({ cron: MAINTENANCE_CRON, scheduledTime: Date.now() } as ScheduledController, env, run);
    await waitOnExecutionContext(run);
  });

  it("files a UsageEvent's spend under its own fixed timestamp's month", async () => {
    const appId = `${PREFIX}month`;
    const createdAt = "2026-07-31T23:59:59.900Z";
    const eventId = crypto.randomUUID();
    const event: UsageEvent = {
      eventId,
      row: {
        eventId,
        appId,
        userId: "user-1",
        providerType: "openai",
        model: "gpt-5.6-sol",
        route: "openai/v1/responses",
        costUsd: 0.000041,
        status: "ok",
        createdAt,
      },
    };
    await persistUsageEvent(env, event);

    expect((await spend(appId)).map((row) => row.month)).toEqual(["2026-07", "2026-07"]);
    expect(await monthlySpendMicrousd(env.DB, { appId, userKey: null }, "2026-07")).toBe(41);
    expect(await monthlySpendMicrousd(env.DB, { appId, userKey: null }, "2026-08")).toBe(0);
  });

  it("captures recordUsageEvent time before awaiting an observer across month rollover", async () => {
    const appId = `${PREFIX}observed-month`;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-07-31T23:59:59.900Z");
    let resolveObserved!: (body: ObservedBody) => void;
    const observed = new Promise<ObservedBody>((resolve) => {
      resolveObserved = resolve;
    });
    const recording = recordUsageEvent({
      env,
      organizationId: "operator-test-organization",
      observed,
      contentType: "application/json",
      identity: testIdentity({ appId, userId: null }),
      attribution: testAttribution(),
      appVersion: null,
      status: "ok",
      latencyMs: 1,
    });
    await Promise.resolve();
    vi.setSystemTime("2026-08-01T00:00:00.100Z");
    const text = JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } });
    resolveObserved({ ...wholeBody(text), totalBytes: text.length, aborted: false });
    await recording;

    const stored = await env.DB.prepare(
      "SELECT created_at FROM app_usage_event WHERE app_id = ?",
    ).bind(appId).first<{ created_at: string }>();
    expect(stored?.created_at).toBe("2026-07-31T23:59:59.900Z");
    expect((await spend(appId)).map((row) => row.month)).toEqual(["2026-07"]);
  });

  it("prunes old aggregates only after their raw month is gone", async () => {
    const appId = `${PREFIX}prune`;
    const createdAt = "2025-01-15T12:00:00.000Z";
    await insertEvent({ appId, userId: null, costUsd: 0.000051, createdAt });

    // A raw event a reprice could still move keeps its month's total.
    expect(await pruneSettledUsageSpend(env.DB, "2026-01")).toBe(0);
    expect(await spend(appId)).toHaveLength(1);
    await env.DB.prepare("DELETE FROM app_usage_event WHERE app_id = ?").bind(appId).run();
    expect(await pruneSettledUsageSpend(env.DB, "2026-01")).toBe(1);
    expect(await spend(appId)).toEqual([]);
  });

  it("atomically refuses a late event after its account was deleted", async () => {
    const appId = `${PREFIX}deleted-owner`;
    await expect(env.DB.prepare(
      `INSERT INTO app_usage_event(
         event_id, app_id, organization_id, provider_type, model, route, cost_usd, status
       ) VALUES (?, ?, 'deleted-account', 'openai', 'gpt-5.6-sol',
         'openai/v1/responses', 0.001, 'ok')`,
    ).bind(crypto.randomUUID(), appId).run()).rejects.toThrow(/organization no longer exists/u);
    expect(await spend(appId)).toEqual([]);
  });
});

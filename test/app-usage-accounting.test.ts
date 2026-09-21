import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deliverUsageSpend,
  pruneSettledUsageSpend,
  projectUsageEventSpend,
  recoverPendingUsageSpend,
  USAGE_SPEND_RECOVERY_BATCH,
} from "../src/core/app-usage-accounting";
import {
  persistUsageEvent,
  recordUsageEvent,
  wholeBody,
  type ObservedBody,
  type UsageEvent,
} from "../src/core/usage";
import { DIRECT_ROUTE } from "../src/core/routes";
import app, { scheduledMaintenance } from "../src/index";

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
  revision: number;
  pending: number;
}>> {
  const { results } = await env.DB.prepare(
    `SELECT scope, user_key, month, microusd, revision, pending
     FROM app_usage_spend WHERE app_id = ? ORDER BY scope, user_key`,
  ).bind(appId).all<{
    scope: string;
    user_key: string;
    month: string;
    microusd: number;
    revision: number;
    pending: number;
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
      expect.objectContaining({ scope: "app", user_key: "", microusd: 184, revision: 1 }),
      expect.objectContaining({ scope: "user", user_key: "", microusd: 184, revision: 1 }),
    ]);

    await env.DB.prepare("UPDATE app_usage_event SET cost_usd = 0.000037 WHERE event_id = ?")
      .bind(eventId).run();
    expect((await spend(appId)).map((row) => [row.microusd, row.revision]))
      .toEqual([[37, 2], [37, 2]]);
    await env.DB.prepare("UPDATE app_usage_event SET cost_usd = 0 WHERE event_id = ?")
      .bind(eventId).run();
    expect((await spend(appId)).map((row) => [row.microusd, row.revision]))
      .toEqual([[0, 3], [0, 3]]);
    await env.DB.prepare("UPDATE app_usage_event SET cost_usd = 0.000009 WHERE event_id = ?")
      .bind(eventId).run();
    await env.DB.prepare("DELETE FROM app_usage_event WHERE event_id = ?").bind(eventId).run();
    expect((await spend(appId)).map((row) => [row.microusd, row.revision]))
      .toEqual([[9, 4], [9, 4]]);
  });

  it("creates no invented user scope for a null user", async () => {
    const appId = `${PREFIX}null-user`;
    await insertEvent({ appId, userId: null, costUsd: 0.000011 });
    expect(await spend(appId)).toEqual([
      expect.objectContaining({ scope: "app", user_key: "", microusd: 11 }),
    ]);
  });

  it("keeps failed delivery pending and an ordinary minute run recovers it", async () => {
    const appId = `${PREFIX}cron-recovery`;
    const month = new Date().toISOString().slice(0, 7);
    await insertEvent({ appId, userId: null, costUsd: 0.000021 });
    const unavailable = {
      ...env,
      USER_LIMITER: {
        getByName: () => ({ setMonthlyCost: () => Promise.reject(new Error("limiter unavailable")) }),
      },
    } as unknown as Env;
    expect((await projectUsageEventSpend(unavailable, { appId, userId: null, month })).acknowledged)
      .toBe(0);
    await env.DB.prepare("UPDATE app_usage_spend SET last_attempt_at = -1 WHERE app_id = ?")
      .bind(appId).run();

    const ctx = createExecutionContext();
    app.scheduled({
      cron: "* * * * *",
      scheduledTime: Date.parse("2026-10-01T03:16:00Z"),
    } as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(await spend(appId)).toEqual([
      expect.objectContaining({ pending: 0, microusd: 21 }),
    ]);
    expect((await env.USER_LIMITER.getByName(appId).getStatus(Date.now())).monthlyCostMicrousd)
      .toBe(21);
  });

  it("uses the scheduled UTC minute for nightly work and resumes recovery after it", async () => {
    const appId = `${PREFIX}maintenance-minute`;
    const month = "2026-10";
    await insertEvent({
      appId,
      userId: null,
      costUsd: 0.000022,
      createdAt: "2026-10-01T03:00:00Z",
    });
    const unavailable = {
      ...env,
      USER_LIMITER: {
        getByName: () => ({ setMonthlyCost: () => Promise.reject(new Error("limiter unavailable")) }),
      },
    } as unknown as Env;
    expect((await projectUsageEventSpend(unavailable, { appId, userId: null, month })).acknowledged)
      .toBe(0);
    await env.DB.prepare("UPDATE app_usage_spend SET last_attempt_at = -1 WHERE app_id = ?")
      .bind(appId).run();

    // Delivery can be delayed: dispatch follows the trigger's UTC timestamp,
    // not the wall clock at which this isolate eventually receives it.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-10-01T09:45:00Z");
    const nightly = createExecutionContext();
    app.scheduled({
      cron: "* * * * *",
      scheduledTime: Date.parse("2026-10-01T03:17:00Z"),
    } as ScheduledController, env, nightly);
    await waitOnExecutionContext(nightly);
    expect(await spend(appId)).toEqual([
      expect.objectContaining({ pending: 1, microusd: 22 }),
    ]);

    const nextMinute = createExecutionContext();
    app.scheduled({
      cron: "* * * * *",
      scheduledTime: Date.parse("2026-10-01T03:18:00Z"),
    } as ScheduledController, env, nextMinute);
    await waitOnExecutionContext(nextMinute);
    expect(await spend(appId)).toEqual([
      expect.objectContaining({ pending: 0, microusd: 22 }),
    ]);
  });

  it.each([
    ["the minute before maintenance", "* * * * *", "2026-10-01T03:16:00Z", "recover"],
    ["the maintenance minute", "* * * * *", "2026-10-01T03:17:00Z", "prune"],
    ["the minute after maintenance", "* * * * *", "2026-10-01T03:18:00Z", "recover"],
    ["the end of a UTC day", "* * * * *", "2026-10-01T23:59:00Z", "recover"],
    ["the start of a UTC day", "* * * * *", "2026-10-02T00:00:00Z", "recover"],
    ["the legacy nightly trigger", "17 3 * * *", "2026-10-01T09:45:00Z", "prune"],
    ["an unknown trigger", "0 * * * *", "2026-10-01T03:17:00Z", undefined],
  ] as const)("routes %s", (_label, cron, scheduledAt, expected) => {
    expect(scheduledMaintenance(cron, Date.parse(scheduledAt))).toBe(expected);
  });

  it("does no work for an unknown trigger", () => {
    const waitUntil = vi.fn();
    app.scheduled(
      {
        cron: "0 * * * *",
        scheduledTime: Date.parse("2026-10-01T03:17:00Z"),
      } as ScheduledController,
      env,
      { waitUntil } as unknown as ExecutionContext,
    );
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("replays an acknowledgement lost over a week ago without adding spend twice", async () => {
    const appId = `${PREFIX}ack-loss`;
    const month = new Date().toISOString().slice(0, 7);
    await insertEvent({ appId, userId: null, costUsd: 0.000031 });
    let failAck = true;
    const flakyDb = {
      prepare(query: string) {
        if (failAck && query.includes("SET pending = 0")) {
          failAck = false;
          throw new Error("acknowledgement lost");
        }
        return env.DB.prepare(query);
      },
      batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
      exec: (query: string) => env.DB.exec(query),
    } as unknown as D1Database;
    const flaky = { ...env, DB: flakyDb } as Env;
    expect((await projectUsageEventSpend(flaky, { appId, userId: null, month })).acknowledged)
      .toBe(0);
    expect((await env.USER_LIMITER.getByName(appId).getStatus(Date.now())).monthlyCostMicrousd)
      .toBe(31);
    await env.DB.prepare("UPDATE app_usage_spend SET last_attempt_at = ? WHERE app_id = ?")
      .bind(Date.now() - 8 * 86_400_000, appId).run();

    expect((await projectUsageEventSpend(env, { appId, userId: null, month })).acknowledged)
      .toBe(1);
    expect((await env.USER_LIMITER.getByName(appId).getStatus(Date.now())).monthlyCostMicrousd)
      .toBe(31);
  });

  it("does not acknowledge a revision superseded during delivery", async () => {
    const appId = `${PREFIX}interleaving`;
    const eventId = await insertEvent({ appId, userId: null, costUsd: 0.000010 });
    const row = await env.DB.prepare(
      `SELECT id, app_id, scope, user_key, month, microusd, revision
       FROM app_usage_spend WHERE app_id = ?`,
    ).bind(appId).first<{
      id: number;
      app_id: string;
      scope: "app";
      user_key: string;
      month: string;
      microusd: number;
      revision: number;
    }>();
    const realLimiter = env.USER_LIMITER.getByName(appId);
    const interleaving = {
      ...env,
      USER_LIMITER: {
        getByName: () => ({
          async setMonthlyCost(month: string, revision: number, microusd: number) {
            await realLimiter.setMonthlyCost(month, revision, microusd);
            await env.DB.prepare("UPDATE app_usage_event SET cost_usd = 0.000020 WHERE event_id = ?")
              .bind(eventId).run();
          },
        }),
      },
    } as unknown as Env;

    expect(await deliverUsageSpend(interleaving, row!)).toBe(false);
    expect(await spend(appId)).toEqual([
      expect.objectContaining({ microusd: 20, revision: 2, pending: 1 }),
    ]);
    expect((await realLimiter.getStatus(Date.now())).monthlyCostMicrousd).toBe(10);

    const month = row!.month;
    expect((await projectUsageEventSpend(env, { appId, userId: null, month })).acknowledged)
      .toBe(1);
    expect(await realLimiter.setMonthlyCost(month, 1, 999)).toBe(false);
    expect((await realLimiter.getStatus(Date.now())).monthlyCostMicrousd).toBe(20);
  });

  it("uses a UsageEvent's fixed timestamp for persistence and projection", async () => {
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
    expect((await env.USER_LIMITER.getByName(appId).getStatus(Date.parse(createdAt))).monthlyCostMicrousd)
      .toBe(41);
    expect((await env.USER_LIMITER.getByName(appId).getStatus(Date.UTC(2026, 7, 1))).monthlyCostMicrousd)
      .toBe(0);
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
      appId,
      userId: null,
      authMethod: "api_key",
      provider: "openai",
      providerId: "provider-test",
      providerSlug: "openai",
      providerRoute: DIRECT_ROUTE,
      model: "gpt-5.6-sol",
      route: "openai/v1/responses",
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

  it("prunes only settled old aggregates after their raw month is gone", async () => {
    const appId = `${PREFIX}prune`;
    const createdAt = "2025-01-15T12:00:00.000Z";
    await insertEvent({ appId, userId: null, costUsd: 0.000051, createdAt });
    await env.DB.prepare("DELETE FROM app_usage_event WHERE app_id = ?").bind(appId).run();

    expect(await pruneSettledUsageSpend(env, "2026-01")).toBe(0);
    expect(await spend(appId)).toHaveLength(1);
    await projectUsageEventSpend(env, { appId, userId: null, month: "2025-01" });
    expect(await pruneSettledUsageSpend(env, "2026-01")).toBe(1);
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

  it("bounds each recovery pass to twelve aggregate rows", async () => {
    for (let index = 0; index < USAGE_SPEND_RECOVERY_BATCH + 1; index += 1) {
      const appId = `${PREFIX}bounded-${index}`;
      await insertEvent({ appId, userId: null, costUsd: 0.000001 });
    }
    await env.DB.prepare(
      "UPDATE app_usage_spend SET last_attempt_at = -1 WHERE app_id LIKE ?",
    ).bind(`${PREFIX}bounded-%`).run();

    const result = await recoverPendingUsageSpend(env);
    expect(result.attempted).toBe(USAGE_SPEND_RECOVERY_BATCH);
    const pending = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM app_usage_spend WHERE app_id LIKE ? AND pending = 1",
    ).bind(`${PREFIX}bounded-%`).first<{ count: number }>();
    expect(pending?.count).toBe(1);
  });
});

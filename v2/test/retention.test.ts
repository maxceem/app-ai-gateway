/**
 * Usage retention and the nightly maintenance (plan section 4.2: "Usage
 * rollups and retention carry over from today"). Ports v1's
 * `usage-retention.test.ts` and `query-budget.test.ts`, and the retention
 * parts of `auth-events.test.ts`, onto v2's tables. Every time is a fixed
 * `now`: no timers.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { oauthSweepStatementCount, operationSweepStatementCount } from "@maxceem/cf-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { QueryBudget } from "../src/core/query-budget.ts";
import { runUsageRetention, USAGE_DAY_RETENTION_DAYS, USAGE_DETAIL_RETENTION_DAYS } from "../src/ledger/retention.ts";
import { insertChargeStatement, utcDay, type ChargeRow } from "../src/ledger/write.ts";
import { NIGHTLY_HOUR_UTC, runNightly, SIGN_IN_SWEEP_STATEMENTS } from "../src/maintenance/nightly.ts";
import { nano } from "../src/money.ts";
import { ACCOUNT_ID, attestAuthentication, seedApp } from "./helpers.ts";

const DAY = 86_400_000;
/** The run's time: 03:17 UTC, as the nightly cron. */
const NOW = Date.parse("2027-06-15T03:17:00Z");
const OLD = NOW - (USAGE_DETAIL_RETENTION_DAYS + 5) * DAY;
const RECENT = NOW - 10 * DAY;

let counter = 0;
const unique = (prefix: string) => `${prefix}_${++counter}`;

const TABLES = ["charge", "session", "open_work", "budget_day", "usage_day", "usage_month", "app_auth_event", "app_rejection_event"];

beforeEach(async () => {
  quiet();
  // The walks cover whole tables, so each test starts from empty ones.
  await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function charge(fields: Partial<ChargeRow> & { usedAt: number }): ChargeRow {
  const id = fields.id ?? unique("chg");
  return {
    id,
    kind: "attempt",
    accountId: ACCOUNT_ID,
    appId: "app_retention",
    endUserId: "user_1",
    installId: null,
    appleAccountId: null,
    appKeyId: null,
    ownerType: "call",
    ownerId: id,
    seq: 1,
    providerType: "openai",
    providerConnectionId: null,
    operation: "openai.chat",
    preset: null,
    model: "gpt-4o-mini",
    status: "ok",
    httpStatus: 200,
    errorCode: null,
    costNano: nano(1_000),
    measured: "complete",
    priceSource: "list_rate",
    priceIsEstimate: false,
    inputTokens: 10,
    cachedInputTokens: null,
    cacheWriteTokens: null,
    outputTokens: 5,
    unit: null,
    units: null,
    measures: {},
    rates: null,
    sessionMs: null,
    correctionKind: null,
    correctsChargeId: null,
    latencyMs: null,
    appVersion: null,
    authMethod: null,
    clientTraceId: null,
    usageDay: utcDay(fields.usedAt),
    writtenAt: fields.usedAt,
    ...fields,
  };
}

async function insert(...charges: ChargeRow[]): Promise<void> {
  await env.DB.batch(charges.map((row) => insertChargeStatement(env.DB, row)));
}

async function chargeIds(): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT id FROM charge ORDER BY rowid").all<{ id: string }>();
  return results.map((row) => row.id);
}

async function openWork(fields: { ownerType: string; ownerId: string; gaveUpAt?: number | null; createdAt?: number }): Promise<string> {
  const id = unique("work");
  await env.DB.prepare(
    `INSERT INTO open_work (id, kind, account_id, app_id, owner_type, owner_id, charge_id, detail_json, due_at, tries, created_at, gave_up_at)
     VALUES (?, 'unresolved', ?, 'app_retention', ?, ?, NULL, NULL, ?, 0, ?, ?)`,
  )
    .bind(id, ACCOUNT_ID, fields.ownerType, fields.ownerId, NOW + DAY, fields.createdAt ?? OLD, fields.gaveUpAt ?? null)
    .run();
  return id;
}

async function session(id: string, startedAt: number, settlement: "open" | "settled" | "estimate_kept"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO session (id, account_id, app_id, provider_type, operation, mode, slot, state, time_cap_ms, started_at, settlement, created_at, updated_at)
     VALUES (?, ?, 'app_retention', 'elevenlabs', 'elevenlabs.agent', 'relayed', 'conversational', 'ended', 1800000, ?, ?, ?, ?)`,
  )
    .bind(id, ACCOUNT_ID, startedAt, settlement, startedAt, startedAt)
    .run();
}

async function rows(sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]> {
  return (await env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>()).results;
}

const budget = (n = 1_000) => new QueryBudget(n);

function quiet(): void {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
}

/** The codes of the warnings logged from now on. */
function warningCodes(): string[] {
  quiet();
  const codes: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((entry: unknown) => {
    codes.push((JSON.parse(String(entry)) as { message: string }).message);
  });
  return codes;
}

describe("usage retention: charges", () => {
  it("deletes charges past 90 days and keeps the newer ones, without changing the day rollup", async () => {
    const old = charge({ usedAt: OLD });
    const edge = charge({ usedAt: NOW - USAGE_DETAIL_RETENTION_DAYS * DAY });
    const recent = charge({ usedAt: RECENT });
    await insert(old, edge, recent);
    const before = await rows("SELECT * FROM usage_day ORDER BY day");

    const result = await runUsageRetention(env.DB, NOW, budget());

    expect(await chargeIds()).toEqual([edge.id, recent.id]);
    expect(result.charges).toMatchObject({ deleted: 1, caughtUp: true });
    expect(await rows("SELECT * FROM usage_day ORDER BY day")).toEqual(before);
    expect(before.find((row) => row.day === old.usageDay)).toMatchObject({ charges: 1, cost_nano: nano(1_000) });
  });

  it("keeps charges whose open work is not finished, and deletes those whose work was given up", async () => {
    const waiting = charge({ usedAt: OLD });
    const gaveUp = charge({ usedAt: OLD });
    await insert(waiting, gaveUp);
    const live = await openWork({ ownerType: "call", ownerId: waiting.ownerId });
    await openWork({ ownerType: "call", ownerId: gaveUp.ownerId, gaveUpAt: RECENT });

    await runUsageRetention(env.DB, NOW, budget());

    expect(await chargeIds()).toEqual([waiting.id]);
    expect(await rows("SELECT id FROM open_work WHERE gave_up_at IS NULL")).toEqual([{ id: live }]);
  });

  it("deletes given-up work 90 days after it was given up, and keeps work given up since", async () => {
    const longAgo = await openWork({ ownerType: "job", ownerId: "job_a", gaveUpAt: OLD });
    const lately = await openWork({ ownerType: "job", ownerId: "job_b", gaveUpAt: RECENT });
    const live = await openWork({ ownerType: "job", ownerId: "job_c" });

    const result = await runUsageRetention(env.DB, NOW, budget());

    expect(result.gaveUpWork).toBe(1);
    const left = (await rows("SELECT id FROM open_work ORDER BY id")).map((row) => row.id);
    expect(left).not.toContain(longAgo);
    expect(left).toEqual(expect.arrayContaining([lately, live]));
  });

  it("keeps a job's estimate and figures while its check is open", async () => {
    const job = unique("job");
    const estimate = charge({ usedAt: OLD, kind: "estimate", ownerType: "job", ownerId: job, measured: "pending" });
    await insert(estimate);
    await openWork({ ownerType: "job", ownerId: job });

    await runUsageRetention(env.DB, NOW, budget());

    expect(await chargeIds()).toEqual([estimate.id]);
  });

  it("steps over a kept charge instead of stopping behind it", async () => {
    const kept = charge({ usedAt: OLD });
    await insert(kept);
    await openWork({ ownerType: "call", ownerId: kept.ownerId });
    const later = Array.from({ length: 6 }, () => charge({ usedAt: OLD }));
    await insert(...later);

    // Two rows a chunk: the kept one is alone in the first chunk's survivors.
    const result = await runUsageRetention(env.DB, NOW, budget(), 2);

    expect(await chargeIds()).toEqual([kept.id]);
    expect(result.charges).toMatchObject({ deleted: 6, caughtUp: true });
  });

  it("stops for the night at the first chunk that holds a charge too new", async () => {
    const first = charge({ usedAt: OLD });
    const recent = charge({ usedAt: RECENT });
    // Written late, behind a newer row: it waits until the walk reaches it.
    const straggler = charge({ usedAt: OLD });
    const behind = charge({ usedAt: RECENT });
    await insert(first, recent, behind, straggler);

    await runUsageRetention(env.DB, NOW, budget(), 2);

    expect(await chargeIds()).toEqual([recent.id, behind.id, straggler.id]);
  });
});

describe("usage retention: sessions", () => {
  it("keeps an open session's slices and row; deletes a settled one's once past 90 days", async () => {
    const open = unique("ses");
    const settled = unique("ses");
    const recent = unique("ses");
    await session(open, OLD, "open");
    await session(settled, OLD, "settled");
    await session(recent, RECENT, "settled");
    const slice = (owner: string, usedAt: number) =>
      charge({ usedAt, kind: "slice", ownerType: "session", ownerId: owner, sessionMs: 60_000 });
    const openSlice = slice(open, OLD);
    const settledSlice = slice(settled, OLD);
    const recentSlice = slice(recent, RECENT);
    await insert(openSlice, settledSlice, recentSlice);

    const result = await runUsageRetention(env.DB, NOW, budget());

    expect(await chargeIds()).toEqual([openSlice.id, recentSlice.id]);
    expect((await rows("SELECT id FROM session ORDER BY rowid")).map((row) => row.id)).toEqual([open, recent]);
    expect(result.sessions).toMatchObject({ deleted: 1 });
    // The plan minutes stay in the day rollup.
    expect(await rows("SELECT SUM(session_ms) AS ms FROM usage_day")).toEqual([{ ms: 180_000 }]);
  });

  it("keeps a settled session's row while open work on it remains", async () => {
    const id = unique("ses");
    await session(id, OLD, "estimate_kept");
    await openWork({ ownerType: "session", ownerId: id });

    await runUsageRetention(env.DB, NOW, budget());

    expect(await rows("SELECT id FROM session")).toEqual([{ id }]);
  });
});

describe("usage retention: budget totals", () => {
  it("deletes budget totals past 90 days and keeps this month's", async () => {
    await insert(charge({ usedAt: OLD }), charge({ usedAt: NOW - DAY }));
    expect(await rows("SELECT COUNT(*) AS n FROM budget_day")).toEqual([{ n: 4 }]);

    await runUsageRetention(env.DB, NOW, budget());

    expect(await rows("SELECT DISTINCT day FROM budget_day")).toEqual([{ day: utcDay(NOW - DAY) }]);
  });
});

describe("usage retention: day rollups into months", () => {
  async function day(dayText: string, fields: { app?: string; cost?: number; ms?: number; outcome?: string } = {}): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO usage_day (account_id, app_id, day, provider_type, provider_connection_id, model, outcome, unit,
         charges, unpriced_charges, cost_nano, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, units, session_ms)
       VALUES (?, ?, ?, 'openai', '', 'gpt-4o-mini', ?, '', 2, 1, ?, 100, 10, 1, 50, 0, ?)`,
    )
      .bind(ACCOUNT_ID, fields.app ?? "app_fold", dayText, fields.outcome ?? "ok", fields.cost ?? 1_000, fields.ms ?? 0)
      .run();
  }

  it("moves whole months past 400 days into month rows, with the same sums", async () => {
    // NOW is 2027-06-15; 400 days before is 2026-05-11, so April 2026 and
    // earlier are wholly past the window, and May 2026 is not.
    expect(utcDay(NOW - USAGE_DAY_RETENTION_DAYS * DAY)).toBe("2026-05-11");
    await day("2026-03-31", { cost: 7 });
    await day("2026-04-01", { cost: 1_000, ms: 60_000 });
    await day("2026-04-30", { cost: 2_000, ms: 30_000 });
    await day("2026-04-30", { cost: 5, outcome: "failed" });
    await day("2026-05-01", { cost: 3_000 });
    await day("2027-06-14", { cost: 4_000 });

    const result = await runUsageRetention(env.DB, NOW, budget(), 2);

    expect(result.months).toMatchObject({ caughtUp: true });
    expect((await rows("SELECT day FROM usage_day ORDER BY day")).map((row) => row.day)).toEqual(["2026-05-01", "2027-06-14"]);
    expect(await rows("SELECT month, outcome, charges, unpriced_charges, cost_nano, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, session_ms FROM usage_month ORDER BY month, outcome")).toEqual([
      { month: "2026-03", outcome: "ok", charges: 2, unpriced_charges: 1, cost_nano: 7, input_tokens: 100, cached_input_tokens: 10, cache_write_tokens: 1, output_tokens: 50, session_ms: 0 },
      { month: "2026-04", outcome: "failed", charges: 2, unpriced_charges: 1, cost_nano: 5, input_tokens: 100, cached_input_tokens: 10, cache_write_tokens: 1, output_tokens: 50, session_ms: 0 },
      { month: "2026-04", outcome: "ok", charges: 4, unpriced_charges: 2, cost_nano: 3_000, input_tokens: 200, cached_input_tokens: 20, cache_write_tokens: 2, output_tokens: 100, session_ms: 90_000 },
    ]);
  });

  it("adds a day that arrives later to its month row", async () => {
    await day("2026-04-01", { cost: 1_000 });
    await runUsageRetention(env.DB, NOW, budget());
    await day("2026-04-02", { cost: 500 });
    await runUsageRetention(env.DB, NOW, budget());

    expect(await rows("SELECT month, cost_nano, charges FROM usage_month")).toEqual([{ month: "2026-04", cost_nano: 1_500, charges: 4 }]);
    expect(await rows("SELECT COUNT(*) AS n FROM usage_day")).toEqual([{ n: 0 }]);
  });
});

describe("the query budget", () => {
  it("never issues more statements than the allowance, and goes on where it stopped the next night", async () => {
    // Twenty statements leave the charges one chunk of two a night, after the shares kept for the other passes.
    await insert(...Array.from({ length: 8 }, () => charge({ usedAt: OLD })));
    const allowances: number[] = [];
    let runs = 0;
    while ((await chargeIds()).length > 0) {
      runs += 1;
      expect(runs).toBeLessThan(10);
      const nightly = new QueryBudget(20);
      const result = await runUsageRetention(env.DB, NOW, nightly, 2);
      allowances.push(nightly.spent);
      expect(nightly.spent).toBeLessThanOrEqual(20);
      if (runs === 1) expect(result.charges?.caughtUp).toBe(false);
    }
    expect(runs).toBe(4);
    expect(allowances.every((spent) => spent <= 20)).toBe(true);
  });

  it("keeps a share for the passes after the charges, however large the charge backlog", async () => {
    await insert(...Array.from({ length: 40 }, () => charge({ usedAt: OLD })));
    await env.DB.prepare(
      `INSERT INTO usage_day (account_id, app_id, day, provider_type, provider_connection_id, model, outcome, unit, cost_nano)
       VALUES (?, 'app_share', '2026-01-10', 'openai', '', '', 'ok', '', 9)`,
    )
      .bind(ACCOUNT_ID)
      .run();

    const result = await runUsageRetention(env.DB, NOW, new QueryBudget(20), 2);

    expect(result.charges?.caughtUp).toBe(false);
    expect(result.months).toMatchObject({ caughtUp: true });
    expect(await rows("SELECT month, cost_nano FROM usage_month")).toEqual([{ month: "2026-01", cost_nano: 9 }]);
  });

  it("charges the sign-in clean-up its library's statement count", () => {
    expect(SIGN_IN_SWEEP_STATEMENTS).toBe(operationSweepStatementCount + oauthSweepStatementCount);
  });
});

describe("the nightly run", () => {
  async function authEvent(createdAt: number): Promise<string> {
    const id = unique("evt");
    await env.DB.prepare(
      `INSERT INTO app_auth_event (id, app_id, event, outcome, created_at) VALUES (?, 'app_retention', 'token_exchange', 'succeeded', ?)`,
    )
      .bind(id, createdAt)
      .run();
    return id;
  }

  async function rejection(createdAt: number): Promise<string> {
    const id = unique("rej");
    await env.DB.prepare("INSERT INTO app_rejection_event (id, app_id, reason, created_at) VALUES (?, 'app_retention', 'model_not_allowed', ?)")
      .bind(id, createdAt)
      .run();
    return id;
  }

  it("deletes auth and rejection events past 90 days, and old usage, within one allowance", async () => {
    await authEvent(OLD);
    const newEvent = await authEvent(RECENT);
    await rejection(OLD);
    const newRejection = await rejection(RECENT);
    const recent = charge({ usedAt: RECENT });
    await insert(charge({ usedAt: OLD }), recent);

    const allowance = new QueryBudget(49);
    await runNightly(env, NOW, allowance);

    expect(await rows("SELECT id FROM app_auth_event")).toEqual([{ id: newEvent }]);
    expect(await rows("SELECT id FROM app_rejection_event")).toEqual([{ id: newRejection }]);
    expect(await chargeIds()).toEqual([recent.id]);
    expect(allowance.spent).toBeLessThanOrEqual(49);
  });

  it("goes on with the other jobs when one fails", async () => {
    const warnings = warningCodes();
    const broken = {
      get: () => Promise.reject(new Error("R2 is down")),
    } as unknown as R2Bucket;
    await insert(charge({ usedAt: OLD }));
    const oldEvent = await authEvent(OLD);

    await runNightly({ ...env, CONVERSATIONS: broken } as Env, NOW, new QueryBudget(49));

    expect(warnings).toContain("conversations_prune_failed");
    expect(await chargeIds()).toEqual([]);
    expect(await rows("SELECT id FROM app_auth_event WHERE id = ?", oldEvent)).toEqual([]);
  });

  it("goes on with the other usage passes when one fails", async () => {
    const warnings = warningCodes();
    await insert(charge({ usedAt: OLD }));
    await session(unique("ses"), OLD, "settled");
    // A database on which every statement about charges fails.
    const failing = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            if (/FROM charge/.test(sql) && !/EXISTS \(SELECT 1 FROM charge/.test(sql)) throw new Error("charge statements fail");
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const result = await runUsageRetention(failing, NOW, budget());

    expect(warnings).toContain("usage_retention_charges_failed");
    expect(result.charges).toBeNull();
    expect(result.sessions).toMatchObject({ caughtUp: true });
    expect(result.months).toMatchObject({ caughtUp: true });
  });

  it("runs from the hourly cron at 03:17 UTC only; the hourly clean-up runs every hour", async () => {
    await insert(charge({ usedAt: OLD }));
    const appId = await seedApp(attestAuthentication());
    await env.DB.prepare("INSERT INTO app_auth_challenge (challenge, app_id, expires_at, attempted) VALUES (?, ?, 1000, 0)")
      .bind(unique("challenge"), appId)
      .run();
    const at = (hour: number) => Date.parse(`2027-06-15T${String(hour).padStart(2, "0")}:17:00Z`);
    quiet();

    const daytime = createExecutionContext();
    await worker.scheduled!(createScheduledController({ cron: "17 * * * *", scheduledTime: at(NIGHTLY_HOUR_UTC + 1) }), env, daytime);
    await waitOnExecutionContext(daytime);
    expect(await chargeIds()).toHaveLength(1);
    expect(await rows("SELECT challenge FROM app_auth_challenge WHERE app_id = ?", appId)).toEqual([]);

    const nightly = createExecutionContext();
    await worker.scheduled!(createScheduledController({ cron: "17 * * * *", scheduledTime: at(NIGHTLY_HOUR_UTC) }), env, nightly);
    await waitOnExecutionContext(nightly);
    expect(await chargeIds()).toEqual([]);
  });
});

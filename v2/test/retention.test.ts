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
import { MAINTENANCE_SLACK_QUERIES, MAXIMUM_MAINTENANCE_QUERY_BUDGET, maintenanceQueryBudget, QueryBudget } from "../src/core/query-budget.ts";
import { settleJob, settleJobFrom } from "../src/ledger/corrections.ts";
import { FOLD_PICK, runUsageRetention, usageRetentionRules, USAGE_DAY_RETENTION_DAYS, USAGE_DETAIL_RETENTION_DAYS } from "../src/ledger/retention.ts";
import { insertChargeStatement, utcDay, type ChargeRow } from "../src/ledger/write.ts";
import { NIGHTLY_HOUR_UTC, runNightly, SIGN_IN_SWEEP_STATEMENTS } from "../src/maintenance/nightly.ts";
import { nano } from "../src/money.ts";
import { ACCOUNT_ID, attestAuthentication, seedApp } from "./helpers.ts";

const DAY = 86_400_000;
/** The run's time: 04:17 UTC, as the nightly cron. */
const NOW = Date.parse("2027-06-15T04:17:00Z");
const OLD = NOW - (USAGE_DETAIL_RETENTION_DAYS + 5) * DAY;
const RECENT = NOW - 10 * DAY;

let counter = 0;
const unique = (prefix: string) => `${prefix}_${++counter}`;

const TABLES = ["charge", "session", "open_work", "budget_day", "usage_day", "usage_month", "app_auth_event", "app_rejection_event"];

beforeEach(async () => {
  quiet();
  // The passes cover whole tables, so each test starts from empty ones.
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

    expect(result.gaveUpWork).toMatchObject({ deleted: 1, caughtUp: true });
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

  it("is never held up by kept charges, however many come first", async () => {
    // More kept rows than a chunk, written before the deletable ones.
    const kept = Array.from({ length: 3 }, () => charge({ usedAt: OLD }));
    await insert(...kept);
    for (const row of kept) await openWork({ ownerType: "call", ownerId: row.ownerId });
    await insert(...Array.from({ length: 6 }, () => charge({ usedAt: OLD })));

    const result = await runUsageRetention(env.DB, NOW, budget(), 2);

    expect(await chargeIds()).toEqual(kept.map((row) => row.id));
    expect(result.charges).toMatchObject({ deleted: 6, caughtUp: true });
  });

  it("finds an old charge written late, behind more than a chunk of newer ones", async () => {
    const recent = Array.from({ length: 5 }, () => charge({ usedAt: RECENT }));
    await insert(...recent);
    await insert(charge({ usedAt: OLD }));

    const result = await runUsageRetention(env.DB, NOW, budget(), 2);

    expect(await chargeIds()).toEqual(recent.map((row) => row.id));
    expect(result.charges).toMatchObject({ deleted: 1, caughtUp: true });
  });

  it("deletes a correction only after the charge it corrects, and keeps both while the charge is kept", async () => {
    const original = charge({ usedAt: OLD });
    const fix = charge({ usedAt: OLD, kind: "correction", correctionKind: "pricing", correctsChargeId: original.id, ownerId: original.ownerId });
    const keptOriginal = charge({ usedAt: OLD });
    const keptFix = charge({ usedAt: OLD, kind: "correction", correctionKind: "pricing", correctsChargeId: keptOriginal.id, ownerId: keptOriginal.ownerId });
    await insert(fix, original, keptFix, keptOriginal);
    await openWork({ ownerType: "call", ownerId: keptOriginal.ownerId });

    await runUsageRetention(env.DB, NOW, budget());
    // The first night deletes the charge; its correction waits for a later chunk or night.
    expect(await chargeIds()).not.toContain(original.id);
    expect(await chargeIds()).toEqual(expect.arrayContaining([keptFix.id, keptOriginal.id]));

    await runUsageRetention(env.DB, NOW, budget());
    expect(await chargeIds()).toEqual([keptFix.id, keptOriginal.id]);
  });

  it("never books a job twice when retention deletes its charges around a late poll", async () => {
    const job = unique("job");
    const estimate = charge({ usedAt: OLD, kind: "estimate", ownerType: "job", ownerId: job, measured: "pending", costNano: nano(1_000) });
    await insert(estimate);
    const final = { kind: "dollars", costNano: nano(1_200) } as const;
    expect(await settleJob(env.DB, { jobId: job, final, now: OLD + DAY })).toMatchObject({ status: "settled" });
    const total = async () => (await rows("SELECT SUM(cost_nano) AS cost FROM usage_day"))[0]?.cost;
    expect(await total()).toBe(1_200);

    // A poll reads the estimate, then retention runs before it writes.
    const read = (await rows("SELECT id FROM charge WHERE id = ?", estimate.id)).length;
    expect(read).toBe(1);
    await runUsageRetention(env.DB, NOW, budget());
    await runUsageRetention(env.DB, NOW, budget());
    expect(await chargeIds()).toEqual([]);

    // The poll writes from what it read: nothing is booked.
    expect(await settleJobFrom(env.DB, estimate, final, NOW)).toEqual({ status: "already" });
    // A poll after that finds no estimate.
    expect(await settleJob(env.DB, { jobId: job, final, now: NOW })).toEqual({ status: "charge_missing" });
    expect(await chargeIds()).toEqual([]);
    expect(await total()).toBe(1_200);
  });

  it("writes no correction from an estimate read before retention deleted it, while its settlement is still there", async () => {
    const job = unique("job");
    const estimate = charge({ usedAt: OLD, kind: "estimate", ownerType: "job", ownerId: job, measured: "pending", costNano: nano(1_000) });
    await insert(estimate);
    const final = { kind: "dollars", costNano: nano(1_200) } as const;
    await settleJob(env.DB, { jobId: job, final, now: OLD + DAY });

    // One night: the estimate goes, its settlement stays until a later chunk.
    await runUsageRetention(env.DB, NOW, budget());
    expect(await chargeIds()).toHaveLength(1);

    expect(await settleJobFrom(env.DB, estimate, { kind: "dollars", costNano: nano(1_500) }, NOW)).toEqual({ status: "already" });
    expect((await rows("SELECT SUM(cost_nano) AS cost FROM usage_day"))[0]?.cost).toBe(1_200);
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

  it("finds a late day behind more than a chunk of newer days", async () => {
    for (const recent of ["2027-06-10", "2027-06-11", "2027-06-12", "2027-06-13", "2027-06-14"]) await day(recent);
    await day("2026-04-03", { cost: 70 });

    const result = await runUsageRetention(env.DB, NOW, budget(), 2);

    expect(result.months).toMatchObject({ deleted: 1, caughtUp: true });
    expect(await rows("SELECT month, cost_nano FROM usage_month")).toEqual([{ month: "2026-04", cost_nano: 70 }]);
  });

  it("keeps a month's totals exact when the budget splits it over nights", async () => {
    for (const [index, dayText] of ["2026-04-01", "2026-04-02", "2026-04-03", "2026-04-04", "2026-04-05"].entries()) {
      await day(dayText, { cost: 100 * (index + 1), ms: 1_000 });
    }
    const april = async () => {
      const month = await rows("SELECT COALESCE(SUM(cost_nano), 0) AS cost, COALESCE(SUM(charges), 0) AS charges, COALESCE(SUM(session_ms), 0) AS ms FROM usage_month WHERE month = '2026-04'");
      const days = await rows("SELECT COALESCE(SUM(cost_nano), 0) AS cost, COALESCE(SUM(charges), 0) AS charges, COALESCE(SUM(session_ms), 0) AS ms FROM usage_day WHERE day LIKE '2026-04-%'");
      return { cost: Number(month[0]!.cost) + Number(days[0]!.cost), charges: Number(month[0]!.charges) + Number(days[0]!.charges), ms: Number(month[0]!.ms) + Number(days[0]!.ms) };
    };
    const whole = { cost: 1_500, charges: 10, ms: 5_000 };
    let nights = 0;
    while ((await rows("SELECT COUNT(*) AS n FROM usage_day"))[0]!.n !== 0) {
      nights += 1;
      expect(nights).toBeLessThan(5);
      // Three statements: the other passes keep the fold's share free, and it affords one chunk.
      const result = await runUsageRetention(env.DB, NOW, new QueryBudget(3), 2);
      expect(result.months?.chunks).toBe(1);
      expect(await april()).toEqual(whole);
    }
    expect(nights).toBe(3);
    expect(await rows("SELECT cost_nano, charges, session_ms FROM usage_month")).toEqual([{ cost_nano: 1_500, charges: 10, session_ms: 5_000 }]);
  });

  describe("a total past SQLite's largest integer", () => {
    const MAX = 9223372036854775807n;
    const HUGE = 5_000_000_000_000_000_000n;
    async function hugeDay(dayText: string, app: string): Promise<void> {
      // Bound as text and cast, so the exact integer reaches SQLite.
      await env.DB.prepare(
        `INSERT INTO usage_day (account_id, app_id, day, provider_type, provider_connection_id, model, outcome, unit, charges, cost_nano)
         VALUES (?, ?, ?, 'openai', '', 'gpt-4o-mini', 'ok', '', 1, CAST(? AS INTEGER))`,
      )
        .bind(ACCOUNT_ID, app, dayText, HUGE.toString())
        .run();
    }
    const months = () =>
      rows("SELECT app_id, month, CAST(cost_nano AS TEXT) AS cost, typeof(cost_nano) AS type, charges FROM usage_month ORDER BY app_id, month");

    it("stops at the largest integer within one chunk, and folds every other key exactly", async () => {
      const codes = warningCodes();
      await hugeDay("2026-04-01", "app_huge");
      await hugeDay("2026-04-02", "app_huge");
      await day("2026-04-01", { app: "app_small", cost: 7 });
      await day("2026-04-02", { app: "app_small", cost: 8 });

      const result = await runUsageRetention(env.DB, NOW, budget());

      expect(result.months).toMatchObject({ caughtUp: true });
      expect(await months()).toEqual([
        { app_id: "app_huge", month: "2026-04", cost: MAX.toString(), type: "integer", charges: 2 },
        { app_id: "app_small", month: "2026-04", cost: "15", type: "integer", charges: 4 },
      ]);
      expect(await rows("SELECT COUNT(*) AS n FROM usage_day")).toEqual([{ n: 0 }]);
      expect(codes.filter((code) => code === "usage_month_total_too_large")).toHaveLength(1);
    });

    it("stops at the largest integer when the month row already holds most of it", async () => {
      const codes = warningCodes();
      await hugeDay("2026-04-01", "app_huge");
      await hugeDay("2026-04-02", "app_huge");
      await day("2026-04-03", { app: "app_small", cost: 7 });
      await day("2026-04-04", { app: "app_small", cost: 8 });

      // One row a chunk: the second huge day meets the first in its month row.
      const result = await runUsageRetention(env.DB, NOW, budget(), 1);

      expect(result.months).toMatchObject({ caughtUp: true });
      expect(await months()).toEqual([
        { app_id: "app_huge", month: "2026-04", cost: MAX.toString(), type: "integer", charges: 2 },
        { app_id: "app_small", month: "2026-04", cost: "15", type: "integer", charges: 4 },
      ]);
      expect(await rows("SELECT COUNT(*) AS n FROM usage_day")).toEqual([{ n: 0 }]);
      expect(codes.filter((code) => code === "usage_month_total_too_large")).toHaveLength(1);
    });
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
    // Of twenty statements, the charges get nine chunks of two a night, after the shares kept for the other passes.
    await insert(...Array.from({ length: 36 }, () => charge({ usedAt: OLD })));
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
    expect(runs).toBe(2);
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

  it("lowers a setting above D1's 1,000 queries a run to 1,000, with a warning", () => {
    const codes = warningCodes();
    const nightly = maintenanceQueryBudget({ ...env, MAINTENANCE_QUERY_BUDGET: "10000" } as Env);
    expect(nightly.limit).toBe(MAXIMUM_MAINTENANCE_QUERY_BUDGET - MAINTENANCE_SLACK_QUERIES);
    expect(codes).toEqual(["maintenance_query_budget_capped"]);
    expect(maintenanceQueryBudget({ ...env, MAINTENANCE_QUERY_BUDGET: "400" } as Env).limit).toBe(400 - MAINTENANCE_SLACK_QUERIES);
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
    await insert(charge({ usedAt: OLD }));
    await authEvent(OLD);
    await rejection(OLD);
    // A database on which deleting auth events fails.
    const failing = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            if (sql.startsWith("DELETE FROM app_auth_event")) throw new Error("auth event statements fail");
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await runNightly({ ...env, DB: failing } as Env, NOW, new QueryBudget(49));

    expect(warnings).toContain("auth_events_prune_failed");
    expect(await chargeIds()).toEqual([]);
    expect(await rows("SELECT id FROM app_rejection_event")).toEqual([]);
  });

  it("deletes a backlog of events larger than a chunk over several statements", async () => {
    for (let index = 0; index < 12_000; index += 4_000) {
      await env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4000)
         INSERT INTO app_rejection_event (id, app_id, reason, created_at) SELECT 'bulk_' || (? + i), 'app_retention', 'model_not_allowed', ? FROM n`,
      )
        .bind(index, OLD)
        .run();
    }
    const allowance = new QueryBudget(49);

    await runNightly(env, NOW, allowance);

    expect(await rows("SELECT COUNT(*) AS n FROM app_rejection_event")).toEqual([{ n: 0 }]);
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
            if (sql.startsWith("DELETE FROM charge")) throw new Error("charge statements fail");
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

  it("runs from the hourly cron at 04:17 UTC only; the hourly clean-up runs every hour", async () => {
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

describe("retention queries", () => {
  const plan = async (sql: string, ...params: unknown[]) =>
    (await rows(`EXPLAIN QUERY PLAN ${sql}`, ...params)).map((row) => String(row.detail)).join("\n");

  it("picks every pass's rows through an index, never a scan of the whole table", async () => {
    const rules = usageRetentionRules(NOW);
    const indexes = { gaveUpWork: "open_work_gave_up", charges: "charge_usage_day", sessions: "session_started", budgetDays: "budget_day_day" };
    for (const [name, rule] of Object.entries(rules)) {
      const detail = await plan(`${rule.rowids} LIMIT 1`, ...rule.params);
      expect(detail, name).toContain(indexes[name as keyof typeof indexes]);
    }
    expect(await plan(FOLD_PICK, "2026-05-01", 1)).toContain("usage_day_day");
    expect(await plan("SELECT rowid FROM app_auth_event WHERE created_at < ? LIMIT 1", NOW)).toContain("app_auth_event_created");
    expect(await plan("SELECT rowid FROM app_rejection_event WHERE created_at < ? LIMIT 1", NOW)).toContain("app_rejection_event_created");
  });
});

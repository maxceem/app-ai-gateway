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
import { ROW_WRITES, runPasses } from "../src/core/chunked-delete.ts";
import { authEventsPass } from "../src/client-auth/auth-events.ts";
import {
  DEFAULT_MAINTENANCE_ROWS,
  DEFAULT_MAINTENANCE_STATEMENTS,
  MAINTENANCE_SLACK_STATEMENTS,
  MAXIMUM_MAINTENANCE_ROWS,
  MAXIMUM_MAINTENANCE_STATEMENTS,
  maintenanceRowLimit,
  maintenanceStatementBudget,
  MINIMUM_MAINTENANCE_ROWS,
  MINIMUM_MAINTENANCE_STATEMENTS,
  QueryBudget,
} from "../src/core/query-budget.ts";
import { settleJob, settleJobFrom } from "../src/ledger/corrections.ts";
import { timeOrderedId } from "../src/core/ids.ts";
import { FIGURE_MAX_TRIES, figureWork, JOB_CHECK_EVERY_MS, JOB_MAX_CHECKS, keepFigure } from "../src/jobs/jobs.ts";
import { RETENTION_MS as STORE_RETENTION_MS, retryStored } from "../src/do/ChargeStore.ts";
import { LEDGER_LATE_BOOKING_DAYS } from "../src/ledger/late-booking.ts";
import { retryDelay, SWEEP_MAX_TRIES } from "../src/ledger/sweep.ts";
import {
  FOLD_PICK,
  runUsageRetention,
  STUCK_SESSION_STATEMENTS,
  usageRetentionRules,
  USAGE_DAY_RETENTION_DAYS,
  USAGE_DETAIL_RETENTION_DAYS,
} from "../src/ledger/retention.ts";
import { insertChargeStatement, utcDay, type ChargeRow } from "../src/ledger/write.ts";
import { CHALLENGE_SETTLE_STATEMENTS, NIGHTLY_HOUR_UTC, nightlyPasses, runLedgerNightly, SIGN_IN_SWEEP_STATEMENTS } from "../src/maintenance/nightly.ts";
import { nano } from "../src/money.ts";
import { usageByUser } from "../src/admin/users.ts";
import { ACCOUNT_ID, attestAuthentication, ledger, seedApp } from "./helpers.ts";

const DAY = 86_400_000;
/** The run's time: 04:17 UTC, as the nightly cron. */
const NOW = Date.parse("2027-06-15T04:17:00Z");
const OLD = NOW - (USAGE_DETAIL_RETENTION_DAYS + 5) * DAY;
const RECENT = NOW - 10 * DAY;
/** The month of {@link OLD}, as the users list asks for it. */
const OLD_MONTH = new Date(OLD).toISOString().slice(0, 7);

let counter = 0;
const unique = (prefix: string) => `${prefix}_${++counter}`;

const TABLES = ["charge", "session", "open_work", "budget_day", "usage_day", "usage_month", "app_auth_event", "app_rejection_event"];

beforeEach(async () => {
  quiet();
  // The passes cover whole tables, so each test starts from empty ones.
  await ledger().batch(TABLES.map((table) => ledger().prepare(`DELETE FROM ${table}`)));
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
  // Seeded as of their own time: the ledger takes them then (`../src/ledger/late-booking.ts`).
  await ledger().batch(charges.map((row) => insertChargeStatement(ledger(), row, row.writtenAt)));
}

async function chargeIds(): Promise<string[]> {
  const { results } = await ledger().prepare("SELECT id FROM charge ORDER BY rowid").all<{ id: string }>();
  return results.map((row) => row.id);
}

async function openWork(fields: { ownerType: string; ownerId: string; gaveUpAt?: number | null; createdAt?: number }): Promise<string> {
  const id = unique("work");
  await ledger().prepare(
    `INSERT INTO open_work (id, kind, account_id, app_id, owner_type, owner_id, charge_id, detail_json, due_at, tries, created_at, gave_up_at)
     VALUES (?, 'unresolved', ?, 'app_retention', ?, ?, NULL, NULL, ?, 0, ?, ?)`,
  )
    .bind(id, ACCOUNT_ID, fields.ownerType, fields.ownerId, NOW + DAY, fields.createdAt ?? OLD, fields.gaveUpAt ?? null)
    .run();
  return id;
}

async function session(id: string, startedAt: number, settlement: "open" | "settled" | "estimate_kept"): Promise<void> {
  await ledger().prepare(
    `INSERT INTO session (id, account_id, app_id, provider_type, operation, mode, slot, state, time_cap_ms, started_at, settlement, created_at, updated_at)
     VALUES (?, ?, 'app_retention', 'elevenlabs', 'elevenlabs.agent', 'relayed', 'conversational', 'ended', 1800000, ?, ?, ?, ?)`,
  )
    .bind(id, ACCOUNT_ID, startedAt, settlement, startedAt, startedAt)
    .run();
}

async function rows(sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]> {
  return (await ledger().prepare(sql).bind(...params).all<Record<string, unknown>>()).results;
}

const budget = (n = 1_000) => new QueryBudget(n);

async function authEventRow(createdAt: number): Promise<void> {
  await ledger().prepare(
    `INSERT INTO app_auth_event (id, app_id, event, outcome, created_at) VALUES (?, 'app_retention', 'token_exchange', 'succeeded', ?)`,
  )
    .bind(unique("evt"), createdAt)
    .run();
}

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

    const result = await runUsageRetention(ledger(), NOW, budget());

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

    await runUsageRetention(ledger(), NOW, budget());

    expect(await chargeIds()).toEqual([waiting.id]);
    expect(await rows("SELECT id FROM open_work WHERE gave_up_at IS NULL")).toEqual([{ id: live }]);
  });

  it("deletes given-up work 90 days after it was given up, and keeps work given up since", async () => {
    const longAgo = await openWork({ ownerType: "job", ownerId: "job_a", gaveUpAt: OLD });
    const lately = await openWork({ ownerType: "job", ownerId: "job_b", gaveUpAt: RECENT });
    const live = await openWork({ ownerType: "job", ownerId: "job_c" });

    const result = await runUsageRetention(ledger(), NOW, budget());

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

    await runUsageRetention(ledger(), NOW, budget());

    expect(await chargeIds()).toEqual([estimate.id]);
  });

  it("is never held up by kept charges, however many come first", async () => {
    // More kept rows than a chunk, written before the deletable ones.
    const kept = Array.from({ length: 3 }, () => charge({ usedAt: OLD }));
    await insert(...kept);
    for (const row of kept) await openWork({ ownerType: "call", ownerId: row.ownerId });
    await insert(...Array.from({ length: 6 }, () => charge({ usedAt: OLD })));

    const result = await runUsageRetention(ledger(), NOW, budget(), 2);

    expect(await chargeIds()).toEqual(kept.map((row) => row.id));
    expect(result.charges).toMatchObject({ deleted: 6, caughtUp: true });
  });

  it("finds an old charge written late, behind more than a chunk of newer ones", async () => {
    const recent = Array.from({ length: 5 }, () => charge({ usedAt: RECENT }));
    await insert(...recent);
    await insert(charge({ usedAt: OLD }));

    const result = await runUsageRetention(ledger(), NOW, budget(), 2);

    expect(await chargeIds()).toEqual(recent.map((row) => row.id));
    expect(result.charges).toMatchObject({ deleted: 1, caughtUp: true });
  });

  it("deletes a correction before the charge it corrects, and keeps both while the charge is kept", async () => {
    const original = charge({ usedAt: OLD });
    const fix = charge({ usedAt: OLD, kind: "correction", correctionKind: "pricing", correctsChargeId: original.id, ownerId: original.ownerId });
    const keptOriginal = charge({ usedAt: OLD });
    const keptFix = charge({ usedAt: OLD, kind: "correction", correctionKind: "pricing", correctsChargeId: keptOriginal.id, ownerId: keptOriginal.ownerId });
    await insert(fix, original, keptFix, keptOriginal);
    await openWork({ ownerType: "call", ownerId: keptOriginal.ownerId });

    const result = await runUsageRetention(ledger(), NOW, budget());
    // The correction goes in its own pass, the charge in the next once no correction is left (Astra 7b-2 round 2).
    expect(await chargeIds()).toEqual([keptFix.id, keptOriginal.id]);
    expect(result.corrections).toMatchObject({ deleted: 1, caughtUp: true });
    expect(result.charges).toMatchObject({ deleted: 1, caughtUp: true });
  });

  // What a reader of per-user detail may see between chunks: never a correction without its charge.
  // An owner with several corrections may show a partial total, even a negative one, but only in a
  // month already past the 90 days usage per user is kept; day and month rollups never change (Astra 7b-2 round 3).
  it("never shows a user a correction without its charge between chunks, and with one correction never a negative cost (Astra 7b-2 rounds 1 and 2)", async () => {
    const original = charge({ usedAt: OLD, costNano: nano(1_000) });
    const fix = charge({ usedAt: OLD, kind: "correction", correctionKind: "pricing", correctsChargeId: original.id, ownerId: original.ownerId, costNano: nano(-750) });
    const other = charge({ usedAt: OLD, costNano: nano(500) });
    await insert(original, fix, other);
    const read = async () => (await usageByUser(ledger(), ACCOUNT_ID, "app_retention", ["user_1"], OLD_MONTH)).get("user_1");
    expect(await read()).toMatchObject({ charges: 2, cost_nano: 750 });

    // One charge a chunk, one chunk of each pass a night, and a read after every night.
    for (let night = 0; night < 10 && (await chargeIds()).length > 0; night++) {
      await runUsageRetention(ledger(), NOW, new QueryBudget(3), 1);
      const ids = await chargeIds();
      if (ids.includes(fix.id)) expect(ids).toContain(original.id);
      expect((await read())?.cost_nano ?? 0).toBeGreaterThanOrEqual(0);
    }
    expect(await chargeIds()).toEqual([]);
  });

  it("deletes a large owner a bounded chunk at a time, within the row allowance (Astra 7b-2 round 2)", async () => {
    // A settled session with 1,001 slices past the window, and its provider total: ten times a chunk of 100 (Astra's case was 5,001 with a chunk of 5,000).
    const sessionId = unique("ses");
    await session(sessionId, OLD, "settled");
    const template = charge({ usedAt: OLD, ownerType: "session", ownerId: sessionId, seq: 0 });
    await insert(template, charge({ usedAt: OLD, kind: "correction", correctionKind: "dollars", ownerType: "session", ownerId: sessionId, seq: null }));
    const columns = (await rows("SELECT name FROM pragma_table_info('charge')")).map((row) => String(row.name));
    const copied = columns.map((column) => (column === "id" ? "'slice_' || n.i" : column === "seq" ? "n.i" : column)).join(", ");
    await ledger().prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
       INSERT INTO charge (${columns.join(", ")}) SELECT ${copied} FROM n, charge WHERE charge.id = ?`,
    )
      .bind(template.id)
      .run();
    expect(await rows("SELECT COUNT(*) AS n FROM charge")).toEqual([{ n: 1_002 }]);

    const rowLimit = 2_000;
    const result = await runUsageRetention(ledger(), NOW, budget(), 100, rowLimit);

    const deleted = (result.corrections?.deleted ?? 0) + (result.charges?.deleted ?? 0);
    expect(result.corrections).toMatchObject({ deleted: 1 });
    expect(deleted).toBeGreaterThan(1);
    expect(deleted * ROW_WRITES.charge).toBeLessThanOrEqual(rowLimit);
    for (const pass of [result.corrections, result.charges]) expect(pass!.deleted).toBeLessThanOrEqual(pass!.chunks * 100);
    expect(await rows("SELECT COUNT(*) AS n FROM charge")).toEqual([{ n: 1_002 - deleted }]);
  });

  it("keeps all of an owner's charges while any of them is inside the window, and deletes them together after", async () => {
    // A call retried across midnight on the cutoff day: its first try is past the window, its second is not.
    const owner = unique("call");
    const first = charge({ usedAt: NOW - (USAGE_DETAIL_RETENTION_DAYS + 1) * DAY, ownerId: owner, seq: 1 });
    const second = charge({ usedAt: NOW - USAGE_DETAIL_RETENTION_DAYS * DAY, ownerId: owner, seq: 2 });
    // A settled session: its slices and its provider total (a correction of the session) go together.
    const sessionId = unique("ses");
    await session(sessionId, OLD, "settled");
    const slices = [1, 2].map((seq) => charge({ usedAt: OLD, ownerType: "session", ownerId: sessionId, seq }));
    const total = charge({ usedAt: OLD, kind: "correction", correctionKind: "dollars", ownerType: "session", ownerId: sessionId, seq: null });
    await insert(first, second, ...slices, total);

    const result = await runUsageRetention(ledger(), NOW, budget(), 1);

    expect(await chargeIds()).toEqual([first.id, second.id]);
    expect(result.corrections).toMatchObject({ deleted: 1, caughtUp: true });
    expect(result.charges).toMatchObject({ deleted: 2, caughtUp: true });

    // The next day the second try is past the window too, and both go (Astra 7b-2 round 2).
    await runUsageRetention(ledger(), NOW + DAY, budget(), 1);
    expect(await chargeIds()).toEqual([]);
  });

  it("never books a job twice when retention deletes its charges around a late poll", async () => {
    const job = unique("job");
    const estimate = charge({ usedAt: OLD, kind: "estimate", ownerType: "job", ownerId: job, measured: "pending", costNano: nano(1_000) });
    await insert(estimate);
    const final = { kind: "dollars", costNano: nano(1_200) } as const;
    expect(await settleJob(ledger(), { jobId: job, final, now: OLD + DAY })).toMatchObject({ status: "settled" });
    const total = async () => (await rows("SELECT SUM(cost_nano) AS cost FROM usage_day"))[0]?.cost;
    expect(await total()).toBe(1_200);

    // A poll reads the estimate, then retention runs before it writes.
    const read = (await rows("SELECT id FROM charge WHERE id = ?", estimate.id)).length;
    expect(read).toBe(1);
    await runUsageRetention(ledger(), NOW, budget());
    await runUsageRetention(ledger(), NOW, budget());
    expect(await chargeIds()).toEqual([]);

    // The poll writes from what it read: nothing is booked.
    expect(await settleJobFrom(ledger(), estimate, final, NOW)).toEqual({ status: "already" });
    // A poll after that finds no estimate.
    expect(await settleJob(ledger(), { jobId: job, final, now: NOW })).toEqual({ status: "charge_missing" });
    expect(await chargeIds()).toEqual([]);
    expect(await total()).toBe(1_200);
  });

  it("writes no correction from an estimate read before retention deleted it, while its settlement is still there", async () => {
    const job = unique("job");
    const estimate = charge({ usedAt: OLD, kind: "estimate", ownerType: "job", ownerId: job, measured: "pending", costNano: nano(1_000) });
    await insert(estimate);
    const final = { kind: "dollars", costNano: nano(1_200) } as const;
    await settleJob(ledger(), { jobId: job, final, now: OLD + DAY });

    // A night whose budget ran out between the two: the estimate is gone, its
    // settlement is still there until a later chunk.
    await ledger().prepare("DELETE FROM charge WHERE id = ?").bind(estimate.id).run();
    expect(await chargeIds()).toHaveLength(1);

    expect(await settleJobFrom(ledger(), estimate, { kind: "dollars", costNano: nano(1_500) }, NOW)).toEqual({ status: "already" });
    expect((await rows("SELECT SUM(cost_nano) AS cost FROM usage_day"))[0]?.cost).toBe(1_200);
  });

  it("books nothing for a late poll once a job is past the window, with its settlement deleted and its estimate not yet (Astra 7b-2 round 2)", async () => {
    const codes = warningCodes();
    const job = timeOrderedId(OLD);
    const estimate = charge({ usedAt: OLD, kind: "estimate", ownerType: "job", ownerId: job, measured: "pending", costNano: nano(1_000) });
    await insert(estimate);
    const final = { kind: "dollars", costNano: nano(1_200) } as const;
    await settleJob(ledger(), { jobId: job, final, now: OLD + DAY });
    const total = async () => (await rows("SELECT SUM(cost_nano) AS cost FROM usage_day"))[0]?.cost;
    expect(await total()).toBe(1_200);

    // A night whose allowance ran out after the corrections pass: the settlement is gone, the estimate stays.
    const result = await runUsageRetention(ledger(), NOW, new QueryBudget(2));
    expect(result.corrections).toMatchObject({ deleted: 1 });
    expect(await chargeIds()).toEqual([estimate.id]);

    // A late poll finds the estimate and settles again: the correction is dated on the estimate's
    // day, too late for the ledger, so nothing is written and the day rollup is unchanged.
    expect(await settleJob(ledger(), { jobId: job, final, now: NOW })).toEqual({ status: "already" });
    expect(await chargeIds()).toEqual([estimate.id]);
    expect(await total()).toBe(1_200);
    expect(codes).toContain("ledger_booking_too_late");

    // The next night deletes the estimate.
    await runUsageRetention(ledger(), NOW, budget());
    expect(await chargeIds()).toEqual([]);
    expect(await total()).toBe(1_200);
  });

  it("never books a figure replayed from the failed-write store after retention deleted its job's settlement (Astra 7b-2 round 3)", async () => {
    const codes = warningCodes();
    const job = timeOrderedId(OLD);
    const ref = { job, accountId: ACCOUNT_ID, appId: "app_retention" };
    const estimate = charge({ usedAt: OLD, kind: "estimate", ownerType: "job", ownerId: job, measured: "pending", costNano: nano(100) });
    await insert(estimate);
    const total = async () => (await rows("SELECT SUM(cost_nano) AS cost FROM usage_day"))[0]?.cost;
    // A poll settles 100 at 120; its figure also went to the failed-write store, as after a D1 timeout on a write that committed.
    expect(await settleJob(ledger(), { jobId: job, final: { kind: "dollars", costNano: nano(120) }, now: OLD + DAY })).toMatchObject({ status: "settled" });
    const facts = { status: 200, units: 3, outputs: {} } as unknown as Parameters<typeof figureWork>[1];
    const stored = figureWork(ref, facts, OLD + DAY);
    expect(await total()).toBe(120);

    // A night whose allowance ran out after the corrections pass: the settlement is gone, the estimate stays.
    await runUsageRetention(ledger(), NOW, new QueryBudget(2));
    expect(await chargeIds()).toEqual([estimate.id]);

    // The store replays the figure. The work may come back; what it would book is too late for the ledger.
    await retryStored(() => ledger(), [], [stored], NOW);
    expect(await settleJob(ledger(), { jobId: job, final: { kind: "dollars", costNano: nano(120) }, now: NOW })).toEqual({ status: "already" });
    expect(await chargeIds()).toEqual([estimate.id]);
    expect(await total()).toBe(120);
    expect(codes).toContain("ledger_booking_too_late");
  });

  it("keeps a figure for a job on its last day inside the window, and settles it from there (Astra 7b-2 round 3)", async () => {
    // A poll's settlement read failed, so the figure is kept for the sweep.
    const started = NOW - (LEDGER_LATE_BOOKING_DAYS - 1) * DAY;
    const job = timeOrderedId(started);
    const estimate = charge({ usedAt: started, kind: "estimate", ownerType: "job", ownerId: job, measured: "pending", costNano: nano(100) });
    await insert(estimate);
    const facts = { status: 200, units: 3, outputs: {} } as unknown as Parameters<typeof keepFigure>[3];
    expect(await keepFigure(env, ledger(), { job, accountId: ACCOUNT_ID, appId: "app_retention" }, facts, NOW)).toBe(true);
    expect(await rows("SELECT id FROM open_work WHERE gave_up_at IS NULL")).toHaveLength(1);
    expect(await settleJob(ledger(), { jobId: job, final: { kind: "dollars", costNano: nano(130) }, now: NOW })).toMatchObject({ status: "settled" });
    expect((await rows("SELECT SUM(cost_nano) AS cost FROM usage_day"))[0]?.cost).toBe(130);
  });
});

describe("the late-booking rule", () => {
  it("takes a charge dated 29 days back and refuses one dated 31, with a warning, even while its owner has open work", async () => {
    const warned: Record<string, unknown>[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => void warned.push(JSON.parse(String(line)) as Record<string, unknown>));
    const { settleCharge } = await import("../src/ledger/corrections.ts");
    const book = async (days: number) => {
      const original = charge({ usedAt: NOW - days * DAY, priceSource: "unresolved", costNano: nano(0) });
      await insert(original);
      const work = await openWork({ ownerType: "call", ownerId: original.ownerId });
      return settleCharge(ledger(), { chargeId: original.id, final: { kind: "dollars", costNano: nano(700) }, now: NOW, doneWork: work });
    };
    expect(await book(LEDGER_LATE_BOOKING_DAYS - 1)).toMatchObject({ status: "settled" });
    expect(warned).toEqual([]);
    expect(await book(LEDGER_LATE_BOOKING_DAYS + 1)).not.toMatchObject({ status: "settled" });
    expect(warned).toEqual([
      expect.objectContaining({
        message: "ledger_booking_too_late",
        app: "app_retention",
        ownerType: "call",
        kind: "correction",
        usageDay: utcDay(NOW - (LEDGER_LATE_BOOKING_DAYS + 1) * DAY),
        costNano: 700,
      }),
    ]);
    expect((await rows("SELECT SUM(cost_nano) AS cost FROM usage_day"))[0]?.cost).toBe(700);
  });

  it("is judged at the time of writing, not the row's own write time", async () => {
    const codes = warningCodes();
    const late = charge({ usedAt: OLD });
    await ledger().batch([insertChargeStatement(ledger(), late, NOW)]);
    expect(await chargeIds()).toEqual([]);
    expect(codes).toEqual(["ledger_booking_too_late"]);
  });

  it("is about three times the longest wait any booking has on purpose, and well inside retention", () => {
    // The failed-write store's keep, the sweep's longest run of tries (a job's saved figure), and a job's checks.
    // Not a session's length: nothing serves sessions yet. The session relay must cap a
    // session far below this window, and add that cap here, before it is wired.
    let figureTries = 0;
    for (let tries = 1; tries < FIGURE_MAX_TRIES; tries += 1) figureTries += retryDelay(tries);
    let otherWork = 0;
    for (let tries = 1; tries < SWEEP_MAX_TRIES; tries += 1) otherWork += retryDelay(tries);
    const jobChecks = JOB_MAX_CHECKS * JOB_CHECK_EVERY_MS;
    const longest = Math.max(STORE_RETENTION_MS, figureTries, otherWork, jobChecks);
    expect(3 * longest).toBeLessThanOrEqual(LEDGER_LATE_BOOKING_DAYS * DAY);
    expect(LEDGER_LATE_BOOKING_DAYS).toBeLessThan(USAGE_DETAIL_RETENTION_DAYS);
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

    const result = await runUsageRetention(ledger(), NOW, budget());

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

    await runUsageRetention(ledger(), NOW, budget());

    expect(await rows("SELECT id FROM session")).toEqual([{ id }]);
  });
});

describe("usage retention: budget totals", () => {
  it("deletes budget totals past 90 days and keeps this month's", async () => {
    await insert(charge({ usedAt: OLD }), charge({ usedAt: NOW - DAY }));
    expect(await rows("SELECT COUNT(*) AS n FROM budget_day")).toEqual([{ n: 4 }]);

    await runUsageRetention(ledger(), NOW, budget());

    expect(await rows("SELECT DISTINCT day FROM budget_day")).toEqual([{ day: utcDay(NOW - DAY) }]);
  });
});

describe("usage retention: day rollups into months", () => {
  async function day(dayText: string, fields: { app?: string; cost?: number; ms?: number; outcome?: string } = {}): Promise<void> {
    await ledger().prepare(
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

    const result = await runUsageRetention(ledger(), NOW, budget(), 2);

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

    const result = await runUsageRetention(ledger(), NOW, budget(), 2);

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
      // Eight statements: one each for the five delete passes, which have nothing to do, and one chunk of the fold.
      const result = await runUsageRetention(ledger(), NOW, new QueryBudget(8), 2);
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
      await ledger().prepare(
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

      const result = await runUsageRetention(ledger(), NOW, budget());

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
      const result = await runUsageRetention(ledger(), NOW, budget(), 1);

      expect(result.months).toMatchObject({ caughtUp: true });
      expect(await months()).toEqual([
        { app_id: "app_huge", month: "2026-04", cost: MAX.toString(), type: "integer", charges: 2 },
        { app_id: "app_small", month: "2026-04", cost: "15", type: "integer", charges: 4 },
      ]);
      expect(await rows("SELECT COUNT(*) AS n FROM usage_day")).toEqual([{ n: 0 }]);
      expect(codes.filter((code) => code === "usage_month_total_too_large")).toHaveLength(1);
    });
    it("stops at the smallest integer too, and still folds the other keys in the same chunk (Sol 7b-2 round 3)", async () => {
      const MIN = -9223372036854775808n;
      await ledger().prepare(
        `INSERT INTO usage_month (account_id, app_id, month, provider_type, provider_connection_id, model, outcome, unit, charges, cost_nano)
         VALUES (?, 'app_low', '2026-04', 'openai', '', 'gpt-4o-mini', 'ok', '', 1, CAST(? AS INTEGER))`,
      )
        .bind(ACCOUNT_ID, MIN.toString())
        .run();
      await day("2026-04-01", { app: "app_low", cost: -1 });
      await day("2026-04-02", { app: "app_small", cost: 7 });

      const result = await runUsageRetention(ledger(), NOW, budget());

      expect(result.months).toMatchObject({ caughtUp: true });
      expect(await months()).toEqual([
        { app_id: "app_low", month: "2026-04", cost: MIN.toString(), type: "integer", charges: 3 },
        { app_id: "app_small", month: "2026-04", cost: "7", type: "integer", charges: 2 },
      ]);
      expect(await rows("SELECT COUNT(*) AS n FROM usage_day")).toEqual([{ n: 0 }]);
    });
  });

  it("adds a day that arrives later to its month row", async () => {
    await day("2026-04-01", { cost: 1_000 });
    await runUsageRetention(ledger(), NOW, budget());
    await day("2026-04-02", { cost: 500 });
    await runUsageRetention(ledger(), NOW, budget());

    expect(await rows("SELECT month, cost_nano, charges FROM usage_month")).toEqual([{ month: "2026-04", cost_nano: 1_500, charges: 4 }]);
    expect(await rows("SELECT COUNT(*) AS n FROM usage_day")).toEqual([{ n: 0 }]);
  });
});

describe("the query budget", () => {
  it("never issues more statements than the allowance, and goes on where it stopped the next night", async () => {
    // Of twenty statements, the first round takes one each from the four delete passes and three from the fold;
    // the charges then have the thirteen left, so fifteen chunks of two rows the first night.
    await insert(...Array.from({ length: 36 }, () => charge({ usedAt: OLD })));
    const allowances: number[] = [];
    let runs = 0;
    while ((await chargeIds()).length > 0) {
      runs += 1;
      expect(runs).toBeLessThan(10);
      const nightly = new QueryBudget(20);
      const result = await runUsageRetention(ledger(), NOW, nightly, 2);
      allowances.push(nightly.spent);
      expect(nightly.spent).toBeLessThanOrEqual(20);
      if (runs === 1) expect(result.charges?.caughtUp).toBe(false);
    }
    expect(runs).toBe(2);
    expect(allowances.every((spent) => spent <= 20)).toBe(true);
  });

  it("gives every pass its turn, however large the charge backlog", async () => {
    await insert(...Array.from({ length: 40 }, () => charge({ usedAt: OLD })));
    await ledger().prepare(
      `INSERT INTO usage_day (account_id, app_id, day, provider_type, provider_connection_id, model, outcome, unit, cost_nano)
       VALUES (?, 'app_share', '2026-01-10', 'openai', '', '', 'ok', '', 9)`,
    )
      .bind(ACCOUNT_ID)
      .run();

    const result = await runUsageRetention(ledger(), NOW, new QueryBudget(20), 2);

    expect(result.charges?.caughtUp).toBe(false);
    expect(result.months).toMatchObject({ caughtUp: true });
    expect(await rows("SELECT month, cost_nano FROM usage_month")).toEqual([{ month: "2026-01", cost_nano: 9 }]);
  });

  it("lowers a setting above D1's 1,000 queries a run to 1,000, with a warning", () => {
    const codes = warningCodes();
    const nightly = maintenanceStatementBudget({ ...env, MAINTENANCE_QUERY_BUDGET: "10000" } as Env);
    expect(nightly.limit).toBe(MAXIMUM_MAINTENANCE_STATEMENTS - MAINTENANCE_SLACK_STATEMENTS);
    expect(codes).toEqual(["maintenance_query_budget_capped"]);
    expect(maintenanceStatementBudget({ ...env, MAINTENANCE_QUERY_BUDGET: "400" } as Env).limit).toBe(400 - MAINTENANCE_SLACK_STATEMENTS);
  });

  it("reads the row allowance, lowering one too large and ignoring one too small, with a warning", () => {
    const codes = warningCodes();
    expect(maintenanceRowLimit(env)).toBe(DEFAULT_MAINTENANCE_ROWS);
    expect(maintenanceRowLimit({ ...env, MAINTENANCE_ROW_BUDGET: "50000" } as Env)).toBe(50_000);
    expect(maintenanceRowLimit({ ...env, MAINTENANCE_ROW_BUDGET: "999999999" } as Env)).toBe(MAXIMUM_MAINTENANCE_ROWS);
    expect(maintenanceRowLimit({ ...env, MAINTENANCE_ROW_BUDGET: "10" } as Env)).toBe(DEFAULT_MAINTENANCE_ROWS);
    expect(codes).toEqual(["maintenance_row_budget_capped", "maintenance_row_budget_invalid"]);
  });

  it("accepts no fewer statements than the hourly clean-up and one round of every pass need", () => {
    const round = nightlyPasses(NOW).reduce((sum, pass) => sum + pass.statements, 0);
    expect(MINIMUM_MAINTENANCE_STATEMENTS).toBeGreaterThanOrEqual(
      MAINTENANCE_SLACK_STATEMENTS + SIGN_IN_SWEEP_STATEMENTS + CHALLENGE_SETTLE_STATEMENTS + STUCK_SESSION_STATEMENTS + round,
    );
  });

  it("counts the rows D1 writes per deleted row as the row and each of its table's indexes", async () => {
    for (const [table, writes] of Object.entries(ROW_WRITES)) {
      const [indexes] = await rows("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND tbl_name = ?", table);
      expect(writes, table).toBe(1 + Number(indexes!.n));
    }
    // No trigger runs on a delete, or on an update of a month row, to write more.
    expect(await rows("SELECT name FROM sqlite_master WHERE type = 'trigger' AND (sql LIKE '%DELETE ON%' OR sql LIKE '%UPDATE ON%')")).toEqual([]);
  });

  it("reads both settings as a number or as text, and falls back on anything else without throwing (Sol 7b-2 round 4)", () => {
    const codes = warningCodes();
    const statements = (value: unknown) => maintenanceStatementBudget({ ...env, MAINTENANCE_QUERY_BUDGET: value } as unknown as Env).limit;
    const rowsOf = (value: unknown) => maintenanceRowLimit({ ...env, MAINTENANCE_ROW_BUDGET: value } as unknown as Env);
    // A Wrangler `vars` entry may be a JSON number.
    expect(statements(400)).toBe(400 - MAINTENANCE_SLACK_STATEMENTS);
    expect(rowsOf(50_000)).toBe(50_000);
    expect(statements(" 400 ")).toBe(400 - MAINTENANCE_SLACK_STATEMENTS);
    expect(rowsOf(10_000_000)).toBe(MAXIMUM_MAINTENANCE_ROWS);
    expect(codes).toEqual(["maintenance_row_budget_capped"]);
    codes.length = 0;
    for (const garbage of [true, {}, [100], "lots", 400.5, Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      expect(statements(garbage)).toBe(DEFAULT_MAINTENANCE_STATEMENTS - MAINTENANCE_SLACK_STATEMENTS);
      expect(rowsOf(garbage)).toBe(DEFAULT_MAINTENANCE_ROWS);
    }
    expect(new Set(codes)).toEqual(new Set(["maintenance_query_budget_invalid", "maintenance_row_budget_invalid"]));
    codes.length = 0;
    // Not set, null or empty: the default, quietly.
    for (const unset of [undefined, null, "", "  "]) {
      expect(statements(unset)).toBe(DEFAULT_MAINTENANCE_STATEMENTS - MAINTENANCE_SLACK_STATEMENTS);
      expect(rowsOf(unset)).toBe(DEFAULT_MAINTENANCE_ROWS);
    }
    expect(codes).toEqual([]);
  });

  it("warns of a backlog only for a pass whose last chunk was full (Sol 7b-2 round 4)", async () => {
    const codes = warningCodes();
    // Three rows, chunks of two: the first chunk is full, and the budget runs out.
    const fill = async (n: number) => {
      for (let i = 0; i < n; i++) await authEventRow(OLD);
    };
    await fill(3);
    await runPasses(ledger(), new QueryBudget(1), DEFAULT_MAINTENANCE_ROWS, [authEventsPass(NOW)], 2);
    expect(codes).toEqual(["maintenance_backlog_left"]);
    codes.length = 0;

    // One row left, chunks of two: the chunk is short, and the budget runs out
    // before the chunk that would find nothing. Very likely done: no warning.
    const results = await runPasses(ledger(), new QueryBudget(1), DEFAULT_MAINTENANCE_ROWS, [authEventsPass(NOW)], 2);
    expect(results.get("auth_events_prune")).toMatchObject({ deleted: 1, caughtUp: false, lastFull: false });
    expect(codes).toEqual([]);
  });

  it("charges the sign-in clean-up its library's statement count", () => {
    expect(SIGN_IN_SWEEP_STATEMENTS).toBe(operationSweepStatementCount + oauthSweepStatementCount);
  });
});

describe("the nightly run", () => {
  async function authEvent(createdAt: number): Promise<string> {
    const id = unique("evt");
    await ledger().prepare(
      `INSERT INTO app_auth_event (id, app_id, event, outcome, created_at) VALUES (?, 'app_retention', 'token_exchange', 'succeeded', ?)`,
    )
      .bind(id, createdAt)
      .run();
    return id;
  }

  async function rejection(createdAt: number): Promise<string> {
    const id = unique("rej");
    await ledger().prepare("INSERT INTO app_rejection_event (id, app_id, reason, created_at) VALUES (?, 'app_retention', 'model_not_allowed', ?)")
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
    await runLedgerNightly(ledger(), NOW, allowance, DEFAULT_MAINTENANCE_ROWS);

    expect(await rows("SELECT id FROM app_auth_event")).toEqual([{ id: newEvent }]);
    expect(await rows("SELECT id FROM app_rejection_event")).toEqual([{ id: newRejection }]);
    expect(await chargeIds()).toEqual([recent.id]);
    expect(allowance.spent).toBeLessThanOrEqual(49);
  });

  it("warns of sessions past the window still open with no open work left (Astra 7b-2 round 2)", async () => {
    const warned: Record<string, unknown>[] = [];
    vi.spyOn(console, "warn").mockImplementation((entry: unknown) => {
      warned.push(JSON.parse(String(entry)) as Record<string, unknown>);
    });
    const stuck = unique("ses");
    const waiting = unique("ses");
    await session(stuck, OLD, "open");
    await session(waiting, OLD, "open");
    await openWork({ ownerType: "session", ownerId: waiting });
    await session(unique("ses"), RECENT, "open");

    await runLedgerNightly(ledger(), NOW, budget(), 1_000_000);

    expect(warned.filter((entry) => entry.message === "ledger_sessions_stuck_open")).toEqual([
      expect.objectContaining({ message: "ledger_sessions_stuck_open", sessions: 1 }),
    ]);
    // All three are kept.
    expect(await rows("SELECT COUNT(*) AS n FROM session")).toEqual([{ n: 3 }]);
  });

  it("goes on with the other jobs when one fails", async () => {
    const warnings = warningCodes();
    await insert(charge({ usedAt: OLD }));
    await authEvent(OLD);
    await rejection(OLD);
    // A database on which deleting auth events fails.
    const failing = new Proxy(ledger(), {
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

    await runLedgerNightly(failing, NOW, new QueryBudget(49), DEFAULT_MAINTENANCE_ROWS);

    expect(warnings).toContain("auth_events_prune_failed");
    expect(await chargeIds()).toEqual([]);
    expect(await rows("SELECT id FROM app_rejection_event")).toEqual([]);
  });

  it("deletes a backlog of events larger than a chunk over several statements", async () => {
    for (let index = 0; index < 12_000; index += 4_000) {
      await ledger().prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4000)
         INSERT INTO app_rejection_event (id, app_id, reason, created_at) SELECT 'bulk_' || (? + i), 'app_retention', 'model_not_allowed', ? FROM n`,
      )
        .bind(index, OLD)
        .run();
    }
    const allowance = new QueryBudget(49);

    await runLedgerNightly(ledger(), NOW, allowance, MAXIMUM_MAINTENANCE_ROWS);

    expect(await rows("SELECT COUNT(*) AS n FROM app_rejection_event")).toEqual([{ n: 0 }]);
  });

  /** `count` events past their retention in `table`, written in one statement. */
  async function bulkEvents(table: "app_auth_event" | "app_rejection_event", count: number): Promise<void> {
    const columns =
      table === "app_auth_event"
        ? "(id, app_id, event, outcome, created_at) SELECT 'bulk_auth_' || i, 'app_retention', 'token_exchange', 'succeeded', ?"
        : "(id, app_id, reason, created_at) SELECT 'bulk_rej_' || i, 'app_retention', 'model_not_allowed', ?";
    await ledger().prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO ${table} ${columns} FROM n`)
      .bind(count, OLD)
      .run();
  }

  it("stops at the row allowance with both event tables backlogged, and every other pass still gets its turn (Sol 7b-2 round 3)", async () => {
    const codes = warningCodes();
    await bulkEvents("app_auth_event", 3_000);
    await bulkEvents("app_rejection_event", 3_000);
    await insert(charge({ usedAt: OLD }));
    await ledger().prepare(
      `INSERT INTO usage_day (account_id, app_id, day, provider_type, provider_connection_id, model, outcome, unit, cost_nano)
       VALUES (?, 'app_turns', '2026-01-10', 'openai', '', '', 'ok', '', 9)`,
    )
      .bind(ACCOUNT_ID)
      .run();
    // The charge's budget totals: one for the app, one for its user.
    const budgetDays = Number((await rows("SELECT COUNT(*) AS n FROM budget_day"))[0]!.n);

    await runLedgerNightly(ledger(), NOW, new QueryBudget(49), DEFAULT_MAINTENANCE_ROWS);

    const [auth] = await rows("SELECT COUNT(*) AS n FROM app_auth_event");
    const [rejections] = await rows("SELECT COUNT(*) AS n FROM app_rejection_event");
    const authDeleted = 3_000 - Number(auth!.n);
    const rejectionsDeleted = 3_000 - Number(rejections!.n);
    // The passes after the events ran: the charge, its budget total and the old day are gone.
    expect(await chargeIds()).toEqual([]);
    expect(budgetDays).toBeGreaterThan(0);
    expect(await rows("SELECT COUNT(*) AS n FROM budget_day")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT month, cost_nano FROM usage_month")).toEqual([{ month: "2026-01", cost_nano: 9 }]);
    // Within the allowance, the charge, its budget total, the old day and its month row included, and most of it used.
    const written =
      authDeleted * ROW_WRITES.app_auth_event +
      rejectionsDeleted * ROW_WRITES.app_rejection_event +
      ROW_WRITES.charge +
      budgetDays * ROW_WRITES.budget_day +
      ROW_WRITES.usage_day +
      ROW_WRITES.usage_month;
    expect(written).toBeLessThanOrEqual(DEFAULT_MAINTENANCE_ROWS);
    expect(written).toBeGreaterThan(DEFAULT_MAINTENANCE_ROWS * 0.9);
    // Both tables had their turns.
    expect(Number(auth!.n)).toBeLessThan(3_000);
    expect(Number(rejections!.n)).toBeLessThan(3_000);
    expect(codes).toEqual(["maintenance_backlog_left"]);
  });

  it("deletes one expired row of every kind with the smallest allowances it accepts (Sol 7b-2 round 3)", async () => {
    const codes = warningCodes();
    await authEvent(OLD);
    await rejection(OLD);
    await openWork({ ownerType: "call", ownerId: unique("call"), gaveUpAt: OLD });
    await insert(charge({ usedAt: OLD }));
    await session(unique("ses"), OLD, "settled");
    await ledger().prepare(
      `INSERT INTO usage_day (account_id, app_id, day, provider_type, provider_connection_id, model, outcome, unit, cost_nano)
       VALUES (?, 'app_smallest', '2026-01-10', 'openai', '', '', 'ok', '', 9)`,
    )
      .bind(ACCOUNT_ID)
      .run();
    const smallest = {
      ...env,
      MAINTENANCE_QUERY_BUDGET: String(MINIMUM_MAINTENANCE_STATEMENTS),
      MAINTENANCE_ROW_BUDGET: String(MINIMUM_MAINTENANCE_ROWS),
    } as Env;

    // As the ledger object runs it, with the deployment's allowances, per account.
    await runLedgerNightly(ledger(), Date.parse(`2027-06-15T0${NIGHTLY_HOUR_UTC}:17:00Z`), maintenanceStatementBudget(smallest), maintenanceRowLimit(smallest));

    for (const table of ["app_auth_event", "app_rejection_event", "open_work", "charge", "session", "budget_day"]) {
      expect(await rows(`SELECT COUNT(*) AS n FROM ${table}`), table).toEqual([{ n: 0 }]);
    }
    // The old day moved into its month; the charge's own day, 95 days back, stays a day.
    expect(await rows("SELECT day FROM usage_day")).toEqual([{ day: utcDay(OLD) }]);
    expect(await rows("SELECT month, cost_nano FROM usage_month")).toEqual([{ month: "2026-01", cost_nano: 9 }]);
    expect(codes).toEqual([]);
  });

  it("goes on with the other usage passes when one fails", async () => {
    const warnings = warningCodes();
    await insert(charge({ usedAt: OLD }));
    await session(unique("ses"), OLD, "settled");
    // A database on which every statement about charges fails.
    const failing = new Proxy(ledger(), {
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

  it("leaves the ledger to its objects: the hourly cron cleans up challenges every hour, and never touches charges", async () => {
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
    expect(await env.DB.prepare("SELECT challenge FROM app_auth_challenge WHERE app_id = ?").bind(appId).all().then((r) => r.results)).toEqual([]);

    const nightly = createExecutionContext();
    await worker.scheduled!(createScheduledController({ cron: "17 * * * *", scheduledTime: at(NIGHTLY_HOUR_UTC) }), env, nightly);
    await waitOnExecutionContext(nightly);
    // The account's ledger object deletes it on its own alarm (`runLedgerNightly`), not the cron.
    expect(await chargeIds()).toHaveLength(1);
  });
});

describe("retention queries", () => {
  const plan = async (sql: string, ...params: unknown[]) =>
    (await rows(`EXPLAIN QUERY PLAN ${sql}`, ...params)).map((row) => String(row.detail)).join("\n");

  it("picks every pass's rows through an index, never a scan of the whole table", async () => {
    const rules = usageRetentionRules(NOW);
    const indexes = {
      gaveUpWork: "open_work_gave_up",
      corrections: "charge_correction_day",
      charges: "charge_usage_day",
      sessions: "session_started",
      budgetDays: "budget_day_day",
    };
    for (const [name, rule] of Object.entries(rules)) {
      const detail = await plan(`${rule.rowids} LIMIT 1`, ...rule.params);
      expect(detail, name).toContain(indexes[name as keyof typeof indexes]);
    }
    // The owner checks go through the owner's index, never a scan.
    for (const rule of [rules.corrections, rules.charges]) {
      const detail = await plan(`${rule.rowids} LIMIT 1`, ...rule.params);
      expect(detail).toContain("charge_owner");
      expect(detail).toContain("open_work_owner");
      expect(detail).not.toMatch(/SCAN (charge|open_work)\b(?! USING)/u);
    }
    expect(await plan(FOLD_PICK, "2026-05-01", 1)).toContain("usage_day_day");
    expect(await plan("SELECT rowid FROM app_auth_event WHERE created_at < ? LIMIT 1", NOW)).toContain("app_auth_event_created");
    expect(await plan("SELECT rowid FROM app_rejection_event WHERE created_at < ? LIMIT 1", NOW)).toContain("app_rejection_event_created");
  });
});

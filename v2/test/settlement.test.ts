/**
 * Settlement, checkpoints, corrections and the sweep, proven with made-up
 * charges of every kind before real providers use them (plan step 1c; the
 * numbered tests are those of v2-prep/admission-and-settlement.md, section 2).
 * Test 1 (the same charge twice counts once) is in ledger.test.ts.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, runDurableObjectAlarm, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { priceUnresolvedCharge, settleCharge, settleJob } from "../src/ledger/corrections.ts";
import {
  BARRIER_WAIT_MS,
  closeSession,
  openSession,
  settleSession,
  STALE_SESSION_GRACE_MS,
  writeCheckpoint,
  type SessionRow,
} from "../src/ledger/sessions.ts";
import { OPEN_WORK_HANDLERS, runSweep, SWEEP_CRON, SWEEP_MAX_TRIES, type OpenWorkHandler } from "../src/ledger/sweep.ts";
import { LEDGER_LATE_BOOKING_DAYS } from "../src/ledger/late-booking.ts";
import { recordLedgerEntry, utcDay, type ChargeRow } from "../src/ledger/write.ts";
import { nano } from "../src/money.ts";
import worker from "../src/index.ts";
import { ACCOUNT_ID, seedAccount, seedApp, writeAtTheirTime } from "./helpers.ts";

const T0 = Date.parse("2026-11-19T10:00:00Z");
let counter = 0;
const unique = (prefix: string) => `${prefix}_${++counter}_${crypto.randomUUID().slice(0, 6)}`;

afterEach(() => {
  vi.restoreAllMocks();
});

function charge(fields: Partial<ChargeRow> & Pick<ChargeRow, "id" | "appId">): ChargeRow {
  return {
    kind: "attempt",
    accountId: ACCOUNT_ID,
    endUserId: null,
    installId: null,
    appleAccountId: null,
    appKeyId: null,
    ownerType: "call",
    ownerId: fields.id,
    seq: 1,
    providerType: "openai",
    providerConnectionId: null,
    operation: "test.op",
    preset: null,
    model: "gpt-4o-mini",
    status: "ok",
    httpStatus: 200,
    errorCode: null,
    costNano: nano(1_000),
    measured: "complete",
    priceSource: "list_rate",
    priceIsEstimate: false,
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
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
    usedAt: T0,
    usageDay: utcDay(T0),
    writtenAt: T0,
    ...fields,
  };
}

function sessionRow(fields: Partial<SessionRow> = {}): SessionRow {
  return {
    id: unique("ses"),
    accountId: ACCOUNT_ID,
    appId: unique("app_ses"),
    endUserId: null,
    installId: null,
    appleAccountId: null,
    appKeyId: null,
    providerType: "elevenlabs",
    providerConnectionId: null,
    operation: "elevenlabs.agent",
    model: null,
    mode: "relayed",
    slot: "conversational",
    timeCapMs: 30 * 60 * 1000,
    startedAt: T0,
    expectsSessionTotal: true,
    ...fields,
  };
}

function slice(session: SessionRow, seq: number, cost: number, fields: Partial<ChargeRow> = {}): ChargeRow {
  return charge({
    id: `${session.id}:slice:${seq}`,
    appId: session.appId,
    kind: "slice",
    ownerType: "session",
    ownerId: session.id,
    seq,
    providerType: session.providerType,
    providerConnectionId: session.providerConnectionId,
    operation: session.operation,
    model: session.model,
    endUserId: session.endUserId,
    costNano: nano(cost),
    sessionMs: 60_000,
    priceSource: "list_rate",
    measured: "estimated",
    usedAt: T0 + seq * 60_000,
    usageDay: utcDay(T0 + seq * 60_000),
    ...fields,
  });
}

async function checkpoint(session: SessionRow, seq: number, cost: number, extra: Partial<Parameters<typeof writeCheckpoint>[1]> = {}) {
  return writeCheckpoint(env.DB, { session, slice: slice(session, seq, cost), budgets: [], planMinutes: null, now: T0 + seq * 60_000, ...extra });
}

async function appCost(appId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COALESCE(SUM(cost_nano), 0) AS cost FROM usage_day WHERE app_id = ?").bind(appId).first<{ cost: number }>();
  return row?.cost ?? 0;
}

async function chargesOf(ownerId: string) {
  return (
    await env.DB.prepare("SELECT id, kind, cost_nano, usage_day, correction_kind, session_ms FROM charge WHERE owner_id = ? ORDER BY written_at, id")
      .bind(ownerId)
      .all()
  ).results;
}

async function sessionState(id: string) {
  return env.DB.prepare("SELECT state, final_slice, settlement, session_total_nano, end_reason FROM session WHERE id = ?").bind(id).first();
}

function quiet(): void {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
}

describe("corrections", () => {
  it("2: a client poll and the sweep settling one job at once write one correction", async () => {
    const appId = unique("app_job");
    const jobId = unique("job");
    await writeAtTheirTime([
      { charge: charge({ id: `${jobId}:estimate`, appId, kind: "estimate", ownerType: "job", ownerId: jobId, costNano: nano(5_000), measured: "estimated" }), openWork: [] },
    ]);
    const final = { kind: "dollars" as const, costNano: nano(7_250) };
    const results = await Promise.all([
      settleJob(env.DB, { jobId, final, now: T0 + 1 }),
      settleJob(env.DB, { jobId, final, now: T0 + 2 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["already", "settled"]);
    expect(await chargesOf(jobId)).toMatchObject([{ kind: "estimate", cost_nano: 5_000 }, { kind: "correction", cost_nano: 2_250 }]);
    expect(await appCost(appId)).toBe(7_250);
  });

  it("3: a units correction uses the rates stored on the charge, not today's price file", async () => {
    const appId = unique("app_units");
    const id = unique("req");
    // Stored rates: $1 and $2 per million (today's list price for this model differs).
    const original = charge({ id, appId, costNano: nano(1_000 + 2_000), rates: { input: 1_000_000, output: 2_000_000 }, units: 3_000, unit: "tokens" });
    await writeAtTheirTime([{ charge: original, openWork: [] }]);
    const result = await settleCharge(env.DB, { chargeId: id, final: { kind: "units", buckets: { input: 1_500, output: 1_000 }, units: 2_500 }, now: T0 });
    expect(result).toMatchObject({ status: "settled", correction: { costNano: 500, units: -500, correctionKind: "units" } });
    // The original plus its correction is the final figure, exactly.
    expect(await appCost(appId)).toBe(1_500 + 2_000);
    expect(await settleCharge(env.DB, { chargeId: id, final: { kind: "units", buckets: { input: 9 } }, now: T0 })).toEqual({ status: "already" });
  });

  it("settles units at a unit rate with the cost formula the live charge uses", async () => {
    const appId = unique("app_fal");
    const id = unique("req");
    // fal at $0.05 per billable unit, estimated at 0 units; it reports 2.5 units.
    const original = charge({ id, appId, costNano: nano(0), rates: { per_unit: 50_000_000 }, units: 0, unit: "model_units" });
    await writeAtTheirTime([{ charge: original, openWork: [] }]);
    const result = await settleCharge(env.DB, { chargeId: id, final: { kind: "units", buckets: { per_unit: 2_500 }, units: 2_500 }, now: T0 });
    // 2.5 × $0.05 = $0.125, as a live charge on the same count costs (test/pricing-derived-checks.test.ts).
    expect(result).toMatchObject({ status: "settled", correction: { costNano: 125_000_000 } });
    expect(await appCost(appId)).toBe(125_000_000);
  });

  it("refuses a units figure for a bucket the charge has no stored rate for", async () => {
    const appId = unique("app_norate");
    const id = unique("req");
    await writeAtTheirTime([{ charge: charge({ id, appId, rates: { input: 1 } }), openWork: [] }]);
    expect(await settleCharge(env.DB, { chargeId: id, final: { kind: "units", buckets: { images: 2 } }, now: T0 })).toEqual({
      status: "no_rate",
      bucket: "images",
    });
  });

  it("8: a job estimate still in the failed-write store waits, and settles once it is written", async () => {
    quiet();
    const appId = unique("app_store_job");
    const jobId = unique("job");
    const estimate = charge({ id: `${jobId}:estimate`, appId, kind: "estimate", ownerType: "job", ownerId: jobId, costNano: nano(4_000) });
    const failing = { batch: () => Promise.reject(new Error("D1 down")) } as unknown as D1Database;
    await recordLedgerEntry({ ...env, DB: failing } as Env, { charge: estimate, openWork: [] });
    const store = env.CHARGE_STORE.getByName(appId);
    expect(await store.pendingCount()).toBe(1);

    const final = { kind: "dollars" as const, costNano: nano(3_000) };
    expect(await settleJob(env.DB, { jobId, final, now: T0 })).toEqual({ status: "charge_missing" });
    expect(await runDurableObjectAlarm(store)).toBe(true);
    expect(await settleJob(env.DB, { jobId, final, now: T0 })).toMatchObject({ status: "settled" });
    expect(await appCost(appId)).toBe(3_000);
  });

  it("9: an unresolved charge is priced by a correction once a price appears, keeping its usage date", async () => {
    await seedAccount();
    const appId = unique("app_unres");
    const connectionId = unique("conn");
    await env.DB.prepare(
      "INSERT INTO provider_connection (id, account_id, type, slug, name, created_by, created_at, updated_at) VALUES (?, ?, 'openai', ?, 'T', 't', ?, ?)",
    )
      .bind(connectionId, ACCOUNT_ID, connectionId, T0, T0)
      .run();
    const id = unique("req");
    const yesterday = T0 - 86_400_000;
    await writeAtTheirTime([
      {
        charge: charge({
          id, appId, providerConnectionId: connectionId, model: "made-up-model", costNano: null, priceSource: "unresolved",
          inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 500, usedAt: yesterday, usageDay: utcDay(yesterday),
        }),
        openWork: [],
      },
    ]);
    expect(await priceUnresolvedCharge(env.DB, { chargeId: id, now: T0 })).toEqual({ status: "no_price" });
    // The customer adds a rate: $2 input, $8 output per million.
    await env.DB.prepare("UPDATE provider_connection SET rates_json = ? WHERE id = ?")
      .bind(JSON.stringify({ "made-up-model": { input: 2_000_000, output: 8_000_000 } }), connectionId)
      .run();
    const priced = await priceUnresolvedCharge(env.DB, { chargeId: id, now: T0 });
    expect(priced).toMatchObject({ status: "priced", correction: { costNano: 2_000 + 4_000, priceSource: "customer_rate", usageDay: utcDay(yesterday) } });
    expect(await priceUnresolvedCharge(env.DB, { chargeId: id, now: T0 })).toEqual({ status: "already" });
    expect(await appCost(appId)).toBe(6_000);
  });
});

describe("checkpoints", () => {
  it("11: a repeated checkpoint id still answers stop, without counting the slice twice", async () => {
    const session = sessionRow({ expectsSessionTotal: false });
    const budgets = [{ scope: "app" as const, scopeId: session.appId, limitNano: nano(1_000) }];
    const first = await checkpoint(session, 1, 1_500, { budgets });
    expect(first).toEqual({ decision: "stop", reasons: ["budget_stop"], written: true });
    // The "stop" reply was lost; the relay sends the same slice again.
    expect(await checkpoint(session, 1, 1_500, { budgets })).toEqual(first);
    expect(await appCost(session.appId)).toBe(1_500);
  });

  it("writes the session row on the first checkpoint if its own write failed, and marks it active", async () => {
    const session = sessionRow();
    expect(await checkpoint(session, 1, 100)).toEqual({ decision: "continue", written: true });
    expect(await sessionState(session.id)).toMatchObject({ state: "active", settlement: "open" });
    const work = await env.DB.prepare("SELECT kind, due_at FROM open_work WHERE owner_id = ?").bind(session.id).first();
    expect(work).toEqual({ kind: "stale_session", due_at: T0 + session.timeCapMs + STALE_SESSION_GRACE_MS });
  });

  it("a checkpoint or close replayed after retention deleted its session books nothing, and tells the relay to stop (Astra 7b-2 round 4)", async () => {
    const warned: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => void warned.push(String(line)));
    const session = sessionRow({ expectsSessionTotal: false });
    expect(await checkpoint(session, 1, 1_000)).toEqual({ decision: "continue", written: true });
    const before = await env.DB.prepare("SELECT charges, cost_nano, session_ms FROM usage_day WHERE app_id = ?").bind(session.appId).all();
    expect(before.results).toEqual([{ charges: 1, cost_nano: 1_000, session_ms: 60_000 }]);
    // Retention deletes the session's work, its slice and its row; the day rollup stays.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM open_work WHERE owner_id = ?").bind(session.id),
      env.DB.prepare("DELETE FROM charge WHERE owner_id = ?").bind(session.id),
      env.DB.prepare("DELETE FROM session WHERE id = ?").bind(session.id),
    ]);
    const day91 = T0 + 91 * 86_400_000;
    expect(await checkpoint(session, 1, 1_000, { now: day91 })).toEqual({ decision: "stop", reasons: ["ended"], written: true });
    await closeSession(env.DB, { session, finalSlice: 1, endReason: "client_closed", endedAt: day91, now: day91 });
    expect(await sessionState(session.id)).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM charge WHERE owner_id = ?").bind(session.id).all()).toMatchObject({ results: [] });
    expect(await env.DB.prepare("SELECT id FROM open_work WHERE owner_id = ?").bind(session.id).all()).toMatchObject({ results: [] });
    expect((await env.DB.prepare("SELECT charges, cost_nano, session_ms FROM usage_day WHERE app_id = ?").bind(session.appId).all()).results).toEqual(
      before.results,
    );
    // One warning, from the slice's insert: its day is too late for the ledger.
    expect(warned.filter((line) => line.includes('"message":"ledger_booking_too_late"'))).toHaveLength(1);
  });

  it("books a slice inside the window even when its session started a day earlier, past it (Astra 7b-2 date rule)", async () => {
    // The session starts a minute before midnight; its unbooked slice is dated just after.
    const midnight = Date.parse("2026-11-20T00:00:00Z");
    const session = sessionRow({ expectsSessionTotal: false, startedAt: midnight - 60_000 });
    const first = slice(session, 1, 1_000, { usedAt: midnight - 30_000, usageDay: utcDay(midnight - 30_000) });
    expect(await writeCheckpoint(env.DB, { session, slice: first, budgets: [], planMinutes: null, now: midnight - 30_000 })).toMatchObject({
      written: true,
    });
    const late = slice(session, 2, 2_000, { usedAt: midnight + 30_000, usageDay: utcDay(midnight + 30_000) });
    // Replayed 30 days on: the slice's own day is inside the window, its session's start is not.
    const answer = await writeCheckpoint(env.DB, { session, slice: late, budgets: [], planMinutes: null, now: midnight + 30 * 86_400_000 + 60_000 });
    expect(answer).toMatchObject({ written: true });
    expect(await chargesOf(session.id)).toHaveLength(2);
  });

  it("a slice replayed while retention has deleted it but not yet its ended session books nothing (Astra 7b-2 round 5)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = sessionRow({ expectsSessionTotal: false });
    expect(await checkpoint(session, 1, 1_000)).toEqual({ decision: "continue", written: true });
    await closeSession(env.DB, { session, finalSlice: 1, endReason: "client_closed", endedAt: T0, now: T0 });
    const rollup = () => env.DB.prepare("SELECT charges, cost_nano, session_ms FROM usage_day WHERE app_id = ?").bind(session.appId).all();
    const before = (await rollup()).results;
    // The sweep settles it; then retention's first chunk deletes the slice, and the
    // settled session row waits for a later one.
    await env.DB.prepare("UPDATE session SET settlement = 'settled' WHERE id = ?").bind(session.id).run();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM open_work WHERE owner_id = ?").bind(session.id),
      env.DB.prepare("DELETE FROM charge WHERE owner_id = ?").bind(session.id),
    ]);
    expect(await sessionState(session.id)).toMatchObject({ state: "ended" });
    await checkpoint(session, 1, 1_000, { now: T0 + 91 * 86_400_000 });
    expect(await env.DB.prepare("SELECT id FROM charge WHERE owner_id = ?").bind(session.id).all()).toMatchObject({ results: [] });
    expect((await rollup()).results).toEqual(before);
  });

  it("books a slice for a session started inside the late-booking window, and none for one started before it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warned: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => void warned.push(String(line)));
    const count = (id: string) => env.DB.prepare("SELECT COUNT(*) AS n FROM charge WHERE owner_id = ?").bind(id).first("n");
    const inside = sessionRow({ expectsSessionTotal: false, startedAt: T0 - (LEDGER_LATE_BOOKING_DAYS - 1) * 86_400_000 });
    expect(await checkpoint(inside, 1, 1_000)).toEqual({ decision: "continue", written: true });
    expect(await count(inside.id)).toBe(1);
    expect(warned).toEqual([]);
    // Its row never written, and too old to write now: nothing is booked, and the relay is told to stop.
    const before = sessionRow({ expectsSessionTotal: false, startedAt: T0 - (LEDGER_LATE_BOOKING_DAYS + 1) * 86_400_000 });
    expect(await checkpoint(before, 1, 1_000)).toEqual({ decision: "stop", reasons: ["ended"], written: true });
    expect(await count(before.id)).toBe(0);
    expect(warned.filter((line) => line.includes('"message":"ledger_booking_too_late"'))).toHaveLength(1);
  });

  it("answers stop when the plan minutes, the user, the key or a newer session say so", async () => {
    await seedAccount();
    const appId = await seedApp({ type: "api_key", end_user: { source: "header", header: "x-end-user-id" } });
    const connectionId = unique("conn");
    await env.DB.prepare(
      "INSERT INTO provider_connection (id, account_id, type, slug, name, status, created_by, created_at, updated_at) VALUES (?, ?, 'openai', ?, 'T', 'disabled', 't', ?, ?)",
    )
      .bind(connectionId, ACCOUNT_ID, connectionId, T0, T0)
      .run();
    await env.DB.prepare("INSERT INTO app_end_user (app_id, id, status, created_at) VALUES (?, 'u1', 'blocked', ?)").bind(appId, T0).run();
    const session = sessionRow({ appId, endUserId: "u1", providerConnectionId: connectionId });
    const answer = await checkpoint(session, 1, 100, { planMinutes: { fromDay: "2026-11-01", toDay: "2026-12-01", limitMs: 60_000 } });
    expect(answer).toEqual({ decision: "stop", reasons: ["allowance_used_up", "user_blocked", "key_removed"], written: true });
    await env.DB.prepare("UPDATE session SET replaced_by = 'newer' WHERE id = ?").bind(session.id).run();
    expect(await checkpoint(session, 2, 100)).toMatchObject({ decision: "stop", reasons: expect.arrayContaining(["replaced"]) });
  });

  it("12: a failed checkpoint batch lets the session continue, and leaves the slice to the relay's journal", async () => {
    quiet();
    const session = sessionRow();
    const failing = { prepare: env.DB.prepare.bind(env.DB), batch: () => Promise.reject(new Error("D1 down")) } as unknown as D1Database;
    expect(await writeCheckpoint(failing, { session, slice: slice(session, 1, 100), budgets: [], planMinutes: null, now: T0 })).toEqual({
      decision: "continue",
      written: false,
    });
    expect(await env.CHARGE_STORE.getByName(session.appId).pendingCount()).toBe(0);
  });

  it("counts a slice's session time toward plan minutes, and a correction never changes it", async () => {
    const session = sessionRow();
    await checkpoint(session, 1, 100);
    await closeSession(env.DB, { session, finalSlice: 1, endReason: "client_closed", endedAt: T0 + 70_000, now: T0 + 70_000 });
    await settleSession(env.DB, { sessionId: session.id, providerTotal: nano(500), now: T0 + 80_000 });
    const minutes = await env.DB.prepare("SELECT COALESCE(SUM(session_ms), 0) AS ms FROM usage_day WHERE app_id = ?").bind(session.appId).first();
    expect(minutes).toEqual({ ms: 60_000 });
  });
});

describe("the settlement barrier", () => {
  it("4: waits for the final slice, then subtracts all of them from the provider's total", async () => {
    const session = sessionRow();
    for (const seq of [1, 2, 3]) await checkpoint(session, seq, 1_000);
    const endedAt = T0 + 5 * 60_000;
    await closeSession(env.DB, { session, finalSlice: 4, endReason: "client_closed", endedAt, now: endedAt });
    expect(await settleSession(env.DB, { sessionId: session.id, providerTotal: nano(10_000), now: endedAt + 1_000 })).toBe("waiting");
    await checkpoint(session, 4, 1_000);
    expect(await settleSession(env.DB, { sessionId: session.id, providerTotal: nano(10_000), now: endedAt + 2_000 })).toBe("settled");
    expect((await chargesOf(session.id)).at(-1)).toMatchObject({ kind: "correction", cost_nano: 10_000 - 4_000, correction_kind: "dollars" });
    expect(await appCost(session.appId)).toBe(10_000);
    expect(await sessionState(session.id)).toMatchObject({ settlement: "settled", session_total_nano: 10_000 });
  });

  it("keeps the slices' estimate, and says so on the session, when the provider's total comes too late for the ledger", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warned: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => void warned.push(String(line)));
    const session = sessionRow();
    for (const seq of [1, 2]) await checkpoint(session, seq, 1_000);
    const endedAt = T0 + 3 * 60_000;
    await closeSession(env.DB, { session, finalSlice: 2, endReason: "client_closed", endedAt, now: endedAt });
    const late = endedAt + (LEDGER_LATE_BOOKING_DAYS + 1) * 86_400_000;
    expect(await settleSession(env.DB, { sessionId: session.id, providerTotal: nano(10_000), now: late })).toBe("estimate_kept");
    expect(await appCost(session.appId)).toBe(2_000);
    expect((await chargesOf(session.id)).map((c) => c.kind)).toEqual(["slice", "slice"]);
    expect(await sessionState(session.id)).toMatchObject({ settlement: "estimate_kept", session_total_nano: 10_000 });
    expect(warned.filter((line) => line.includes('"message":"ledger_booking_too_late"'))).toHaveLength(1);
  });

  it("5: settles from the slices it has after the bounded wait, and a late slice then adds $0", async () => {
    quiet();
    const session = sessionRow();
    for (const seq of [1, 2, 3]) await checkpoint(session, seq, 1_000);
    const endedAt = T0 + 5 * 60_000;
    await closeSession(env.DB, { session, finalSlice: 4, endReason: "client_closed", endedAt, now: endedAt });
    expect(await settleSession(env.DB, { sessionId: session.id, providerTotal: nano(10_000), now: endedAt + BARRIER_WAIT_MS })).toBe("settled");
    expect(await appCost(session.appId)).toBe(10_000);
    await checkpoint(session, 4, 1_000);
    expect((await chargesOf(session.id)).find((c) => c.id === `${session.id}:slice:4`)).toMatchObject({ cost_nano: 0, session_ms: 60_000 });
    expect(await appCost(session.appId)).toBe(10_000);
  });

  it("6: with no provider total, keeps the slices' estimate after the last try, and marks the session", async () => {
    quiet();
    const session = sessionRow();
    await checkpoint(session, 1, 2_000);
    await closeSession(env.DB, { session, finalSlice: 1, endReason: "client_closed", endedAt: T0 + 61_000, now: T0 + 61_000 });
    expect(await settleSession(env.DB, { sessionId: session.id, now: T0 + 90_000 })).toBe("waiting");
    expect(await settleSession(env.DB, { sessionId: session.id, now: T0 + 90_000, lastTry: true })).toBe("estimate_kept");
    expect(await sessionState(session.id)).toMatchObject({ settlement: "estimate_kept" });
    expect(await appCost(session.appId)).toBe(2_000);
  });

  it("7: a late slice adds its cost when no session-level total covers it", async () => {
    const session = sessionRow({ expectsSessionTotal: false });
    await checkpoint(session, 1, 1_000);
    const endedAt = T0 + 3 * 60_000;
    await closeSession(env.DB, { session, finalSlice: 2, endReason: "client_closed", endedAt, now: endedAt });
    expect(await settleSession(env.DB, { sessionId: session.id, now: endedAt + 1_000 })).toBe("waiting");
    expect(await settleSession(env.DB, { sessionId: session.id, now: endedAt + BARRIER_WAIT_MS })).toBe("settled");
    await checkpoint(session, 2, 700);
    expect(await appCost(session.appId)).toBe(1_700);
  });

  it("10: dates a session-level correction on the day the session ended, across midnight UTC", async () => {
    const session = sessionRow({ startedAt: Date.parse("2026-11-19T23:58:00Z") });
    await writeCheckpoint(env.DB, {
      session,
      slice: slice(session, 1, 1_000, { usedAt: Date.parse("2026-11-19T23:58:00Z"), usageDay: "2026-11-19" }),
      budgets: [],
      planMinutes: null,
      now: Date.parse("2026-11-19T23:59:00Z"),
    });
    const endedAt = Date.parse("2026-11-19T23:59:50Z");
    await closeSession(env.DB, { session, finalSlice: 1, endReason: "client_closed", endedAt, now: endedAt });
    const nextDay = Date.parse("2026-11-20T00:01:00Z");
    expect(await settleSession(env.DB, { sessionId: session.id, providerTotal: nano(3_000), now: nextDay })).toBe("settled");
    expect((await chargesOf(session.id)).at(-1)).toMatchObject({ kind: "correction", usage_day: "2026-11-19" });
  });

  it("ends a session that never closed once its cap has passed, with the slices it has", async () => {
    const session = sessionRow({ expectsSessionTotal: false });
    await checkpoint(session, 1, 1_000);
    await checkpoint(session, 2, 1_000);
    const capEnds = T0 + session.timeCapMs;
    expect(await settleSession(env.DB, { sessionId: session.id, now: capEnds })).toBe("not_closed");
    expect(await settleSession(env.DB, { sessionId: session.id, now: capEnds + STALE_SESSION_GRACE_MS })).toBe("settled");
    expect(await sessionState(session.id)).toMatchObject({ state: "ended", final_slice: 2, end_reason: "time_cap", settlement: "settled" });
  });

  it("15: a repeated close or settlement changes nothing", async () => {
    const session = sessionRow();
    await checkpoint(session, 1, 1_000);
    await closeSession(env.DB, { session, finalSlice: 1, endReason: "client_closed", endedAt: T0 + 61_000, now: T0 + 61_000 });
    await closeSession(env.DB, { session, finalSlice: 9, endReason: "error", endedAt: T0 + 99_000, now: T0 + 99_000 });
    expect(await sessionState(session.id)).toMatchObject({ final_slice: 1, end_reason: "client_closed" });
    expect(await settleSession(env.DB, { sessionId: session.id, providerTotal: nano(4_000), now: T0 + 70_000 })).toBe("settled");
    expect(await settleSession(env.DB, { sessionId: session.id, providerTotal: nano(9_000), now: T0 + 80_000 })).toBe("already");
    expect(await appCost(session.appId)).toBe(4_000);
  });
});

describe("review fixes", () => {
  it("S1: a final total that commits after the sweep kept the estimate writes nothing", async () => {
    quiet();
    const session = sessionRow();
    await checkpoint(session, 1, 1_000);
    await closeSession(env.DB, { session, finalSlice: 1, endReason: "client_closed", endedAt: T0 + 61_000, now: T0 + 61_000 });
    // The provider path reads the session open. The sweep, which read it before the total was
    // stored, keeps the estimate just before the provider path's batch commits.
    const racing = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        await env.DB.prepare("UPDATE session SET settlement = 'estimate_kept', session_total_nano = NULL WHERE id = ? AND settlement = 'open'")
          .bind(session.id)
          .run();
        return env.DB.batch(statements);
      },
    } as unknown as D1Database;
    expect(await settleSession(racing, { sessionId: session.id, providerTotal: nano(9_000), now: T0 + 70_000 })).toBe("already");
    expect(await sessionState(session.id)).toMatchObject({ settlement: "estimate_kept" });
    expect((await chargesOf(session.id)).filter((c) => c.kind === "correction")).toEqual([]);
    expect(await appCost(session.appId)).toBe(1_000);
  });

  it("S2: a final total that arrives before the last slice is kept, and the sweep applies it later", async () => {
    const session = sessionRow();
    for (const seq of [1, 2, 3]) await checkpoint(session, seq, 1_000);
    const endedAt = T0 + 5 * 60_000;
    await closeSession(env.DB, { session, finalSlice: 4, endReason: "client_closed", endedAt, now: endedAt });
    expect(await settleSession(env.DB, { sessionId: session.id, providerTotal: nano(10_000), now: endedAt + 1_000 })).toBe("waiting");
    await checkpoint(session, 4, 1_000);
    // The sweep's try carries no total of its own.
    expect(await settleSession(env.DB, { sessionId: session.id, now: endedAt + 2_000 })).toBe("settled");
    expect(await appCost(session.appId)).toBe(10_000);
  });

  it("S3: close writes a session row that was never written, ended, and a later checkpoint keeps it so", async () => {
    const session = sessionRow({ expectsSessionTotal: false });
    const endedAt = T0 + 2 * 60_000 + 5_000;
    await closeSession(env.DB, { session, finalSlice: 2, endReason: "client_closed", endedAt, now: endedAt });
    expect(await sessionState(session.id)).toMatchObject({ state: "ended", final_slice: 2, end_reason: "client_closed" });
    await checkpoint(session, 1, 500);
    await checkpoint(session, 2, 500);
    expect(await sessionState(session.id)).toMatchObject({ state: "ended", end_reason: "client_closed" });
    expect(await settleSession(env.DB, { sessionId: session.id, now: endedAt + 1_000 })).toBe("settled");
    const ended = await env.DB.prepare("SELECT ended_at FROM session WHERE id = ?").bind(session.id).first();
    expect(ended).toEqual({ ended_at: endedAt });
  });

  it("S4: pricing and a final settlement of one unresolved charge book its cost once, in either order", async () => {
    await seedAccount();
    for (const order of ["pricing first", "settlement first"] as const) {
      const appId = unique("app_both");
      const connectionId = unique("conn");
      await env.DB.prepare(
        "INSERT INTO provider_connection (id, account_id, type, slug, name, rates_json, created_by, created_at, updated_at) VALUES (?, ?, 'openai', ?, 'T', ?, 't', ?, ?)",
      )
        .bind(connectionId, ACCOUNT_ID, connectionId, JSON.stringify({ "made-up-model": { input: 2_000_000, output: 0 } }), T0, T0)
        .run();
      const id = unique("req");
      await writeAtTheirTime([
        {
          charge: charge({
            id, appId, providerConnectionId: connectionId, model: "made-up-model", costNano: null, priceSource: "unresolved",
            inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
          }),
          openWork: [],
        },
      ]);
      const settle = () => settleCharge(env.DB, { chargeId: id, final: { kind: "dollars", costNano: nano(3_000) }, now: T0 });
      const price = () => priceUnresolvedCharge(env.DB, { chargeId: id, now: T0 });
      if (order === "pricing first") {
        expect(await price()).toMatchObject({ status: "priced", correction: { costNano: 2_000 } });
        expect(await settle()).toMatchObject({ status: "settled", correction: { costNano: 1_000 } });
      } else {
        expect(await settle()).toMatchObject({ status: "settled", correction: { costNano: 3_000 } });
        expect(await price()).toEqual({ status: "already" });
      }
      expect(await appCost(appId)).toBe(3_000);
    }
  });
});

describe("review fixes, round 2", () => {
  it("S2: the first stored provider total wins over a later, different one", async () => {
    const session = sessionRow();
    for (const seq of [1, 2, 3]) await checkpoint(session, seq, 1_000);
    const endedAt = T0 + 5 * 60_000;
    await closeSession(env.DB, { session, finalSlice: 4, endReason: "client_closed", endedAt, now: endedAt });
    expect(await settleSession(env.DB, { sessionId: session.id, providerTotal: nano(10_000), now: endedAt + 1_000 })).toBe("waiting");
    await checkpoint(session, 4, 1_000);
    expect(await settleSession(env.DB, { sessionId: session.id, providerTotal: nano(9_000), now: endedAt + 2_000 })).toBe("settled");
    expect(await appCost(session.appId)).toBe(10_000);
    expect(await sessionState(session.id)).toMatchObject({ session_total_nano: 10_000 });
  });

  it("S2: the sweep's last try never clears a total the provider stored after it read the session", async () => {
    quiet();
    const session = sessionRow();
    await checkpoint(session, 1, 1_000);
    await closeSession(env.DB, { session, finalSlice: 1, endReason: "client_closed", endedAt: T0 + 61_000, now: T0 + 61_000 });
    // Just before the sweep keeps the estimate, the provider path stores its total (once).
    let raced = false;
    const racing = {
      prepare: (sql: string) => {
        const statement = env.DB.prepare(sql);
        if (raced || !sql.startsWith("UPDATE session SET settlement")) return statement;
        raced = true;
        return {
          bind: (...params: unknown[]) => {
            const bound = statement.bind(...params);
            return {
              run: async () => {
                await env.DB.prepare("UPDATE session SET session_total_nano = 7000 WHERE id = ? AND session_total_nano IS NULL").bind(session.id).run();
                return bound.run();
              },
            };
          },
        };
      },
      batch: env.DB.batch.bind(env.DB),
    } as unknown as D1Database;
    expect(await settleSession(racing, { sessionId: session.id, now: T0 + 90_000, lastTry: true })).toBe("settled");
    expect(await sessionState(session.id)).toMatchObject({ settlement: "settled", session_total_nano: 7_000 });
    expect(await appCost(session.appId)).toBe(7_000);
  });

  it("S3: closing a session that already ended and settled changes nothing", async () => {
    quiet();
    const session = sessionRow({ expectsSessionTotal: false });
    await openSession(env.DB, session, T0);
    await checkpoint(session, 1, 1_000);
    await closeSession(env.DB, { session, finalSlice: 1, endReason: "client_closed", endedAt: T0 + 61_000, now: T0 + 61_000 });
    await runSweep(env, { now: T0 + 2 * 60_000 });
    const before = await env.DB.prepare("SELECT updated_at, settlement FROM session WHERE id = ?").bind(session.id).first();
    expect(before).toMatchObject({ settlement: "settled" });
    await closeSession(env.DB, { session, finalSlice: 1, endReason: "client_closed", endedAt: T0 + 61_000, now: T0 + 5 * 60_000 });
    expect(await env.DB.prepare("SELECT updated_at, settlement FROM session WHERE id = ?").bind(session.id).first()).toEqual(before);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM open_work WHERE owner_id = ?").bind(session.id).first()).toEqual({ n: 0 });
  });

  it("S3: a repeated close never moves the sweep's next try earlier", async () => {
    quiet();
    // Waits for a provider total, so it stays unsettled after close.
    const session = sessionRow({ expectsSessionTotal: true });
    await openSession(env.DB, session, T0);
    await checkpoint(session, 1, 1_000);
    await closeSession(env.DB, { session, finalSlice: 1, endReason: "client_closed", endedAt: T0 + 61_000, now: T0 + 61_000 });
    // The sweep has moved the next try well ahead.
    const later = T0 + 60 * 60_000;
    await env.DB.prepare("UPDATE open_work SET due_at = ? WHERE owner_id = ?").bind(later, session.id).run();
    await closeSession(env.DB, { session, finalSlice: 1, endReason: "client_closed", endedAt: T0 + 61_000, now: T0 + 2 * 60_000 });
    expect(await env.DB.prepare("SELECT due_at FROM open_work WHERE owner_id = ?").bind(session.id).first()).toEqual({ due_at: later });
  });

  it("S4: a job's final settlement stops a later pricing of its unresolved estimate", async () => {
    await seedAccount();
    const appId = unique("app_job_unres");
    const connectionId = unique("conn");
    await env.DB.prepare(
      "INSERT INTO provider_connection (id, account_id, type, slug, name, rates_json, created_by, created_at, updated_at) VALUES (?, ?, 'openai', ?, 'T', ?, 't', ?, ?)",
    )
      .bind(connectionId, ACCOUNT_ID, connectionId, JSON.stringify({ "made-up-model": { input: 2_000_000, output: 0 } }), T0, T0)
      .run();
    const jobId = unique("job");
    const estimateId = `${jobId}:estimate`;
    await writeAtTheirTime([
      {
        charge: charge({
          id: estimateId, appId, kind: "estimate", ownerType: "job", ownerId: jobId, providerConnectionId: connectionId,
          model: "made-up-model", costNano: null, priceSource: "unresolved", inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
        }),
        openWork: [],
      },
    ]);
    expect(await settleJob(env.DB, { jobId, final: { kind: "dollars", costNano: nano(3_000) }, now: T0 })).toMatchObject({ status: "settled" });
    expect(await priceUnresolvedCharge(env.DB, { chargeId: estimateId, now: T0 })).toEqual({ status: "already" });
    expect(await appCost(appId)).toBe(3_000);
  });

  it("S4: a settled job estimate whose model still has no price counts as done, not as unpriced", async () => {
    await seedAccount();
    const appId = unique("app_job_noprice");
    const jobId = unique("job");
    const estimateId = `${jobId}:estimate`;
    await writeAtTheirTime([
      {
        charge: charge({
          id: estimateId, appId, kind: "estimate", ownerType: "job", ownerId: jobId,
          model: "model-with-no-price-anywhere", costNano: null, priceSource: "unresolved", inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
        }),
        openWork: [],
      },
    ]);
    expect(await settleJob(env.DB, { jobId, final: { kind: "dollars", costNano: nano(3_000) }, now: T0 })).toMatchObject({ status: "settled" });
    // Before the fix this answered no_price, so the sweep kept retrying and finally gave up on a booked charge.
    expect(await priceUnresolvedCharge(env.DB, { chargeId: estimateId, now: T0 })).toEqual({ status: "already" });
    expect(await appCost(appId)).toBe(3_000);
  });
});

describe("review fixes, Fable", () => {
  async function sessionWithUnresolvedSlice() {
    await seedAccount();
    const connectionId = unique("conn");
    await env.DB.prepare(
      "INSERT INTO provider_connection (id, account_id, type, slug, name, rates_json, created_by, created_at, updated_at) VALUES (?, ?, 'openai', ?, 'T', ?, 't', ?, ?)",
    )
      // $0.50 per 1,000 tokens: 1,000 tokens price at 500.
      .bind(connectionId, ACCOUNT_ID, connectionId, JSON.stringify({ "made-up-model": { input: 500_000_000, output: 0 } }), T0, T0)
      .run();
    const session = sessionRow({ providerConnectionId: connectionId, model: "made-up-model" });
    await checkpoint(session, 1, 1_000);
    await writeCheckpoint(env.DB, {
      session,
      slice: slice(session, 2, 0, {
        costNano: null, priceSource: "unresolved", inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
      }),
      budgets: [],
      planMinutes: null,
      now: T0 + 2 * 60_000,
    });
    await closeSession(env.DB, { session, finalSlice: 2, endReason: "client_closed", endedAt: T0 + 3 * 60_000, now: T0 + 3 * 60_000 });
    return session;
  }

  it("F1: settling first, a later pricing of an unresolved slice adds nothing on top of the session total", async () => {
    const session = await sessionWithUnresolvedSlice();
    expect(await settleSession(env.DB, { sessionId: session.id, providerTotal: nano(10_000), now: T0 + 4 * 60_000 })).toBe("settled");
    expect(await priceUnresolvedCharge(env.DB, { chargeId: `${session.id}:slice:2`, now: T0 + 5 * 60_000 })).toEqual({ status: "already" });
    expect(await appCost(session.appId)).toBe(10_000);
  });

  it("N1: a slice of a session settled with a provider total counts as done even with no price anywhere", async () => {
    const session = await sessionWithUnresolvedSlice();
    // Now the model has no price at all: before the fix, pricing answered no_price and the sweep retried until it gave up.
    await env.DB.prepare("UPDATE provider_connection SET rates_json = NULL WHERE id = ?").bind(session.providerConnectionId).run();
    expect(await settleSession(env.DB, { sessionId: session.id, providerTotal: nano(10_000), now: T0 + 4 * 60_000 })).toBe("settled");
    expect(await priceUnresolvedCharge(env.DB, { chargeId: `${session.id}:slice:2`, now: T0 + 5 * 60_000 })).toEqual({ status: "already" });
    expect(await appCost(session.appId)).toBe(10_000);
  });

  it("A1: an unpriced checkpoint slice is queued for pricing once, in the checkpoint batch", async () => {
    const session = await sessionWithUnresolvedSlice();
    const work = () =>
      env.DB.prepare("SELECT kind, charge_id, owner_type FROM open_work WHERE id = ?").bind(`unresolved:${session.id}:slice:2`).all();
    expect((await work()).results).toEqual([{ kind: "unresolved", charge_id: `${session.id}:slice:2`, owner_type: "session" }]);
    // The sweep prices it from that row.
    expect(await priceUnresolvedCharge(env.DB, { chargeId: `${session.id}:slice:2`, now: T0 + 5 * 60_000 })).toMatchObject({ status: "priced" });
  });

  it("F1: pricing first, the session total subtracts the pricing correction too", async () => {
    const session = await sessionWithUnresolvedSlice();
    expect(await priceUnresolvedCharge(env.DB, { chargeId: `${session.id}:slice:2`, now: T0 + 4 * 60_000 })).toMatchObject({ status: "priced" });
    expect(await settleSession(env.DB, { sessionId: session.id, providerTotal: nano(10_000), now: T0 + 5 * 60_000 })).toBe("settled");
    expect(await appCost(session.appId)).toBe(10_000);
  });

  it("F2: a provider total that arrives before close is kept, and the sweep applies it", async () => {
    const session = sessionRow();
    await checkpoint(session, 1, 1_000);
    expect(await settleSession(env.DB, { sessionId: session.id, providerTotal: nano(6_000), now: T0 + 70_000 })).toBe("not_closed");
    await closeSession(env.DB, { session, finalSlice: 1, endReason: "client_closed", endedAt: T0 + 71_000, now: T0 + 71_000 });
    expect(await settleSession(env.DB, { sessionId: session.id, now: T0 + 80_000 })).toBe("settled");
    expect(await appCost(session.appId)).toBe(6_000);
  });

  it("F4: a row with broken detail never stops the run; it is retried like any failure", async () => {
    quiet();
    const prefix = unique("sw_broken");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO open_work (id, kind, account_id, app_id, owner_type, owner_id, charge_id, detail_json, due_at, tries, created_at)
         VALUES (?, 'job_check', ?, 'app_sweep', 'job', ?, NULL, '{broken', ?, 0, ?)`,
      ).bind(`${prefix}_a`, ACCOUNT_ID, `${prefix}_a`, T0 - 2_000, T0),
      env.DB.prepare(
        `INSERT INTO open_work (id, kind, account_id, app_id, owner_type, owner_id, charge_id, detail_json, due_at, tries, created_at)
         VALUES (?, 'job_check', ?, 'app_sweep', 'job', ?, NULL, NULL, ?, 0, ?)`,
      ).bind(`${prefix}_b`, ACCOUNT_ID, `${prefix}_b`, T0 - 1_000, T0),
    ]);
    const done: string[] = [];
    await runSweep(env, { now: T0, handlers: { ...OPEN_WORK_HANDLERS, job_check: async (_e, item) => (done.push(item.id), { done: true }) } });
    expect(done).toContain(`${prefix}_b`);
    const left = await env.DB.prepare("SELECT id, tries, last_error FROM open_work WHERE id LIKE ?").bind(`${prefix}%`).all();
    expect(left.results).toEqual([{ id: `${prefix}_a`, tries: 1, last_error: "failed" }]);
  });
});

describe("the sweep", () => {
  async function work(id: string, dueAt: number, kind = "job_check", tries = 0) {
    await env.DB.prepare(
      `INSERT INTO open_work (id, kind, account_id, app_id, owner_type, owner_id, charge_id, detail_json, due_at, tries, created_at)
       VALUES (?, ?, ?, 'app_sweep', 'job', ?, NULL, NULL, ?, ?, ?)`,
    )
      .bind(id, kind, ACCOUNT_ID, id, dueAt, tries, T0)
      .run();
  }

  async function rows(prefix: string) {
    return (
      await env.DB.prepare("SELECT id, tries, due_at, last_error, gave_up_at FROM open_work WHERE id LIKE ? ORDER BY id").bind(`${prefix}%`).all()
    ).results;
  }

  it("14: takes the earliest due first, finishes the rest when one fails, and moves the failing one later", async () => {
    quiet();
    const prefix = unique("sw");
    await work(`${prefix}_b`, T0 - 1_000);
    await work(`${prefix}_a`, T0 - 2_000);
    await work(`${prefix}_c`, T0 - 500);
    await work(`${prefix}_later`, T0 + 60_000);
    const order: string[] = [];
    const jobCheck: OpenWorkHandler = async (_env, item) => {
      order.push(item.id);
      if (item.id.endsWith("_b")) throw new Error("provider down");
      return { done: true };
    };
    const summary = await runSweep(env, { now: T0, handlers: { ...OPEN_WORK_HANDLERS, job_check: jobCheck } });
    expect(order.filter((id) => id.startsWith(prefix))).toEqual([`${prefix}_a`, `${prefix}_b`, `${prefix}_c`]);
    expect(summary.retried).toBeGreaterThanOrEqual(1);
    expect(await rows(prefix)).toEqual([
      { id: `${prefix}_b`, tries: 1, due_at: T0 + 60_000, last_error: "failed", gave_up_at: null },
      { id: `${prefix}_later`, tries: 0, due_at: T0 + 60_000, last_error: null, gave_up_at: null },
    ]);
  });

  it("gives an item its time limit, and gives up after the set number of tries, keeping the row", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const prefix = unique("sw_slow");
    await work(`${prefix}_hang`, T0 - 10_000, "job_check");
    await work(`${prefix}_last`, T0 - 9_000, "job_check", SWEEP_MAX_TRIES - 1);
    const hang: OpenWorkHandler = (_env, item) =>
      item.id.endsWith("_hang") ? new Promise(() => undefined) : Promise.resolve({ done: false, reason: "not ready" });
    await runSweep(env, { now: T0, handlers: { ...OPEN_WORK_HANDLERS, job_check: hang }, itemTimeLimitMs: 20 });
    expect(await rows(prefix)).toEqual([
      { id: `${prefix}_hang`, tries: 1, due_at: T0 + 60_000, last_error: "timed out", gave_up_at: null },
      { id: `${prefix}_last`, tries: SWEEP_MAX_TRIES, due_at: T0 - 9_000, last_error: "not ready", gave_up_at: T0 },
    ]);
    expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)).message)).toContain("open_work_gave_up");
    // A given-up row is never taken again.
    const seen: string[] = [];
    await runSweep(env, { now: T0 + 10 * 60 * 60 * 1000, handlers: { ...OPEN_WORK_HANDLERS, job_check: async (_e, i) => (seen.push(i.id), { done: true }) } });
    expect(seen).not.toContain(`${prefix}_last`);
  });

  it("waits for a provider whose lookup is not built yet", async () => {
    quiet();
    const id = unique("lookup");
    await env.DB.prepare(
      `INSERT INTO open_work (id, kind, account_id, app_id, owner_type, owner_id, charge_id, detail_json, due_at, tries, created_at)
       VALUES (?, 'provider_lookup', ?, 'app_sweep', 'call', ?, NULL, ?, ?, 0, ?)`,
    )
      .bind(id, ACCOUNT_ID, id, JSON.stringify({ providerType: "deepgram" }), T0 - 1, T0)
      .run();
    await runSweep(env, { now: T0 });
    expect(await rows(id)).toMatchObject([{ tries: 1, last_error: "no cost lookup for provider deepgram" }]);
  });

  it("settles a closed session and prices an unresolved charge through its handlers; a repeat run changes nothing", async () => {
    quiet();
    const session = sessionRow({ expectsSessionTotal: false });
    await openSession(env.DB, session, T0);
    await checkpoint(session, 1, 1_000);
    await closeSession(env.DB, { session, finalSlice: 1, endReason: "client_closed", endedAt: T0 + 61_000, now: T0 + 61_000 });
    await runSweep(env, { now: T0 + 61_000 + 60_000 });
    expect(await sessionState(session.id)).toMatchObject({ settlement: "settled" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM open_work WHERE owner_id = ?").bind(session.id).first()).toEqual({ n: 0 });
    // Restart before the row was removed: the handler runs again and writes nothing new.
    await openSession(env.DB, session, T0);
    await env.DB.prepare("UPDATE open_work SET due_at = ? WHERE owner_id = ?").bind(T0, session.id).run();
    await runSweep(env, { now: T0 + 3 * 60_000 });
    expect(await chargesOf(session.id)).toHaveLength(1);
  });
});

describe("the minute cron", () => {
  it("runs the sweep", async () => {
    quiet();
    const id = unique("cron");
    // Work for a session that does not exist is finished at once.
    await env.DB.prepare(
      `INSERT INTO open_work (id, kind, account_id, app_id, owner_type, owner_id, charge_id, detail_json, due_at, tries, created_at)
       VALUES (?, 'stale_session', ?, 'app_cron', 'session', ?, NULL, NULL, 0, 0, 0)`,
    )
      .bind(id, ACCOUNT_ID, id)
      .run();
    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ cron: SWEEP_CRON, scheduledTime: Date.now() }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM open_work WHERE id = ?").bind(id).first()).toEqual({ n: 0 });
  });
});

describe("plan minutes in the account limiter", () => {
  it("never answers one date range's read with another's", async () => {
    const accountId = unique("acc_minutes");
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO usage_day (account_id, app_id, day, provider_type, provider_connection_id, model, outcome, unit, session_ms) VALUES (?, 'a', '2026-10-15', 'x', '', '', 'ok', '', 1000)",
      ).bind(accountId),
      env.DB.prepare(
        "INSERT INTO usage_day (account_id, app_id, day, provider_type, provider_connection_id, model, outcome, unit, session_ms) VALUES (?, 'a', '2026-11-15', 'x', '', '', 'ok', '', 5000)",
      ).bind(accountId),
    ]);
    const limiter = env.ACCOUNT_LIMITER.getByName(accountId);
    const [october, november] = await Promise.all([
      limiter.sessionMs({ accountId, fromDay: "2026-10-01", toDay: "2026-11-01", now: T0 }),
      limiter.sessionMs({ accountId, fromDay: "2026-11-01", toDay: "2026-12-01", now: T0 }),
    ]);
    expect([october, november]).toEqual([1000, 5000]);
  });
});

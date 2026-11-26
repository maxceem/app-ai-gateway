/**
 * The ledger write path, the rollup trigger and the failed-write store
 * (plan section 4.2).
 */
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_PENDING, retryStored } from "../src/do/ChargeStore.ts";
import { CHARGE_STORE_DEADLINE_MS } from "../src/ledger/charge-store.ts";
import { ledgerDb } from "../src/ledger/database.ts";
import { LEDGER_D1_DEADLINE_MS, recordLedgerEntry, type ChargeRow, type LedgerEntry, type OpenWorkRow } from "../src/ledger/write.ts";
import { nano, type NanoDollars } from "../src/money.ts";
import { ledger, withLedgerDb, writeAtTheirTime } from "./helpers.ts";

const DAY = "2026-11-19";
const AT = Date.parse(`${DAY}T10:00:00Z`);

let counter = 0;

function entry(fields: Partial<ChargeRow> = {}, appId = "app_ledger"): LedgerEntry {
  counter += 1;
  const charge: ChargeRow = {
    id: `req_${counter}:1`,
    kind: "attempt",
    accountId: "acc_ledger",
    appId,
    endUserId: "user-1",
    installId: null,
    appleAccountId: null,
    appKeyId: null,
    ownerType: "call",
    ownerId: `req_${counter}`,
    seq: 1,
    providerType: "openai",
    providerConnectionId: "conn_1",
    operation: "openai.chat",
    preset: null,
    model: "gpt-test",
    status: "ok",
    httpStatus: 200,
    errorCode: null,
    costNano: nano(1_000),
    measured: "complete",
    priceSource: "list_rate",
    priceIsEstimate: false,
    inputTokens: 10,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 5,
    unit: "tokens",
    units: 15,
    measures: { input_tokens: 10, output_tokens: 5 },
    rates: { input: 1, output: 2 },
    sessionMs: null,
    correctionKind: null,
    correctsChargeId: null,
    latencyMs: 100,
    appVersion: null,
    authMethod: "api_key",
    clientTraceId: null,
    usedAt: AT,
    usageDay: DAY,
    writtenAt: AT,
    ...fields,
  };
  return { charge, openWork: [] };
}

async function usageDay(appId: string) {
  return ledger("acc_ledger").prepare(
    "SELECT outcome, charges, unpriced_charges, cost_nano, input_tokens, output_tokens, units FROM usage_day WHERE app_id = ? ORDER BY outcome",
  )
    .bind(appId)
    .all()
    .then((result) => result.results);
}

async function budget(appId: string) {
  return ledger("acc_ledger").prepare("SELECT scope, scope_id, cost_nano FROM budget_day WHERE app_id = ? ORDER BY scope, scope_id")
    .bind(appId)
    .all()
    .then((result) => result.results);
}

afterEach(() => vi.restoreAllMocks());

describe("the rollup trigger", () => {
  it("counts a retried write once", async () => {
    const appId = `app_retry_${crypto.randomUUID().slice(0, 6)}`;
    const one = entry({}, appId);
    await writeAtTheirTime([one]);
    await writeAtTheirTime([one]);
    await writeAtTheirTime([{ ...one, charge: { ...one.charge, costNano: nano(99_999) } }]);
    expect(await usageDay(appId)).toEqual([
      { outcome: "ok", charges: 1, unpriced_charges: 0, cost_nano: 1_000, input_tokens: 10, output_tokens: 5, units: 15 },
    ]);
  });

  it("counts an empty cost as 0, and a failed attempt apart from the paid ones", async () => {
    const appId = `app_failed_${crypto.randomUUID().slice(0, 6)}`;
    await writeAtTheirTime([
      entry({}, appId),
      entry(
        { status: "provider_error", httpStatus: 429, costNano: null, inputTokens: null, outputTokens: null, unit: null, units: null },
        appId,
      ),
    ]);
    const rows = await ledger("acc_ledger").prepare("SELECT outcome, charges, cost_nano, unit FROM usage_day WHERE app_id = ? ORDER BY outcome")
      .bind(appId)
      .all();
    expect(rows.results).toEqual([
      { outcome: "failed", charges: 1, cost_nano: 0, unit: "" },
      { outcome: "ok", charges: 1, cost_nano: 1_000, unit: "tokens" },
    ]);
    const total = await ledger("acc_ledger").prepare("SELECT SUM(cost_nano) AS total FROM usage_day WHERE app_id = ?").bind(appId).first();
    expect(total).toEqual({ total: 1_000 });
  });

  it("adds a correction's difference to the same day, without counting another charge", async () => {
    const appId = `app_correction_${crypto.randomUUID().slice(0, 6)}`;
    const original = entry({ costNano: nano(1_000) }, appId);
    const final: NanoDollars = nano(1_750);
    const correction = entry(
      {
        kind: "correction",
        correctionKind: "units",
        correctsChargeId: original.charge.id,
        ownerId: original.charge.ownerId,
        costNano: nano(final - original.charge.costNano!),
        inputTokens: null,
        outputTokens: null,
        units: null,
      },
      appId,
    );
    await writeAtTheirTime([original, correction]);
    expect(await usageDay(appId)).toEqual([
      { outcome: "ok", charges: 1, unpriced_charges: 0, cost_nano: 1_750, input_tokens: 10, output_tokens: 5, units: 15 },
    ]);
  });

  it("keeps budget totals for the app and every end-user scope the charge names", async () => {
    const appId = `app_budget_${crypto.randomUUID().slice(0, 6)}`;
    await writeAtTheirTime([
      entry({ endUserId: "user-1", installId: "install-1", appleAccountId: "apple-1" }, appId),
      entry({ endUserId: "user-1", installId: null }, appId),
      entry({ costNano: null, status: "timeout" }, appId),
    ]);
    expect(await budget(appId)).toEqual([
      { scope: "app", scope_id: appId, cost_nano: 2_000 },
      { scope: "apple_account", scope_id: "apple-1", cost_nano: 1_000 },
      { scope: "install", scope_id: "install-1", cost_nano: 1_000 },
      { scope: "user", scope_id: "user-1", cost_nano: 2_000 },
    ]);
  });

  it("counts unpriced charges", async () => {
    const appId = `app_unpriced_${crypto.randomUUID().slice(0, 6)}`;
    await writeAtTheirTime([entry({ priceSource: "unresolved", costNano: null }, appId)]);
    expect(await usageDay(appId)).toMatchObject([{ charges: 1, unpriced_charges: 1, cost_nano: 0 }]);
  });
});

describe("the failed-write store", () => {
  function failingDatabase(): D1Database {
    const fail = () => Promise.reject(new Error("D1 is down"));
    return {
      prepare: (query: string) => ledger("acc_ledger").prepare(query),
      batch: fail,
    } as unknown as D1Database;
  }

  it("keeps a charge D1 refused, and writes it once when its alarm runs", async () => {
    const appId = `app_store_${crypto.randomUUID().slice(0, 6)}`;
    const one = entry({}, appId);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await recordLedgerEntry(withLedgerDb(env, () => failingDatabase()), one);
    await recordLedgerEntry(withLedgerDb(env, () => failingDatabase()), one);
    const store = env.CHARGE_STORE.getByName(appId);
    expect(await store.pendingCount()).toBe(1);
    expect(await usageDay(appId)).toEqual([]);

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runDurableObjectAlarm(store)).toBe(true);
    expect(await store.pendingCount()).toBe(0);
    expect(await usageDay(appId)).toMatchObject([{ charges: 1, cost_nano: 1_000 }]);
    const charge = await ledger("acc_ledger").prepare("SELECT id FROM charge WHERE id = ?").bind(one.charge.id).first();
    expect(charge).toEqual({ id: one.charge.id });
  });

  it("logs the whole charge when the store cannot be reached either, as past the Free plan's daily Durable Object limits", async () => {
    const one = entry();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Past the daily limits, every Durable Object call fails: the ledger object's and the store's alike.
    const overLimit = () => Promise.reject(new Error("Exceeded allowed rows read in Durable Objects free tier"));
    const unreachable = { getByName: () => ({ keep: overLimit }) };
    const ledgers = { idFromName: (name: string) => name, get: () => ({ query: overLimit }) };
    await recordLedgerEntry({ ...env, ACCOUNT_LEDGER: ledgers, CHARGE_STORE: unreachable } as unknown as Env, one);
    const logged = errors.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(logged).toContainEqual(
      expect.objectContaining({ message: "usage_record_failed", charge: expect.objectContaining({ id: one.charge.id, costNano: 1_000 }) }),
    );
  });

  it("gives up a stalled retry at the ledger's deadline, so the alarm reaches its backoff", async () => {
    vi.useFakeTimers();
    try {
      // The ledger object never answers; the store's alarm reaches it as `ledgerDb`, with the write deadline.
      const stalledLedgers = { ...env, ACCOUNT_LEDGER: { idFromName: (name: string) => name, get: () => ({ query: () => new Promise<never>(() => undefined) }) } } as unknown as Env;
      const retry = retryStored((accountId) => ledgerDb(stalledLedgers, accountId, { deadlineMs: LEDGER_D1_DEADLINE_MS }), [entry()], [], 0);
      const outcome = retry.then(
        () => "written",
        (error: unknown) => `${(error as { status?: number }).status} ${(error as { reason?: string }).reason ?? ""} ${String((error as { cause?: unknown }).cause)}`,
      );
      await vi.advanceTimersByTimeAsync(LEDGER_D1_DEADLINE_MS - 1);
      let settled: string | undefined;
      void outcome.then((value) => (settled = value));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      // The route deadline's own error: a route that waits on it answers 503 `deadline_exceeded`.
      expect(await outcome).toMatch(/^503 deadline_exceeded .*calling the account's ledger took longer than/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends a write to a stalled ledger at its deadline, and keeps the charge in the store, with a warning (step 8f)", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const one = entry();
    const kept: unknown[] = [];
    const stalled = {
      ...env,
      ACCOUNT_LEDGER: { idFromName: (name: string) => name, get: () => ({ query: () => new Promise<never>(() => undefined) }) },
      CHARGE_STORE: { getByName: () => ({ keep: async (entries: unknown[]) => void kept.push(...entries) }) },
    } as unknown as Env;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const recording = recordLedgerEntry(stalled, one);
    await vi.advanceTimersByTimeAsync(LEDGER_D1_DEADLINE_MS);
    vi.useRealTimers();
    await recording;
    expect(warned.mock.calls.some(([line]) => String(line).includes('"message":"ledger_write_failed"'))).toBe(true);
    expect(kept).toHaveLength(1);
  });

  it("ends a stalled failed-write store at its deadline, and logs the whole charge (step 8f)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const one = entry();
    const stalled = {
      ...env,
      ACCOUNT_LEDGER: { idFromName: (name: string) => name, get: () => ({ query: () => Promise.reject(new Error("ledger down")) }) },
      CHARGE_STORE: { getByName: () => ({ keep: () => new Promise<never>(() => undefined) }) },
    } as unknown as Env;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const recording = recordLedgerEntry(stalled, one);
    await vi.advanceTimersByTimeAsync(CHARGE_STORE_DEADLINE_MS);
    vi.useRealTimers();
    await recording;
    expect(errors.mock.calls.some(([line]) => String(line).includes('"message":"usage_record_failed"'))).toBe(true);
  });

  it("has a size limit", () => {
    expect(MAX_PENDING).toBeGreaterThan(0);
  });
});

describe("key copies never reach the logs (split keys, plan step 8j, Sol round 1)", () => {
  const COPY = "local1.1.COPYIVCOPYIV.COPYCIPHERTEXTNEVERLOGGED";

  /** An entry whose job check carries a key copy, as a split-key fal job's does. */
  function withCopy(appId: string): { entry: LedgerEntry; work: OpenWorkRow } {
    const one = entry({}, appId);
    const work: OpenWorkRow = {
      id: `job:${one.charge.ownerId}`,
      kind: "job_check",
      accountId: one.charge.accountId,
      appId,
      ownerType: "job",
      ownerId: one.charge.ownerId,
      chargeId: one.charge.id,
      detail: { jobId: "job_signed_id", maxTries: 60, keyCopies: { providerKey: { blob: COPY, identity: ["a", "c", "fal", "", "", "", "1"] } } },
      dueAt: AT,
      createdAt: AT,
    };
    return { entry: { ...one, openWork: [work] }, work };
  }

  function errorLines(spy: { mock: { calls: unknown[][] } }, message: string): string[] {
    return spy.mock.calls.map(([line]) => String(line)).filter((line) => line.includes(`"message":"${message}"`));
  }

  it("logs a lost entry without its key copies, keeping what writing it by hand needs", async () => {
    const { entry: one } = withCopy("app_copy_lost");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const down = () => Promise.reject(new Error("down"));
    await recordLedgerEntry(
      { ...env, ACCOUNT_LEDGER: { idFromName: (name: string) => name, get: () => ({ query: down }) }, CHARGE_STORE: { getByName: () => ({ keep: down }) } } as unknown as Env,
      one,
    );
    const [line] = errorLines(errors, "usage_record_failed");
    expect(line).toBeDefined();
    expect(line).not.toContain(COPY);
    expect(line).toContain("job_signed_id");
    expect(line).toContain(one.charge.id);
  });

  it("logs what the failed-write store drops without its key copies", async () => {
    const appId = `app_copy_drop_${crypto.randomUUID().slice(0, 6)}`;
    const { entry: one, work } = withCopy(appId);
    const store = env.CHARGE_STORE.getByName(appId);
    await store.keep([one]);
    await store.keepWork([{ ...work, id: `${work.id}:alone` }]);
    // Past the store's retention, so its next alarm drops both, logging each.
    await runInDurableObject(store, (_instance, state) => {
      state.storage.sql.exec("UPDATE pending SET stored_at = 0");
      state.storage.sql.exec("UPDATE pending_work SET stored_at = 0");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runDurableObjectAlarm(store);
    const lines = [...errorLines(errors, "usage_record_failed"), ...errorLines(errors, "open_work_unrecorded")];
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain(COPY);
      expect(line).toContain("job_signed_id");
    }
  });
});

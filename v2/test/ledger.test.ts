/**
 * The ledger write path, the rollup trigger and the failed-write store
 * (plan section 4.2).
 */
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_PENDING, retryStored } from "../src/do/ChargeStore.ts";
import { LEDGER_D1_DEADLINE_MS, recordLedgerEntry, type ChargeRow, type LedgerEntry } from "../src/ledger/write.ts";
import { nano, type NanoDollars } from "../src/money.ts";
import { writeAtTheirTime } from "./helpers.ts";

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
  return env.DB.prepare(
    "SELECT outcome, charges, unpriced_charges, cost_nano, input_tokens, output_tokens, units FROM usage_day WHERE app_id = ? ORDER BY outcome",
  )
    .bind(appId)
    .all()
    .then((result) => result.results);
}

async function budget(appId: string) {
  return env.DB.prepare("SELECT scope, scope_id, cost_nano FROM budget_day WHERE app_id = ? ORDER BY scope, scope_id")
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
    const rows = await env.DB.prepare("SELECT outcome, charges, cost_nano, unit FROM usage_day WHERE app_id = ? ORDER BY outcome")
      .bind(appId)
      .all();
    expect(rows.results).toEqual([
      { outcome: "failed", charges: 1, cost_nano: 0, unit: "" },
      { outcome: "ok", charges: 1, cost_nano: 1_000, unit: "tokens" },
    ]);
    const total = await env.DB.prepare("SELECT SUM(cost_nano) AS total FROM usage_day WHERE app_id = ?").bind(appId).first();
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
      prepare: (query: string) => env.DB.prepare(query),
      batch: fail,
    } as unknown as D1Database;
  }

  it("keeps a charge D1 refused, and writes it once when its alarm runs", async () => {
    const appId = `app_store_${crypto.randomUUID().slice(0, 6)}`;
    const one = entry({}, appId);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await recordLedgerEntry({ ...env, DB: failingDatabase() } as Env, one);
    await recordLedgerEntry({ ...env, DB: failingDatabase() } as Env, one);
    const store = env.CHARGE_STORE.getByName(appId);
    expect(await store.pendingCount()).toBe(1);
    expect(await usageDay(appId)).toEqual([]);

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runDurableObjectAlarm(store)).toBe(true);
    expect(await store.pendingCount()).toBe(0);
    expect(await usageDay(appId)).toMatchObject([{ charges: 1, cost_nano: 1_000 }]);
    const charge = await env.DB.prepare("SELECT id FROM charge WHERE id = ?").bind(one.charge.id).first();
    expect(charge).toEqual({ id: one.charge.id });
  });

  it("logs the whole charge when the store cannot be reached either", async () => {
    const one = entry();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unreachable = { getByName: () => ({ keep: () => Promise.reject(new Error("store down")) }) };
    await recordLedgerEntry({ ...env, DB: failingDatabase(), CHARGE_STORE: unreachable } as unknown as Env, one);
    const logged = errors.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(logged).toContainEqual(
      expect.objectContaining({ message: "usage_record_failed", charge: expect.objectContaining({ id: one.charge.id, costNano: 1_000 }) }),
    );
  });

  it("gives up a stalled retry at the ledger's deadline, so the alarm reaches its backoff", async () => {
    vi.useFakeTimers();
    try {
      const stalled = { prepare: (query: string) => env.DB.prepare(query), batch: () => new Promise<never>(() => undefined) } as unknown as D1Database;
      const retry = retryStored(stalled, [entry()], [], 0);
      const outcome = retry.then(
        () => "written",
        (error: unknown) => (error as Error).message,
      );
      await vi.advanceTimersByTimeAsync(LEDGER_D1_DEADLINE_MS - 1);
      let settled: string | undefined;
      void outcome.then((value) => (settled = value));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toMatch(/retrying stored charges took longer than/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("has a size limit", () => {
    expect(MAX_PENDING).toBeGreaterThan(0);
  });
});

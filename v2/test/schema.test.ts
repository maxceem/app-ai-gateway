/**
 * The ledger's rules that the database itself enforces (plan section 4.2).
 * The rollup trigger and the money helpers come in step 1a part 3.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ledger } from "./helpers.ts";

const DAY = "2026-11-19";
const AT = Date.parse(`${DAY}T10:00:00Z`);

/** A charge row with every required column, changed by `fields`. */
function charge(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "c1",
    kind: "attempt",
    account_id: "acc",
    app_id: "app",
    owner_type: "call",
    owner_id: "call1",
    seq: 1,
    provider_type: "openai",
    operation: "openai.chat",
    model: "gpt-test",
    status: "ok",
    cost_nano: 1_500,
    measured: "complete",
    price_source: "list_rate",
    measures_json: "{}",
    used_at: AT,
    usage_day: DAY,
    written_at: AT,
    ...fields,
  };
}

/** Writes a charge. `retry` writes it the way the ledger does: a duplicate id is skipped. */
async function insert(row: Record<string, unknown>, retry = false) {
  const columns = Object.keys(row);
  return ledger().prepare(
    `INSERT INTO charge (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})` +
      (retry ? " ON CONFLICT(id) DO NOTHING" : ""),
  )
    .bind(...Object.values(row))
    .run();
}

describe("charge", () => {
  beforeEach(async () => {
    await ledger().prepare("DELETE FROM charge").run();
  });

  it("ignores a charge id that already exists, so a retried write counts once", async () => {
    await insert(charge({}));
    const retry = await insert(charge({ cost_nano: 9_999 }), true);
    expect(retry.meta.changes).toBe(0);
    const row = await ledger().prepare("SELECT cost_nano FROM charge WHERE id = 'c1'").first();
    expect(row).toEqual({ cost_nano: 1_500 });
  });

  it("still refuses a bad row written the ledger's way, instead of dropping it silently", async () => {
    await expect(insert(charge({ id: "new", cost_nano: 1.5 }), true)).rejects.toThrow(/CHECK constraint failed/);
  });

  it("stores a failed attempt with no cost, and sums skip it", async () => {
    await insert(charge({ id: "ok1", cost_nano: 1_500 }));
    await insert(charge({ id: "fail1", seq: 2, status: "provider_error", http_status: 429, error_code: "rate_limit_exceeded", cost_nano: null }));
    const sums = await ledger().prepare(
      "SELECT SUM(cost_nano) AS total, COUNT(*) AS attempts, COUNT(cost_nano) AS billed FROM charge",
    ).first();
    expect(sums).toEqual({ total: 1_500, attempts: 2, billed: 1 });
  });

  it("totals only empty costs as 0, not NULL", async () => {
    await insert(charge({ cost_nano: null, status: "timeout" }));
    const total = await ledger().prepare("SELECT TOTAL(cost_nano) AS total, COALESCE(SUM(cost_nano), 0) AS summed FROM charge").first();
    expect(total).toEqual({ total: 0, summed: 0 });
  });

  it("keeps money exact as 64-bit integers", async () => {
    await insert(charge({ id: "big", cost_nano: 9_000_000_000_000_000 }));
    const row = await ledger().prepare("SELECT typeof(cost_nano) AS type, cost_nano FROM charge").first();
    expect(row).toEqual({ type: "integer", cost_nano: 9_000_000_000_000_000 });
  });

  it.each([
    ["an unknown kind", { kind: "refund" }],
    ["an unknown owner type", { owner_type: "batch" }],
    ["an unknown measured label", { measured: "guessed" }],
    ["an unknown price source", { price_source: "free" }],
    ["a correction without its kind", { kind: "correction" }],
    ["a correction kind on a non-correction", { correction_kind: "units" }],
    ["a corrected charge on a non-correction", { corrects_charge_id: "c0" }],
    ["session time on an attempt", { session_ms: 1000 }],
    ["a usage day that is not a day", { usage_day: "2026-11-1" }],
    ["a fractional cost", { cost_nano: 1.5 }],
  ])("refuses %s", async (_, fields) => {
    await expect(insert(charge(fields))).rejects.toThrow(/CHECK constraint failed/);
  });

  it("accepts each kind of correction, and session time on a slice", async () => {
    await insert(charge({ id: "units", kind: "correction", correction_kind: "units", corrects_charge_id: "c0" }));
    await insert(charge({ id: "dollars", kind: "correction", correction_kind: "dollars", owner_type: "session", cost_nano: -300 }));
    await insert(charge({ id: "pricing", kind: "correction", correction_kind: "pricing", corrects_charge_id: "c0" }));
    await insert(charge({ id: "slice", kind: "slice", owner_type: "session", session_ms: 60_000 }));
    const count = await ledger().prepare("SELECT COUNT(*) AS n FROM charge").first();
    expect(count).toEqual({ n: 4 });
  });
});

describe("open_work", () => {
  it("ignores the same work written twice", async () => {
    const write = () =>
      ledger().prepare(
        `INSERT INTO open_work (id, kind, account_id, app_id, owner_type, owner_id, due_at, created_at)
         VALUES ('job:j1', 'job_check', 'acc', 'app', 'job', 'j1', ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
        .bind(AT, AT)
        .run();
    await write();
    expect((await write()).meta.changes).toBe(0);
  });
});

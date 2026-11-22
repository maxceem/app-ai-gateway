/**
 * Step 7b-3: reading usage back through the management API and its tools.
 * Month totals add `usage_day` and `usage_month`; days and breakdowns read the
 * day totals or the charges; charges page newest first; every read is bound
 * to the caller's account.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { QueryBudget } from "../src/core/query-budget.ts";
import { runUsageRetention } from "../src/ledger/retention.ts";
import { ACCOUNT_ID, clearCaches, LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement, seedHuman, seedManagementKey } from "./helpers.ts";

beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

beforeEach(() => {
  clearCaches();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

const ORIGIN = "https://gateway.test";
/** Migration 0009's text, to run one of its statements over seeded rows. */
const MIGRATION_0009: string = Object.values(
  (import.meta as ImportMeta & {
    glob<T>(pattern: string, options: { query: string; import: string; eager: true }): Record<string, T>;
  }).glob<string>("../migrations/0009_usage_reads.sql", { query: "?raw", import: "default", eager: true }),
)[0]!;
const OTHER_ACCOUNT = "acc_other_usage";

async function request(key: string, method: string, path: string, body?: unknown) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function createApp(key: string): Promise<string> {
  const { status, body } = await request(key, "POST", "/v2/admin/apps", {
    name: "Usage",
    config: { authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } }, routing: { providers: {} } },
  });
  expect(status).toBe(201);
  return body.app.id as string;
}

let counter = 0;

interface Seed {
  appId: string;
  usedAt: number;
  accountId?: string;
  id?: string;
  kind?: "attempt" | "slice" | "estimate" | "correction";
  ownerType?: "call" | "session" | "job";
  ownerId?: string;
  correctsChargeId?: string;
  correctionKind?: "units" | "dollars" | "pricing";
  trace?: string;
  user?: string | null;
  provider?: string;
  connection?: string | null;
  model?: string | null;
  status?: string;
  cost?: number | null;
  priceSource?: string;
  measured?: string;
  operation?: string;
  input?: number;
  output?: number;
  sessionMs?: number | null;
  unit?: string;
}

/** A charge written straight to the ledger table; the rollup trigger fills `usage_day`. */
async function seed(values: Seed): Promise<string> {
  counter += 1;
  const id = values.id ?? `ch_${String(counter).padStart(4, "0")}_${crypto.randomUUID().slice(0, 6)}`;
  const kind = values.kind ?? "attempt";
  await env.DB.prepare(
    `INSERT INTO charge (id, kind, account_id, app_id, end_user_id, owner_type, owner_id, provider_type, provider_connection_id,
       operation, model, status, cost_nano, measured, price_source, input_tokens, output_tokens, session_ms, measures_json,
       correction_kind, corrects_charge_id, client_trace_id, used_at, usage_day, written_at, unit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      kind,
      values.accountId ?? ACCOUNT_ID,
      values.appId,
      values.user ?? null,
      values.ownerType ?? (kind === "slice" ? "session" : "call"),
      values.ownerId ?? `owner_${counter}`,
      values.provider ?? "openai",
      values.connection ?? null,
      values.operation ?? "openai.chat",
      values.model === undefined ? "gpt-4o-mini" : values.model,
      values.status ?? "ok",
      values.cost === undefined ? 1_000 : values.cost,
      values.measured ?? "complete",
      values.priceSource ?? "list_rate",
      values.input ?? 10,
      values.output ?? 2,
      kind === "slice" ? (values.sessionMs ?? 60_000) : null,
      kind === "correction" ? (values.correctionKind ?? "units") : null,
      values.correctsChargeId ?? null,
      values.trace ?? null,
      values.usedAt,
      new Date(values.usedAt).toISOString().slice(0, 10),
      values.usedAt,
      values.unit ?? null,
    )
    .run();
  return id;
}

/** A month total as the nightly fold leaves it (`../src/ledger/retention.ts`). */
async function monthRow(appId: string, month: string, values: { charges: number; cost: number; accountId?: string; failed?: boolean }) {
  await env.DB.prepare(
    `INSERT INTO usage_month (account_id, app_id, month, provider_type, provider_connection_id, model, outcome, unit, charges, cost_nano, input_tokens)
     VALUES (?, ?, ?, 'openai', '', 'gpt-4o-mini', ?, '', ?, ?, 100)`,
  )
    .bind(values.accountId ?? ACCOUNT_ID, appId, month, values.failed ? "failed" : "ok", values.charges, values.cost)
    .run();
}

const at = (day: string, ms = 0) => Date.parse(`${day}T12:00:00Z`) + ms;

describe("month totals", () => {
  it("add a month's folded total to the days of it still kept, for an app and for the whole account", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    const gone = `gone-${crypto.randomUUID().slice(0, 8)}`;
    // March 2025: part already folded into its month total, part still in day totals.
    await monthRow(appId, "2025-03", { charges: 40, cost: 40_000 });
    await seed({ appId, usedAt: at("2025-03-30"), cost: 2_000 });
    await seed({ appId, usedAt: at("2025-03-31"), cost: null, status: "timeout" });
    await seed({ appId, usedAt: at("2025-03-31", 1), cost: 500, priceSource: "unresolved" });
    // A correction changes the cost, never the count.
    await seed({ appId, usedAt: at("2025-03-31", 2), kind: "correction", cost: -300 });
    // Outside the month, and in another account's app with the same id.
    await seed({ appId, usedAt: at("2025-04-01"), cost: 7_000 });
    await seed({ appId, usedAt: at("2025-03-15"), cost: 9_000_000, accountId: OTHER_ACCOUNT });
    // A deleted app keeps its usage in the account's month.
    await seed({ appId: gone, usedAt: at("2025-03-10"), cost: 10_000 });

    const app = await request(key, "GET", `/v2/admin/apps/${appId}/usage?month=2025-03`);
    expect(app.status).toBe(200);
    expect(app.body).toEqual({
      app_id: appId,
      month: "2025-03",
      charges: 43,
      failed: 1,
      unpriced: 1,
      cost_nano: 42_200,
      cost_usd: 0.0000422,
      input_tokens: 100 + 40,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 8,
      session_ms: 0,
    });

    const account = await request(key, "GET", "/v2/admin/usage?month=2025-03");
    expect(account.status).toBe(200);
    expect(account.body.totals).toMatchObject({ charges: 44, cost_nano: 52_200 });
    // Largest cost first.
    expect(account.body.apps).toEqual([
      expect.objectContaining({ app_id: appId, name: "Usage", deleted: false, charges: 43, cost_nano: 42_200 }),
      expect.objectContaining({ app_id: gone, name: null, deleted: true, charges: 1, cost_nano: 10_000 }),
    ]);
    // The oldest usage kept is a month total, which sorts before the days of its month.
    expect(account.body.first_usage_day <= "2025-03").toBe(true);
  });

  it("refuses a month that is not one, and answers nothing for a month with no usage", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    expect((await request(key, "GET", `/v2/admin/apps/${appId}/usage?month=2025-13`)).status).toBe(400);
    expect((await request(key, "GET", `/v2/admin/apps/${appId}/usage?month=1999-01`)).body).toMatchObject({ charges: 0, cost_nano: 0, cost_usd: 0 });
  });
});

describe("days and breakdowns", () => {
  it("group the day totals by day and provider, and by one dimension", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    const slug = `openai-${crypto.randomUUID().slice(0, 6)}`;
    const connection = await request(key, "POST", "/v2/admin/providers", { type: "openai", name: "OpenAI", slug, secret: "sk-live-secret-abcd" });
    const connectionId = connection.body.provider.id as string;
    await seed({ appId, usedAt: at("2025-05-01"), cost: 1_000, connection: connectionId, user: "u1" });
    await seed({ appId, usedAt: at("2025-05-01", 1), cost: 3_000, provider: "anthropic", model: "claude", user: "u2", operation: "anthropic.messages" });
    await seed({ appId, usedAt: at("2025-05-02"), cost: null, status: "provider_error", connection: connectionId, user: "u1" });
    await seed({ appId, usedAt: at("2025-05-02", 1), kind: "slice", cost: 500, model: null, user: "u1", sessionMs: 90_000 });

    const days = await request(key, "GET", `/v2/admin/apps/${appId}/usage/timeseries?from=2025-05-01&to=2025-05-03`);
    expect(days.status).toBe(200);
    expect(days.body.buckets.map((row: any) => [row.day, row.provider_type, row.charges, row.failed, row.cost_nano])).toEqual([
      ["2025-05-01", "anthropic", 1, 0, 3_000],
      ["2025-05-01", "openai", 1, 0, 1_000],
      ["2025-05-02", "openai", 2, 1, 500],
    ]);
    expect(days.body.buckets[2].session_ms).toBe(90_000);

    const byModel = await request(key, "GET", `/v2/admin/apps/${appId}/usage/breakdown?from=2025-05-01&to=2025-05-03&by=model`);
    expect(byModel.body.rows.map((row: any) => [row.key, row.charges, row.cost_nano])).toEqual([
      ["claude", 1, 3_000],
      ["gpt-4o-mini", 2, 1_000],
      [null, 1, 500],
    ]);
    const byConnection = await request(key, "GET", `/v2/admin/apps/${appId}/usage/breakdown?from=2025-05-01&to=2025-05-03&by=connection`);
    expect(byConnection.body.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: connectionId, label: slug, charges: 2, failed: 1 }),
        expect.objectContaining({ key: null, label: null, charges: 2 }),
      ]),
    );
    const byStatus = await request(key, "GET", `/v2/admin/apps/${appId}/usage/breakdown?from=2025-05-01&to=2025-05-03&by=status`);
    expect(byStatus.body.rows.map((row: any) => [row.key, row.charges])).toEqual([["ok", 3], ["failed", 1]]);
    // From the charges themselves.
    const byUser = await request(key, "GET", `/v2/admin/apps/${appId}/usage/breakdown?from=2025-05-01&to=2025-05-03&by=user&limit=1`);
    expect(byUser.body.rows).toEqual([expect.objectContaining({ key: "u2", charges: 1, cost_nano: 3_000 })]);
    const byOperation = await request(key, "GET", `/v2/admin/apps/${appId}/usage/breakdown?from=2025-05-01&to=2025-05-03&by=operation`);
    expect(byOperation.body.rows.map((row: any) => [row.key, row.charges])).toEqual([["anthropic.messages", 1], ["openai.chat", 3]]);
  });

  it("refuses a range out of order or longer than 400 days", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    expect((await request(key, "GET", `/v2/admin/apps/${appId}/usage/timeseries?from=2025-05-02&to=2025-05-01`)).status).toBe(400);
    expect((await request(key, "GET", `/v2/admin/apps/${appId}/usage/timeseries?from=2024-01-01&to=2025-05-01`)).status).toBe(400);
    expect((await request(key, "GET", `/v2/admin/apps/${appId}/usage/breakdown?by=nothing`)).status).toBe(400);
    const defaults = await request(key, "GET", `/v2/admin/apps/${appId}/usage/timeseries`);
    expect(defaults.status).toBe(200);
    expect(Date.parse(defaults.body.to) - Date.parse(defaults.body.from)).toBe(29 * 86_400_000);
  });
});

describe("charges", () => {
  it("page newest first through equal times, with corrections as their own rows", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    const same = at("2025-06-01");
    const original = await seed({ appId, usedAt: same, id: "ch_b", cost: 1_000, ownerId: "call_1" });
    await seed({ appId, usedAt: same, id: "ch_a", kind: "correction", cost: -250, ownerId: "call_1", correctsChargeId: original });
    await seed({ appId, usedAt: same, id: "ch_c", cost: null, status: "timeout", ownerId: "call_2" });
    await seed({ appId, usedAt: same - 1, id: "ch_d", ownerId: "call_3", priceSource: "unresolved" });

    const first = await request(key, "GET", `/v2/admin/apps/${appId}/charges?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.charges.map((row: any) => row.id)).toEqual(["ch_c", "ch_b"]);
    expect(first.body.charges[0]).toMatchObject({ status: "timeout", cost_nano: null, cost_usd: null, used_at: new Date(same).toISOString() });
    const second = await request(key, "GET", `/v2/admin/apps/${appId}/charges?limit=2&before=${encodeURIComponent(first.body.next_before)}`);
    expect(second.body.charges.map((row: any) => row.id)).toEqual(["ch_a", "ch_d"]);
    expect(second.body.charges[0]).toMatchObject({ kind: "correction", corrects_charge_id: "ch_b", cost_nano: -250 });
    const last = await request(key, "GET", `/v2/admin/apps/${appId}/charges?limit=2&before=${encodeURIComponent(second.body.next_before)}`);
    expect(last.body).toMatchObject({ charges: [], next_before: null });

    // Filters with no index of their own read inside a range (by default the last 30 days).
    const june = "from=2025-05-31&to=2025-06-01";
    const failed = await request(key, "GET", `/v2/admin/apps/${appId}/charges?status=failed&${june}`);
    expect(failed.body.charges.map((row: any) => row.id)).toEqual(["ch_c"]);
    const owner = await request(key, "GET", `/v2/admin/apps/${appId}/charges?owner=call_1`);
    expect(owner.body.charges.map((row: any) => row.id)).toEqual(["ch_b", "ch_a"]);
    const unpriced = await request(key, "GET", `/v2/admin/apps/${appId}/charges?price_source=unresolved&${june}`);
    expect(unpriced.body.charges.map((row: any) => row.id)).toEqual(["ch_d"]);
    const range = await request(key, "GET", `/v2/admin/apps/${appId}/charges?from=2025-06-02&to=2025-06-03`);
    expect(range.body.charges).toEqual([]);
    expect((await request(key, "GET", `/v2/admin/apps/${appId}/charges?before=nonsense`)).status).toBe(400);
  });

  it("show the jobs whose estimate was never settled", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    // The job list reads the last 89 days, from now.
    const daysAgo = (days: number) => Date.now() - days * 86_400_000;
    const settledEstimate = await seed({ appId, usedAt: daysAgo(3), kind: "estimate", ownerType: "job", ownerId: "job_settled", provider: "fal" });
    await seed({ appId, usedAt: daysAgo(3), id: "settle:job:job_settled", kind: "correction", ownerType: "job", ownerId: "job_settled", correctsChargeId: settledEstimate, provider: "fal" });
    await seed({ appId, usedAt: daysAgo(2), kind: "estimate", ownerType: "job", ownerId: "job_late", provider: "fal" });
    // Past the window: retention deleted its settlement and has not reached its estimate yet.
    // It must not show as unsettled, with its estimate as its total (Sol 7b-3 round 1).
    await seed({ appId, usedAt: daysAgo(90), kind: "estimate", ownerType: "job", ownerId: "job_retiring", provider: "fal" });

    const unsettled = await request(key, "GET", `/v2/admin/apps/${appId}/jobs?settled=false`);
    expect(unsettled.status).toBe(200);
    expect(unsettled.body).toMatchObject({ total: 1, jobs: [{ id: "job_late", state: "estimate_kept" }] });
    const settled = await request(key, "GET", `/v2/admin/apps/${appId}/jobs?settled=true`);
    expect(settled.body).toMatchObject({ total: 1, jobs: [{ id: "job_settled", state: "settled" }] });
    expect((await request(key, "GET", `/v2/admin/apps/${appId}/jobs`)).body.total).toBe(2);
  });
});

describe("unpriced", () => {
  it("counts a charge as unpriced until a pricing correction prices it, in the totals and from the charges (Sol 7b-3 round 1)", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    const unresolved = await seed({ appId, usedAt: at("2025-10-02"), cost: null, priceSource: "unresolved", user: "u1" });
    await seed({ appId, usedAt: at("2025-10-02"), cost: null, priceSource: "not_priced", user: "u1" });
    const before = await request(key, "GET", `/v2/admin/apps/${appId}/usage?month=2025-10`);
    expect(before.body).toMatchObject({ charges: 2, unpriced: 2, cost_nano: 0 });
    // The pricing correction lands under the price's unit, on the charge's day.
    await seed({ appId, usedAt: at("2025-10-02"), kind: "correction", correctionKind: "pricing", correctsChargeId: unresolved, cost: 4_000, user: "u1" });
    const after = await request(key, "GET", `/v2/admin/apps/${appId}/usage?month=2025-10`);
    expect(after.body).toMatchObject({ charges: 2, unpriced: 1, cost_nano: 4_000 });
    const fromCharges = await request(key, "GET", `/v2/admin/apps/${appId}/usage/breakdown?from=2025-10-01&to=2025-10-31&by=user`);
    expect(fromCharges.body.rows).toEqual([expect.objectContaining({ key: "u1", charges: 2, unpriced: 1, cost_nano: 4_000 })]);
  });

  it("counts a job estimate settled in dollars as priced, once, however many corrections follow (Fable 7b-3)", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    const job = `job_${crypto.randomUUID().slice(0, 8)}`;
    const estimate = await seed({ appId, usedAt: at("2025-11-03"), kind: "estimate", ownerType: "job", ownerId: job, cost: null, priceSource: "unresolved", user: "u1" });
    const usage = async () => (await request(key, "GET", `/v2/admin/apps/${appId}/usage?month=2025-11`)).body;
    expect(await usage()).toMatchObject({ charges: 1, unpriced: 1 });
    await seed({ appId, usedAt: at("2025-11-03"), kind: "correction", ownerType: "job", ownerId: job, correctionKind: "dollars", correctsChargeId: estimate, cost: 700, user: "u1" });
    expect(await usage()).toMatchObject({ charges: 1, unpriced: 0, cost_nano: 700 });
    // A second correction of the same charge prices nothing more.
    await seed({ appId, usedAt: at("2025-11-03"), kind: "correction", ownerType: "job", ownerId: job, correctionKind: "pricing", correctsChargeId: estimate, cost: 50, user: "u1" });
    expect(await usage()).toMatchObject({ charges: 1, unpriced: 0, cost_nano: 750 });
    const fromCharges = await request(key, "GET", `/v2/admin/apps/${appId}/usage/breakdown?from=2025-11-01&to=2025-11-30&by=user`);
    expect(fromCharges.body.rows).toEqual([expect.objectContaining({ key: "u1", charges: 1, unpriced: 0, cost_nano: 750 })]);
  });

  it("migration 0009 takes charges corrected before it out of the unpriced count, once (Fable 7b-3)", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    const priced = await seed({ appId, usedAt: at("2025-12-04"), cost: null, priceSource: "unresolved" });
    await seed({ appId, usedAt: at("2025-12-04"), cost: null, priceSource: "unresolved" });
    await seed({ appId, usedAt: at("2025-12-04"), kind: "correction", correctionKind: "pricing", correctsChargeId: priced, cost: 300 });
    // A second correction of the same charge subtracts nothing more (Neon 7b-3 round 2).
    await seed({ appId, usedAt: at("2025-12-04"), kind: "correction", correctionKind: "dollars", correctsChargeId: priced, cost: 40 });
    // A failed unpriced charge with a unit, priced later: its own rollup row (outcome failed, unit images).
    const failed = await seed({ appId, usedAt: at("2025-12-04"), cost: null, priceSource: "unresolved", status: "provider_error", unit: "images" });
    await seed({ appId, usedAt: at("2025-12-04"), kind: "correction", correctionKind: "pricing", correctsChargeId: failed, cost: 200, status: "provider_error", unit: "images" });
    // As the rollup stood before 0009: every unpriced charge counted, no correction ever subtracted.
    await env.DB.prepare("UPDATE usage_day SET unpriced_charges = CASE outcome WHEN 'ok' THEN 2 ELSE 1 END WHERE account_id = ? AND app_id = ?")
      .bind(ACCOUNT_ID, appId)
      .run();
    // The migration's own statement, run over the table it now has.
    const update = MIGRATION_0009.split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .find((statement) => statement.includes("UPDATE `__new_usage_day`"));
    expect(update).toBeDefined();
    const sql = update!.replace(/^(--[^\n]*\n)+/u, "").replaceAll("`__new_usage_day`", "usage_day");
    // Driven from the corrections, never a scan of charges per rollup row (Neon 7b-3 round 1).
    const plan = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>()).results.map((row) => row.detail);
    expect(plan.join("\n")).toContain("charge_corrects");
    expect(plan.filter((line) => /^SCAN (o|charge)\b/u.test(line))).toEqual([]);
    await env.DB.prepare(sql).run();
    const usage = await request(key, "GET", `/v2/admin/apps/${appId}/usage?month=2025-12`);
    expect(usage.body).toMatchObject({ charges: 3, unpriced: 1, cost_nano: 540 });
    const rows = await env.DB.prepare("SELECT outcome, unit, unpriced_charges AS n FROM usage_day WHERE account_id = ? AND app_id = ? ORDER BY outcome")
      .bind(ACCOUNT_ID, appId)
      .all();
    expect(rows.results).toEqual([
      { outcome: "failed", unit: "images", n: 0 },
      { outcome: "ok", unit: "", n: 1 },
    ]);
  });
});

describe("dates", () => {
  it("refuse days and months the calendar has not, and years outside 1970 to 2999 (Sol 7b-3 round 1)", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    const status = async (path: string) => (await request(key, "GET", `/v2/admin/apps/${appId}/${path}`)).status;
    expect(await status("charges?from=2025-02-01&to=2025-02-29")).toBe(400);
    expect(await status("usage/breakdown?by=user&from=2025-04-31&to=2025-05-01")).toBe(400);
    expect(await status("usage/timeseries?from=2024-02-29&to=2024-03-01")).toBe(200);
    expect(await status("usage?month=1969-12")).toBe(400);
    expect(await status("usage?month=0099-01")).toBe(400);
    expect(await status("usage?month=3000-01")).toBe(400);
    expect(await status("usage?month=2999-12")).toBe(200);
    expect(await status("usage/timeseries?from=2999-12-31&to=2999-12-31")).toBe(200);
    // A defaulted start never falls before the first accepted day (Neon 7b-3 round 1).
    const early = await request(key, "GET", `/v2/admin/apps/${appId}/usage/timeseries?to=1970-01-10`);
    expect(early.status).toBe(200);
    expect(early.body).toMatchObject({ from: "1970-01-01", to: "1970-01-10" });
  });

  it("count a charge at midnight UTC on its own day, in the totals and in the charges", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    await seed({ appId, usedAt: Date.parse("2025-11-30T23:59:59.999Z"), id: "ch_last" });
    await seed({ appId, usedAt: Date.parse("2025-12-01T00:00:00.000Z"), id: "ch_first" });
    const november = await request(key, "GET", `/v2/admin/apps/${appId}/usage?month=2025-11`);
    expect(november.body.charges).toBe(1);
    const december = await request(key, "GET", `/v2/admin/apps/${appId}/usage?month=2025-12`);
    expect(december.body.charges).toBe(1);
    const lastDay = await request(key, "GET", `/v2/admin/apps/${appId}/charges?from=2025-11-30&to=2025-11-30`);
    expect(lastDay.body.charges.map((row: any) => row.id)).toEqual(["ch_last"]);
    const byUser = await request(key, "GET", `/v2/admin/apps/${appId}/usage/breakdown?by=operation&from=2025-12-01&to=2025-12-01`);
    expect(byUser.body.rows).toEqual([expect.objectContaining({ charges: 1 })]);
  });

  it("limit a breakdown from the charges to 31 days, and one from the day totals to 400", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    const status = async (path: string) => (await request(key, "GET", `/v2/admin/apps/${appId}/${path}`)).status;
    expect(await status("usage/breakdown?by=user&from=2025-01-01&to=2025-01-31")).toBe(200);
    expect(await status("usage/breakdown?by=user&from=2025-01-01&to=2025-02-01")).toBe(400);
    expect(await status("usage/breakdown?by=model&from=2025-01-01&to=2025-02-01")).toBe(200);
  });
});

describe("query plans", () => {
  /** The plan of the charge query a request really sends, with its real parameters. */
  async function planOf(send: () => Promise<unknown>): Promise<string> {
    const prepare = env.DB.prepare.bind(env.DB);
    let sent: { sql: string; params: unknown[] } | undefined;
    const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (!/\bFROM charge\b/u.test(sql) || /^\s*SELECT 1 AS found/u.test(sql)) return statement;
      const bind = statement.bind.bind(statement);
      return Object.assign(statement, {
        bind: (...params: unknown[]) => {
          sent = { sql, params };
          return bind(...params);
        },
      });
    });
    try {
      await send();
    } finally {
      spy.mockRestore();
    }
    expect(sent, "no charge query was sent").toBeDefined();
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sent!.sql}`).bind(...sent!.params).all<{ detail: string }>();
    return results.map((row) => row.detail).join("\n");
  }

  it("reads an app's charges, a deep page, a trace, an owner and a breakdown through their indexes (Sol 7b-3 round 1)", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    await seed({ appId, usedAt: at("2024-09-02"), trace: "trace-1", ownerId: "call_plan" });
    await seed({ appId, usedAt: at("2024-09-01") });
    const get = (path: string) => () => request(key, "GET", `/v2/admin/apps/${appId}/${path}`);

    const page = await planOf(get("charges?limit=1"));
    expect(page).toContain("charge_app_account_used");
    expect(page).not.toContain("TEMP B-TREE");
    const deep = await planOf(get(`charges?limit=1&before=${encodeURIComponent(`${at("2024-09-02")}.zzz`)}`));
    expect(deep).toMatch(/charge_app_account_used \(app_id=\? AND account_id=\? AND \(used_at,id\)<\(\?,\?\)\)/u);
    // A trace has no index of its own: it is looked for inside its range, by the app's index.
    expect(await planOf(get("charges?trace=trace-1&from=2024-09-01&to=2024-09-30"))).toContain("charge_app_account_used");
    // A user's charges come from the user index, not a walk through the app's (Fable 7b-3).
    await seed({ appId, usedAt: at("2024-09-02"), user: "rare-user" });
    expect(await planOf(get("charges?user=rare-user"))).toContain("charge_app_user_used");
    expect(await planOf(get("charges?owner=call_plan"))).toContain("charge_owner");
    expect(await planOf(get("usage/breakdown?by=user&from=2024-09-01&to=2024-09-30"))).toContain("charge_app_account_used");
  });
});

describe("isolation", () => {
  it("keeps two accounts' totals apart when an app id comes back in another account on the same day (Sol 7b-3 round 1)", async () => {
    const key = await seedManagementKey();
    const other = await seedHuman();
    const appId = `reused-${crypto.randomUUID().slice(0, 8)}`;
    // The first account's app was deleted; the same id now belongs to another account.
    await seed({ appId, usedAt: at("2025-07-10"), cost: 100 });
    await env.DB.prepare(
      "INSERT INTO app (id, account_id, name, config_json, revision, status, created_at, updated_at) VALUES (?, ?, 'Theirs', '{}', 1, 'active', 0, 0)",
    )
      .bind(appId, other.accountId)
      .run();
    await seed({ appId, usedAt: at("2025-07-10", 1), cost: 200, accountId: other.accountId });
    const rows = await env.DB.prepare("SELECT account_id, charges, cost_nano FROM usage_day WHERE app_id = ? ORDER BY cost_nano").bind(appId).all();
    expect(rows.results).toEqual([
      { account_id: ACCOUNT_ID, charges: 1, cost_nano: 100 },
      { account_id: other.accountId, charges: 1, cost_nano: 200 },
    ]);
    const mine = await request(key, "GET", "/v2/admin/usage?month=2025-07");
    expect(mine.body.apps.filter((row: any) => row.app_id === appId)).toEqual([expect.objectContaining({ deleted: true, charges: 1, cost_nano: 100 })]);
  });

  it("never pages into another account's app with a page position from one's own", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    await seed({ appId, usedAt: at("2025-08-02"), id: "ch_mine_2" });
    await seed({ appId, usedAt: at("2025-08-01"), id: "ch_mine_1" });
    const other = await seedHuman();
    const foreign = `foreign-${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare(
      "INSERT INTO app (id, account_id, name, config_json, revision, status, created_at, updated_at) VALUES (?, ?, 'Theirs', '{}', 1, 'active', 0, 0)",
    )
      .bind(foreign, other.accountId)
      .run();
    await seed({ appId: foreign, usedAt: at("2025-07-31"), accountId: other.accountId });
    const first = await request(key, "GET", `/v2/admin/apps/${appId}/charges?limit=1`);
    const before = encodeURIComponent(first.body.next_before);
    expect((await request(key, "GET", `/v2/admin/apps/${foreign}/charges?before=${before}`)).status).toBe(404);
    const next = await request(key, "GET", `/v2/admin/apps/${appId}/charges?before=${before}`);
    expect(next.body.charges.map((row: any) => row.id)).toEqual(["ch_mine_1"]);
  });

  it("answers 404 for another account's app, and leaves its usage out", async () => {
    const key = await seedManagementKey();
    const other = await seedHuman();
    const foreign = `foreign-${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare(
      "INSERT INTO app (id, account_id, name, config_json, revision, status, created_at, updated_at) VALUES (?, ?, 'Theirs', '{}', 1, 'active', 0, 0)",
    )
      .bind(foreign, other.accountId)
      .run();
    await seed({ appId: foreign, usedAt: at("2025-08-01"), accountId: other.accountId, cost: 5_000 });
    for (const path of ["usage", "usage/timeseries", "usage/breakdown", "charges", "jobs"]) {
      expect((await request(key, "GET", `/v2/admin/apps/${foreign}/${path}`)).status, path).toBe(404);
    }
    const account = await request(key, "GET", "/v2/admin/usage?month=2025-08");
    expect(account.body.apps.map((row: any) => row.app_id)).not.toContain(foreign);
  });
});

describe("tools", () => {
  it("read usage for an app or the whole account, and charges, as MCP and the CLI call them", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    await seed({ appId, usedAt: at("2025-09-03"), cost: 1_500_000 });

    const forApp = await request(key, "POST", "/v2/cli/tools/get_usage", { app: appId, month: "2025-09" });
    expect(forApp.status).toBe(200);
    expect(forApp.body.result).toMatchObject({ app_id: appId, charges: 1, cost_nano: 1_500_000 });
    expect(forApp.body.summary).toBe(`1 charge costing $0.0015 for ${appId} in 2025-09, 0 failed.`);
    const forAccount = await request(key, "POST", "/v2/cli/tools/get_usage", { month: "2025-09" });
    expect(forAccount.body.result.apps).toEqual([expect.objectContaining({ app_id: appId })]);
    // An explicit null app reads the account, as a missing one does (Neon 7b-3 round 1).
    const nullApp = await request(key, "POST", "/v2/cli/tools/get_usage", { app: null, month: "2025-09" });
    expect(nullApp.status).toBe(200);
    expect(nullApp.body.result.apps).toEqual([expect.objectContaining({ app_id: appId })]);
    const charges = await request(key, "POST", "/v2/cli/tools/list_app_charges", { app: appId });
    expect(charges.body.result.charges).toHaveLength(1);
    const breakdown = await request(key, "POST", "/v2/cli/tools/get_usage_breakdown", { app: appId, from: "2025-09-01", to: "2025-09-30" });
    expect(breakdown.body.result.rows).toEqual([expect.objectContaining({ key: "gpt-4o-mini", charges: 1 })]);
    const days = await request(key, "POST", "/v2/cli/tools/get_usage_timeseries", { app: appId, from: "2025-09-01", to: "2025-09-30" });
    expect(days.body.result.buckets).toHaveLength(1);
  });
});

describe("filters with no index", () => {
  it("read a trace inside at most 31 days, since a trace id has no index of its own (Fable 7b-3)", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    await seed({ appId, usedAt: at("2025-08-05"), trace: "t-1" });
    const get = (query: string) => request(key, "GET", `/v2/admin/apps/${appId}/charges?${query}`);
    // No range: the last 30 days, where this old charge is not.
    expect(await get("trace=t-1")).toMatchObject({ status: 200, body: { charges: [] } });
    expect((await get("trace=t-1&from=2025-08-01")).status).toBe(400);
    expect((await get("trace=t-1&from=2025-07-01&to=2025-08-05")).status).toBe(400);
    const found = await get("trace=t-1&from=2025-08-01&to=2025-08-31");
    expect(found.status).toBe(200);
    expect(found.body.charges).toHaveLength(1);
  });

  it("read a model, status or install inside the last 30 days by default and at most 31, unless a user narrows them (Neon 7b-3 round 1)", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    const today = new Date().toISOString().slice(0, 10);
    const recent = await seed({ appId, usedAt: Date.now() - 2 * 86_400_000, model: "m-rare", user: "u-rare" });
    const old = await seed({ appId, usedAt: Date.now() - 45 * 86_400_000, model: "m-rare", user: "u-rare" });
    const ids = async (query: string) => {
      const response = await request(key, "GET", `/v2/admin/apps/${appId}/charges?${query}`);
      expect(response.status).toBe(200);
      return response.body.charges.map((row: any) => row.id);
    };
    expect(await ids("model=m-rare")).toEqual([recent]);
    const wide = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
    expect((await request(key, "GET", `/v2/admin/apps/${appId}/charges?model=m-rare&from=${wide}&to=${today}`)).status).toBe(400);
    expect((await request(key, "GET", `/v2/admin/apps/${appId}/charges?status=failed&from=${wide}`)).status).toBe(400);
    // A user has its own index: no cap, and by default every charge kept.
    expect(await ids("model=m-rare&user=u-rare")).toEqual([recent, old]);
    expect(await ids(`model=m-rare&user=u-rare&from=${wide}&to=${today}`)).toEqual([recent, old]);
  });
});

describe("month totals after the nightly fold", () => {
  it("read the same before and after the real fold moves the month's days into its total (Fable 7b-3)", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    await seed({ appId, usedAt: at("2024-02-03"), cost: 1_000 });
    await seed({ appId, usedAt: at("2024-02-20"), cost: 2_500, status: "timeout" });
    await seed({ appId, usedAt: at("2024-02-29"), cost: null, priceSource: "unresolved" });
    const read = async () => (await request(key, "GET", `/v2/admin/apps/${appId}/usage?month=2024-02`)).body;
    const before = await read();
    expect(before).toMatchObject({ charges: 3, failed: 1, unpriced: 1, cost_nano: 3_500 });
    // Well past 400 days: the fold moves February 2024's days into its month total.
    await runUsageRetention(env.DB, Date.parse("2026-06-01T12:00:00Z"), new QueryBudget(1_000));
    const days = await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_day WHERE account_id = ? AND app_id = ?").bind(ACCOUNT_ID, appId).first("n");
    expect(days).toBe(0);
    expect(await read()).toEqual(before);
  });
});

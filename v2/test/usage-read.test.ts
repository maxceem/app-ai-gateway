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
import { ACCOUNT_ID, clearCaches, LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement, seedHuman, seedManagementKey } from "./helpers.ts";

beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

beforeEach(() => {
  clearCaches();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

const ORIGIN = "https://gateway.test";
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
}

/** A charge written straight to the ledger table; the rollup trigger fills `usage_day`. */
async function seed(values: Seed): Promise<string> {
  counter += 1;
  const id = values.id ?? `ch_${String(counter).padStart(4, "0")}_${crypto.randomUUID().slice(0, 6)}`;
  const kind = values.kind ?? "attempt";
  await env.DB.prepare(
    `INSERT INTO charge (id, kind, account_id, app_id, end_user_id, owner_type, owner_id, provider_type, provider_connection_id,
       operation, model, status, cost_nano, measured, price_source, input_tokens, output_tokens, session_ms, measures_json,
       correction_kind, corrects_charge_id, used_at, usage_day, written_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)`,
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
      kind === "correction" ? "units" : null,
      values.correctsChargeId ?? null,
      values.usedAt,
      new Date(values.usedAt).toISOString().slice(0, 10),
      values.usedAt,
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

    const failed = await request(key, "GET", `/v2/admin/apps/${appId}/charges?status=failed`);
    expect(failed.body.charges.map((row: any) => row.id)).toEqual(["ch_c"]);
    const owner = await request(key, "GET", `/v2/admin/apps/${appId}/charges?owner=call_1`);
    expect(owner.body.charges.map((row: any) => row.id)).toEqual(["ch_b", "ch_a"]);
    const unpriced = await request(key, "GET", `/v2/admin/apps/${appId}/charges?price_source=unresolved`);
    expect(unpriced.body.charges.map((row: any) => row.id)).toEqual(["ch_d"]);
    const range = await request(key, "GET", `/v2/admin/apps/${appId}/charges?from=2025-06-02&to=2025-06-03`);
    expect(range.body.charges).toEqual([]);
    expect((await request(key, "GET", `/v2/admin/apps/${appId}/charges?before=nonsense`)).status).toBe(400);
  });

  it("show the jobs whose estimate was never settled", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    const settledEstimate = await seed({ appId, usedAt: at("2025-07-01"), kind: "estimate", ownerType: "job", ownerId: "job_settled", provider: "fal" });
    await seed({ appId, usedAt: at("2025-07-01"), id: "settle:job:job_settled", kind: "correction", ownerType: "job", ownerId: "job_settled", correctsChargeId: settledEstimate, provider: "fal" });
    await seed({ appId, usedAt: at("2025-07-02"), kind: "estimate", ownerType: "job", ownerId: "job_late", provider: "fal" });

    const unsettled = await request(key, "GET", `/v2/admin/apps/${appId}/jobs?settled=false`);
    expect(unsettled.status).toBe(200);
    expect(unsettled.body).toMatchObject({ total: 1, jobs: [{ id: "job_late", state: "estimate_kept" }] });
    const settled = await request(key, "GET", `/v2/admin/apps/${appId}/jobs?settled=true`);
    expect(settled.body).toMatchObject({ total: 1, jobs: [{ id: "job_settled", state: "settled" }] });
    expect((await request(key, "GET", `/v2/admin/apps/${appId}/jobs`)).body.total).toBe(2);
  });
});

describe("isolation", () => {
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
    const charges = await request(key, "POST", "/v2/cli/tools/list_app_charges", { app: appId });
    expect(charges.body.result.charges).toHaveLength(1);
    const breakdown = await request(key, "POST", "/v2/cli/tools/get_usage_breakdown", { app: appId, from: "2025-09-01", to: "2025-09-30" });
    expect(breakdown.body.result.rows).toEqual([expect.objectContaining({ key: "gpt-4o-mini", charges: 1 })]);
    const days = await request(key, "POST", "/v2/cli/tools/get_usage_timeseries", { app: appId, from: "2025-09-01", to: "2025-09-30" });
    expect(days.body.result.buckets).toHaveLength(1);
  });
});

/**
 * Step 1d, the rest of the management API: app PATCH, validate and check,
 * end users, the price list, the provider key test, and the plan ceilings
 * checked when settings are created.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { billingPlanLimits } from "../src/billing/access.ts";
import { ACCOUNT_ID, clearCaches, seedManagementKey, LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement } from "./helpers.ts";

beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

const ORIGIN = "https://gateway.test";

async function request(key: string | null, method: string, path: string, body?: unknown, environment: Env = env) {
  const headers = new Headers({ "content-type": "application/json" });
  if (key !== null) headers.set("authorization", `Bearer ${key}`);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    environment,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, any> };
}

const apiKeyConfig = (routing: Record<string, unknown> = {}, endUser: Record<string, unknown> = { source: "none" }) => ({
  authentication: { type: "api_key", end_user: endUser },
  routing: { providers: routing },
});

async function createProvider(key: string, overrides: Record<string, unknown> = {}, environment: Env = env) {
  return request(
    key,
    "POST",
    "/v2/admin/providers",
    { type: "openai", name: "OpenAI", slug: `openai-${crypto.randomUUID().slice(0, 6)}`, secret: "sk-live-secret-abcd", ...overrides },
    environment,
  );
}

async function createApp(key: string, config: unknown = apiKeyConfig(), environment: Env = env) {
  return request(key, "POST", "/v2/admin/apps", { name: "Mgmt", config }, environment);
}

/** An environment whose billing service answers with a plan of these limits, or fails. */
function hosted(limits: Record<string, unknown> | null | "down"): Env {
  return {
    ...env,
    BILLING: {
      getTenantAccess: async () => {
        if (limits === "down") throw new Error("billing down");
        if (limits === null) return { plan: null, subscription: null };
        return { plan: { planKey: "p", planName: "P", isDefault: true, limits }, subscription: null };
      },
    },
  } as unknown as Env;
}

beforeEach(() => {
  clearCaches();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("app PATCH", () => {
  it("applies the operations to the app as read, and saves as PUT would", async () => {
    const key = await seedManagementKey();
    const { body } = await createApp(key);
    const path = `/v2/admin/apps/${body.app.id}`;
    const patched = await request(key, "PATCH", path, {
      revision: 1,
      operations: [
        { op: "replace", path: "/name", value: "Renamed" },
        { op: "replace", path: "/config/limits/per_app/requests/per_minute", value: 600 },
      ],
    });
    expect(patched).toMatchObject({ status: 200, body: { app: { name: "Renamed", revision: 2 } } });
    expect(patched.body.app.config.limits.per_app.requests.per_minute).toBe(600);
    // null is a value: it sets the limit back to unlimited.
    const cleared = await request(key, "PATCH", path, {
      revision: 2,
      operations: [{ op: "replace", path: "/config/limits/per_app/requests/per_minute", value: null }],
    });
    expect(cleared.body.app.config.limits.per_app.requests.per_minute).toBeNull();
  });

  it("needs the revision, and writes nothing unless every operation applies and the result is accepted", async () => {
    const key = await seedManagementKey();
    const { body } = await createApp(key);
    const path = `/v2/admin/apps/${body.app.id}`;
    const rename = { op: "replace", path: "/name", value: "Again" };
    expect(await request(key, "PATCH", path, { operations: [rename] })).toMatchObject({
      status: 400,
      body: { error: { code: "app_revision_required" } },
    });
    const missing = await request(key, "PATCH", path, {
      revision: 1,
      operations: [rename, { op: "remove", path: "/config/nothing" }],
    });
    expect(missing).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining("operations[1]") } } });
    const refused = await request(key, "PATCH", path, {
      revision: 1,
      operations: [rename, { op: "add", path: "/config/routing/providers/no-such-slug", value: { operations: ["openai.chat"] } }],
    });
    expect(refused.status).toBe(400);
    expect(await request(key, "PATCH", path, { revision: 1, operations: [{ op: "add", path: "/config/__proto__", value: 1 }] })).toMatchObject({
      status: 400,
      body: { error: { message: expect.stringContaining("reserved") } },
    });
    expect(await request(key, "PATCH", path, { revision: 1, operations: [{ op: "replace", path: "/id", value: "x" }] })).toMatchObject({ status: 400 });
    expect((await request(key, "GET", path)).body.app).toMatchObject({ name: "Mgmt", revision: 1 });
    expect(await request(key, "PATCH", path, { revision: 7, operations: [rename] })).toMatchObject({
      status: 409,
      body: { error: { code: "app_revision_conflict" } },
    });
  });

  it("answers a stale patch with a conflict even when the path it names is gone", async () => {
    const key = await seedManagementKey();
    const config = { ...apiKeyConfig({}, { source: "header", header: "x-end-user-id" }), limits: { per_user: { spending: { scope: "user" } } } };
    const { body } = await createApp(key, config);
    const path = `/v2/admin/apps/${body.app.id}`;
    // `scope` has no default, so once removed it is really gone.
    const scope = "/config/limits/per_user/spending/scope";
    expect((await request(key, "PATCH", path, { revision: 1, operations: [{ op: "remove", path: scope }] })).status).toBe(200);
    expect(await request(key, "PATCH", path, { revision: 1, operations: [{ op: "replace", path: scope, value: "user" }] })).toMatchObject({
      status: 409,
      body: { error: { code: "app_revision_conflict" } },
    });
  });
});

describe("validate and check", () => {
  it("validates with only the read grant, as a create or an update would be judged", async () => {
    const key = await seedManagementKey();
    const reader = await seedManagementKey({ grant: "read" });
    const { body: provider } = await createProvider(key);
    const slug = provider.provider.slug as string;
    const routed = apiKeyConfig({ [slug]: { operations: ["openai.chat"] } });
    const { body } = await createApp(key, routed);
    const appId = body.app.id as string;

    expect(await request(reader, "POST", "/v2/admin/app-drafts/validate", { name: "Draft", config: routed })).toMatchObject({
      status: 200,
      body: { valid: true },
    });
    expect(
      await request(reader, "POST", "/v2/admin/app-drafts/validate", { name: "Draft", config: apiKeyConfig({ [slug]: { operations: ["openai.chat"], models: ["gpt-unpriced-zz"] } }) }),
    ).toMatchObject({ status: 400, body: { error: { code: "pricing_not_configured" } } });

    // After the connection is deleted, an update may keep naming it; a new app may not.
    await request(key, "DELETE", `/v2/admin/providers/${provider.provider.id}`);
    expect(await request(reader, "POST", `/v2/admin/apps/${appId}/validate`, { name: "Kept", config: routed })).toMatchObject({
      status: 200,
      body: { valid: true, app_id: appId },
    });
    expect((await request(reader, "POST", "/v2/admin/app-drafts/validate", { name: "Draft", config: routed })).status).toBe(400);
    expect(await request(key, "PUT", `/v2/admin/apps/${appId}`, { name: "Kept", config: routed, revision: 1 })).toMatchObject({
      status: 200,
      body: { app: { name: "Kept" } },
    });
    // Under the deleted connection's slug, only the unchanged entry is kept: a changed one cannot be checked.
    const changed = apiKeyConfig({ [slug]: { operations: ["openai.chat", "openai.nothing"] } });
    expect((await request(key, "PUT", `/v2/admin/apps/${appId}`, { name: "Kept", config: changed, revision: 2 })).status).toBe(400);
    expect((await request(reader, "POST", `/v2/admin/apps/${appId}/validate`, { name: "Kept", config: changed })).status).toBe(400);
    // A slug the stored config never named is still checked.
    const other = apiKeyConfig({ [slug]: { operations: ["openai.chat"] }, "never-there": { operations: ["openai.chat"] } });
    expect((await request(key, "PUT", `/v2/admin/apps/${appId}`, { name: "Kept", config: other, revision: 2 })).status).toBe(400);
  });

  it("reports each named connection's status, and ready only with an active one", async () => {
    const key = await seedManagementKey();
    const { body: first } = await createProvider(key);
    const { body: second } = await createProvider(key);
    const config = apiKeyConfig({
      [first.provider.slug]: { operations: ["openai.chat"] },
      [second.provider.slug]: { operations: ["openai.chat"] },
    });
    const { body } = await createApp(key, config);
    const path = `/v2/admin/apps/${body.app.id}/check`;
    expect((await request(key, "GET", path)).body).toMatchObject({ app_id: body.app.id, status: "active", ready: true });

    await request(key, "PUT", `/v2/admin/providers/${first.provider.id}`, { revision: 1, status: "disabled" });
    await request(key, "DELETE", `/v2/admin/providers/${second.provider.id}`);
    const checked = await request(key, "GET", path);
    expect(checked.body.ready).toBe(false);
    expect(checked.body.providers).toEqual([
      { id: first.provider.id, slug: first.provider.slug, status: "disabled" },
      { id: null, slug: second.provider.slug, status: "missing" },
    ]);
    expect(checked.body.limitations.length).toBeGreaterThan(0);
  });
});

describe("plan ceilings on saved settings", () => {
  const count = async (sql: string, ...binds: unknown[]) =>
    (await env.DB.prepare(sql).bind(...binds).first<number>("n")) ?? 0;

  it("refuses an app over maxApps, counted in the insert itself", async () => {
    const key = await seedManagementKey();
    const used = await count("SELECT COUNT(*) AS n FROM app WHERE account_id = ?", ACCOUNT_ID);
    const plan = hosted({ maxApps: used + 1 });
    expect((await createApp(key, apiKeyConfig(), plan)).status).toBe(201);
    clearCaches();
    const refused = await createApp(key, apiKeyConfig(), plan);
    expect(refused).toMatchObject({
      status: 409,
      body: { error: { code: "billing_plan_limit_reached", data: { limit: used + 1, used: used + 1 } } },
    });
    expect(await count("SELECT COUNT(*) AS n FROM app WHERE account_id = ?", ACCOUNT_ID)).toBe(used + 1);
    // Two creates at once cannot both slip under the ceiling.
    clearCaches();
    const more = hosted({ maxApps: used + 2 });
    const racing = await Promise.all([createApp(key, apiKeyConfig(), more), createApp(key, apiKeyConfig(), more)]);
    expect(racing.map((result) => result.status).sort()).toEqual([201, 409]);
  });

  it("refuses a provider connection over maxProviders", async () => {
    const key = await seedManagementKey();
    const used = await count("SELECT COUNT(*) AS n FROM provider_connection WHERE account_id = ?", ACCOUNT_ID);
    const plan = hosted({ maxProviders: used });
    expect(await createProvider(key, {}, plan)).toMatchObject({ status: 409, body: { error: { code: "billing_plan_limit_reached" } } });
    expect(await count("SELECT COUNT(*) AS n FROM provider_connection WHERE account_id = ?", ACCOUNT_ID)).toBe(used);
  });

  it("counts only active keys against maxActiveKeysPerApp", async () => {
    const key = await seedManagementKey();
    const plan = hosted({ maxActiveKeysPerApp: 2 });
    const { body } = await createApp(key, apiKeyConfig(), plan);
    const keys = `/v2/admin/apps/${body.app.id}/keys`;
    const second = await request(key, "POST", keys, { name: "Second" }, plan);
    expect(second.status).toBe(201);
    expect(await request(key, "POST", keys, { name: "Third" }, plan)).toMatchObject({
      status: 409,
      body: { error: { code: "billing_plan_limit_reached", data: { limit: 2, used: 2 } } },
    });
    await request(key, "POST", `${keys}/${second.body.id}/revoke`, undefined, plan);
    expect((await request(key, "POST", keys, { name: "Third" }, plan)).status).toBe(201);
  });

  it("refuses a capped create when the plan cannot be read, and caps nothing self-hosted", async () => {
    const key = await seedManagementKey();
    expect(await createApp(key, apiKeyConfig(), hosted("down"))).toMatchObject({ status: 503, body: { error: { code: "billing_unavailable" } } });
    clearCaches();
    expect(await createApp(key, apiKeyConfig(), hosted(null))).toMatchObject({ status: 402, body: { error: { code: "billing_payment_required" } } });
    clearCaches();
    expect((await createApp(key, apiKeyConfig(), hosted({}))).status).toBe(201);
    expect((await createApp(key)).status).toBe(201);
  });

  it("answers 503 with Retry-After when a ceiling in the plan data cannot be read", async () => {
    const key = await seedManagementKey();
    const refused = await request(key, "POST", "/v2/admin/apps", { name: "Mgmt", config: apiKeyConfig() }, hosted({ maxApps: -1 }));
    expect(refused).toMatchObject({ status: 503, body: { error: { code: "billing_unavailable" } } });
    expect(refused.headers.get("retry-after")).toBe("5");
  });

  it("refuses a capped create while only a stale plan is known, even a stale no-plan", async () => {
    const key = await seedManagementKey();
    let state: "plan" | "none" | "down" = "plan";
    const flaky = {
      ...env,
      BILLING: {
        getTenantAccess: async () => {
          if (state === "down") throw new Error("billing down");
          return { plan: state === "plan" ? { planKey: "p", planName: "P", isDefault: true, limits: {} } : null, subscription: null };
        },
      },
    } as unknown as Env;
    for (const known of ["plan", "none"] as const) {
      clearCaches();
      state = known;
      await createApp(key, apiKeyConfig(), flaky);
      // Past the 30 s cache, inside the hour the last reading is kept.
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60_000 });
      state = "down";
      const refused = await createApp(key, apiKeyConfig(), flaky);
      vi.useRealTimers();
      expect(refused).toMatchObject({ status: 503, body: { error: { code: "billing_unavailable" } } });
    }
  });

  it("refuses an app-key app when the plan allows no keys, but not an App Attest app", async () => {
    const key = await seedManagementKey();
    const plan = hosted({ maxActiveKeysPerApp: 0 });
    expect(await createApp(key, apiKeyConfig(), plan)).toMatchObject({
      status: 409,
      body: { error: { code: "billing_plan_limit_reached", data: { limit: 0 } } },
    });
    const attest = {
      authentication: { type: "apple_app_attest", end_user: { source: "app_install" }, app_attest: { team_id: "AAAAAAAAAA", bundle_id: "com.example.app" } },
    };
    expect((await createApp(key, attest, plan)).status).toBe(201);
  });

  it("never lets a bad ceiling value stop the allowance from being read", () => {
    const access = { state: "billed", plan: { planKey: "p", planName: "P", isDefault: true, limits: { maxRequestsPerMonth: 10, maxApps: -1 } }, subscription: null } as const;
    expect(billingPlanLimits(access)).toEqual({ maxRequestsPerMonth: 10 });
    expect(() => billingPlanLimits(access, ["maxApps"])).toThrow(/maxApps/u);
  });
});

describe("end users", () => {
  let chargeCount = 0;
  async function seedCharge(appId: string, endUserId: string | null, values: { usedAt: number; cost?: number | null; status?: string; kind?: string }) {
    chargeCount += 1;
    const kind = values.kind ?? "attempt";
    await env.DB.prepare(
      `INSERT INTO charge (id, kind, account_id, app_id, end_user_id, owner_type, owner_id, provider_type, operation, model, status,
         cost_nano, measured, price_source, input_tokens, output_tokens, measures_json, correction_kind, used_at, usage_day, written_at)
       VALUES (?, ?, ?, ?, ?, 'call', ?, 'openai', 'openai.chat', 'gpt-4o-mini', ?, ?, 'complete', 'list_rate', 10, 2, '{}', ?, ?, ?, ?)`,
    )
      .bind(
        `ch_${chargeCount}_${crypto.randomUUID().slice(0, 6)}`,
        kind,
        ACCOUNT_ID,
        appId,
        endUserId,
        `call_${chargeCount}`,
        values.status ?? "ok",
        values.cost === undefined ? 1_000 : values.cost,
        kind === "correction" ? "pricing" : null,
        values.usedAt,
        new Date(values.usedAt).toISOString().slice(0, 10),
        values.usedAt,
      )
      .run();
  }

  it("lists signed-in users and ids only charges or refusals name, with the month's usage", async () => {
    const key = await seedManagementKey();
    const { body } = await createApp(key, apiKeyConfig({}, { source: "header", header: "x-end-user-id" }));
    const appId = body.app.id as string;
    const now = Date.now();
    const lastMonth = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() - 1, 15);
    await env.DB.prepare("INSERT INTO app_end_user (app_id, id, status, created_at, last_seen_at) VALUES (?, 'signed-in', 'active', ?, ?)")
      .bind(appId, now - 5_000, now - 5_000)
      .run();
    await seedCharge(appId, "header-user", { usedAt: now - 1_000, cost: 1_500 });
    await seedCharge(appId, "header-user", { usedAt: now - 2_000, cost: null, status: "timeout" });
    await seedCharge(appId, "header-user", { usedAt: now - 2_000, cost: 250, kind: "correction" });
    await seedCharge(appId, "header-user", { usedAt: lastMonth, cost: 9_999 });
    await seedCharge(appId, "100%_user", { usedAt: now - 3_000 });
    await seedCharge(appId, null, { usedAt: now - 3_000 });
    await env.DB.prepare("INSERT INTO app_rejection_event (id, app_id, user_id, reason, created_at) VALUES (?, ?, 'refused-only', 'model_not_allowed', ?)")
      .bind(crypto.randomUUID(), appId, now - 4_000)
      .run();

    const listed = await request(key, "GET", `/v2/admin/apps/${appId}/users`);
    expect(listed.status).toBe(200);
    expect(listed.body.total).toBe(4);
    expect(listed.body.users.map((user: { id: string }) => user.id)).toEqual(["header-user", "100%_user", "refused-only", "signed-in"]);
    const header = listed.body.users[0];
    expect(header).toMatchObject({
      is_virtual: true,
      status: "active",
      created_at: new Date(lastMonth).toISOString(),
      usage: { charges: 2, failed: 1, cost_nano: 1_750, input_tokens: 30 },
    });
    expect(listed.body.users[3]).toMatchObject({ is_virtual: false, usage: { charges: 0, cost_nano: 0 } });

    const month = new Date(lastMonth).toISOString().slice(0, 7);
    const older = await request(key, "GET", `/v2/admin/apps/${appId}/users/header-user?month=${month}`);
    expect(older.body).toMatchObject({ month, user: { id: "header-user", usage: { charges: 1, cost_nano: 9_999 } } });

    // `%` and `_` in a search match themselves.
    const searched = await request(key, "GET", `/v2/admin/apps/${appId}/users?query=${encodeURIComponent("0%_")}`);
    expect(searched.body.users.map((user: { id: string }) => user.id)).toEqual(["100%_user"]);
    const page = await request(key, "GET", `/v2/admin/apps/${appId}/users?limit=1&offset=1`);
    expect(page.body).toMatchObject({ total: 4, limit: 1, offset: 1, users: [{ id: "100%_user" }] });
    expect((await request(key, "GET", `/v2/admin/apps/${appId}/users?month=2026-13`)).status).toBe(400);
    expect((await request(key, "GET", `/v2/admin/apps/${appId}/users/nobody`)).status).toBe(404);
  });

  it("blocks and unblocks a user with a row, and refuses a virtual one", async () => {
    const key = await seedManagementKey();
    const reader = await seedManagementKey({ grant: "read" });
    const { body } = await createApp(key, apiKeyConfig({}, { source: "header", header: "x-end-user-id" }));
    const appId = body.app.id as string;
    const now = Date.now();
    await env.DB.prepare("INSERT INTO app_end_user (app_id, id, status, created_at) VALUES (?, 'u1', 'active', ?)").bind(appId, now).run();
    await seedCharge(appId, "virtual-user", { usedAt: now });

    expect((await request(reader, "POST", `/v2/admin/apps/${appId}/users/u1/block`)).status).toBe(403);
    expect(await request(key, "POST", `/v2/admin/apps/${appId}/users/u1/block`)).toMatchObject({
      status: 200,
      body: { app_id: appId, user_id: "u1", blocked: true },
    });
    const blocked = await request(key, "GET", `/v2/admin/apps/${appId}/users?status=blocked`);
    expect(blocked.body.users.map((user: { id: string }) => user.id)).toEqual(["u1"]);
    expect((await request(key, "POST", `/v2/admin/apps/${appId}/users/u1/unblock`)).body.blocked).toBe(false);
    expect((await request(key, "POST", `/v2/admin/apps/${appId}/users/virtual-user/block`)).status).toBe(404);
    expect((await request(key, "POST", `/v2/admin/apps/no-such-app/users/u1/block`)).status).toBe(404);
  });
});

describe("price list and key test", () => {
  it("serves the price file", async () => {
    const reader = await seedManagementKey({ grant: "read" });
    const prices = await request(reader, "GET", "/v2/admin/prices");
    expect(prices.status).toBe(200);
    expect(prices.body.prices.openai["gpt-4o-mini"]).toMatchObject({ input: expect.any(Number), output: expect.any(Number) });
  });

  it("tests a key on the host live requests would use, and stores nothing", async () => {
    const key = await seedManagementKey();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const test = (body: Record<string, unknown>) => request(key, "POST", "/v2/admin/providers/test", { type: "openai", secret: "sk-test-key-1234", ...body });

    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect((await test({})).body).toEqual({ validated: true });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/models");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-test-key-1234");
    expect(init?.redirect).toBe("manual");

    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    expect((await test({})).body).toEqual({ validated: false, reason: "rejected", status: 401 });
    // A 403 is a key that works but may not list models: it proves nothing.
    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 403 }));
    expect((await test({})).body).toEqual({ validated: false, reason: "unexpected_status", status: 403 });
    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 404 }));
    expect((await test({ baseUrl: "https://llm.example.com/" })).body).toEqual({ validated: false, reason: "unexpected_status", status: 404 });
    expect(fetchSpy.mock.calls[3]![0]).toBe("https://llm.example.com/v1/models");
    fetchSpy.mockRejectedValueOnce(new Error("connection refused"));
    expect((await test({})).body).toEqual({ validated: false, reason: "unreachable" });
    expect((await test({ type: "fal" })).body).toEqual({ validated: false, reason: "no_probe" });
    expect(fetchSpy).toHaveBeenCalledTimes(5);

    expect((await test({ baseUrl: "https://10.0.0.1/" })).status).toBe(400);
    expect((await test({ type: "nobody" })).status).toBe(400);
    const reader = await seedManagementKey({ grant: "read" });
    expect((await request(reader, "POST", "/v2/admin/providers/test", { type: "openai", secret: "sk-x" })).status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM provider_connection WHERE secret_hint = '1234'").first("n")).toBe(0);
  });
});

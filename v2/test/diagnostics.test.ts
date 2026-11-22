/**
 * Step 7b-4: reading an app's sign-in attempts, its refused requests and a
 * summary of both back through the management API and its tools. Every read
 * goes through an app the caller's account owns; deleting the app deletes
 * its events.
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
const DAY = 86_400_000;

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
    name: "Diagnostics",
    config: { authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } }, routing: { providers: {} } },
  });
  expect(status).toBe(201);
  return body.app.id as string;
}

async function foreignApp(): Promise<string> {
  const other = await seedHuman();
  const id = `foreign-${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(
    "INSERT INTO app (id, account_id, name, config_json, revision, status, created_at, updated_at) VALUES (?, ?, 'Theirs', '{}', 1, 'active', 0, 0)",
  )
    .bind(id, other.accountId)
    .run();
  return id;
}

let counter = 0;

interface AuthSeed {
  appId: string;
  at: number;
  id?: string;
  event?: "challenge" | "register" | "token_exchange";
  outcome?: string;
  reason?: string | null;
  user?: string | null;
  asn?: number | null;
  network?: string | null;
  claimDelayMs?: number | null;
}

async function authEvent(values: AuthSeed): Promise<string> {
  counter += 1;
  const id = values.id ?? `ae_${String(counter).padStart(4, "0")}`;
  await env.DB.prepare(
    `INSERT INTO app_auth_event (id, app_id, user_id, event, auth_method, outcome, reason, network_asn, network_name, latency_ms, claim_delay_ms, created_at)
     VALUES (?, ?, ?, ?, 'api_key', ?, ?, ?, ?, 12, ?, ?)`,
  )
    .bind(
      id,
      values.appId,
      values.user ?? null,
      values.event ?? "token_exchange",
      values.outcome ?? "ok",
      values.reason ?? null,
      values.asn ?? null,
      values.network ?? null,
      values.claimDelayMs ?? null,
      values.at,
    )
    .run();
  return id;
}

async function rejection(values: { appId: string; at: number; id?: string; reason?: string; scope?: string | null; user?: string | null }): Promise<string> {
  counter += 1;
  const id = values.id ?? `re_${String(counter).padStart(4, "0")}`;
  await env.DB.prepare(
    `INSERT INTO app_rejection_event (id, app_id, user_id, reason, scope, provider_slug, model, latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?, 'openai', 'gpt-4o-mini', 3, ?)`,
  )
    .bind(id, values.appId, values.user ?? null, values.reason ?? "model_not_allowed", values.scope ?? null, values.at)
    .run();
  return id;
}

const at = (day: string, ms = 0) => Date.parse(`${day}T12:00:00Z`) + ms;
/** Noon UTC, `days` days before today. */
const daysAgo = (days: number) => Date.parse(`${new Date().toISOString().slice(0, 10)}T12:00:00Z`) - days * DAY;
const dayOf = (time: number) => new Date(time).toISOString().slice(0, 10);

describe("sign-in attempts", () => {
  it("page newest first through equal times, filtered by user, event or outcome", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    await authEvent({ appId, at: at("2025-05-02"), id: "ae_b", user: "u1" });
    await authEvent({ appId, at: at("2025-05-02"), id: "ae_a", user: "u2", outcome: "issuer_token_rejected", reason: "expired" });
    await authEvent({ appId, at: at("2025-05-01"), id: "ae_0", user: "u1", event: "register" });

    const first = await request(key, "GET", `/v2/admin/apps/${appId}/auth-events?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.events.map((row: any) => row.id)).toEqual(["ae_b", "ae_a"]);
    expect(first.body.events[1]).toMatchObject({
      user_id: "u2",
      event: "token_exchange",
      outcome: "issuer_token_rejected",
      reason: "expired",
      claim_delay_ms: null,
      created_at: new Date(at("2025-05-02")).toISOString(),
    });
    const next = await request(key, "GET", `/v2/admin/apps/${appId}/auth-events?limit=2&before=${encodeURIComponent(first.body.next_before)}`);
    expect(next.body.events.map((row: any) => row.id)).toEqual(["ae_0"]);
    expect(next.body.next_before).toBeNull();

    const byUser = await request(key, "GET", `/v2/admin/apps/${appId}/auth-events?user=u1`);
    expect(byUser.body.events.map((row: any) => row.id)).toEqual(["ae_b", "ae_0"]);
    const byOutcome = await request(key, "GET", `/v2/admin/apps/${appId}/auth-events?outcome=issuer_token_rejected&from=2025-05-01&to=2025-05-31`);
    expect(byOutcome.body.events.map((row: any) => row.id)).toEqual(["ae_a"]);
    const byEvent = await request(key, "GET", `/v2/admin/apps/${appId}/auth-events?event=register&from=2025-05-01&to=2025-05-31`);
    expect(byEvent.body.events.map((row: any) => row.id)).toEqual(["ae_0"]);
  });

  it("read an event or outcome filter inside the last 30 days by default and at most 31, unless a user narrows it", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    await authEvent({ appId, at: daysAgo(1), id: "ae_recent", outcome: "attest_failed", user: "u1" });
    await authEvent({ appId, at: daysAgo(40), id: "ae_old", outcome: "attest_failed", user: "u1" });
    const recent = await request(key, "GET", `/v2/admin/apps/${appId}/auth-events?outcome=attest_failed`);
    expect(recent.body.events.map((row: any) => row.id)).toEqual(["ae_recent"]);
    const tooLong = await request(key, "GET", `/v2/admin/apps/${appId}/auth-events?outcome=attest_failed&from=2025-01-01&to=2025-03-01`);
    expect(tooLong.status).toBe(400);
    // With a user, the user's index serves it: every event kept.
    const withUser = await request(key, "GET", `/v2/admin/apps/${appId}/auth-events?outcome=attest_failed&user=u1`);
    expect(withUser.body.events.map((row: any) => row.id)).toEqual(["ae_recent", "ae_old"]);
    // No filter at all: every event kept.
    const all = await request(key, "GET", `/v2/admin/apps/${appId}/auth-events`);
    expect(all.body.events.map((row: any) => row.id)).toEqual(["ae_recent", "ae_old"]);
  });
});

describe("refused requests", () => {
  it("page newest first, filtered by reason, scope, user or days", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    await rejection({ appId, at: at("2025-06-03"), id: "re_c", reason: "blocked_app_budget", scope: "user", user: "u1" });
    await rejection({ appId, at: at("2025-06-02"), id: "re_b", reason: "model_not_allowed", user: "u2" });
    await rejection({ appId, at: at("2025-06-01"), id: "re_a", reason: "blocked_app_budget", scope: "app", user: "u1" });

    const first = await request(key, "GET", `/v2/admin/apps/${appId}/rejection-events?limit=1`);
    expect(first.body.events).toEqual([
      expect.objectContaining({ id: "re_c", reason: "blocked_app_budget", scope: "user", provider_slug: "openai", model: "gpt-4o-mini" }),
    ]);
    const rest = await request(key, "GET", `/v2/admin/apps/${appId}/rejection-events?before=${encodeURIComponent(first.body.next_before)}`);
    expect(rest.body.events.map((row: any) => row.id)).toEqual(["re_b", "re_a"]);
    const byScope = await request(key, "GET", `/v2/admin/apps/${appId}/rejection-events?scope=app&from=2025-06-01&to=2025-06-30`);
    expect(byScope.body.events.map((row: any) => row.id)).toEqual(["re_a"]);
    const byReason = await request(key, "GET", `/v2/admin/apps/${appId}/rejection-events?reason=blocked_app_budget&user=u1`);
    expect(byReason.body.events.map((row: any) => row.id)).toEqual(["re_c", "re_a"]);
    const byDays = await request(key, "GET", `/v2/admin/apps/${appId}/rejection-events?from=2025-06-02&to=2025-06-02`);
    expect(byDays.body.events.map((row: any) => row.id)).toEqual(["re_b"]);
    expect((await request(key, "GET", `/v2/admin/apps/${appId}/rejection-events?scope=everyone`)).status).toBe(400);
  });
});

describe("summary", () => {
  it("sums attempts, failing networks, failed charges, refusals, the exchange rate and the waits for a claim over the window", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    const yesterday = daysAgo(1);
    await authEvent({ appId, at: yesterday, outcome: "ok", claimDelayMs: 1_000 });
    await authEvent({ appId, at: yesterday, outcome: "ok", claimDelayMs: 3_000 });
    await authEvent({ appId, at: yesterday, outcome: "ok", claimDelayMs: 9_000 });
    await authEvent({ appId, at: yesterday, outcome: "issuer_claims_missing", reason: "claims_missing", asn: 714, network: "Apple" });
    await authEvent({ appId, at: yesterday, event: "challenge", outcome: "client_recovered", asn: 714, network: "Apple" });
    await authEvent({ appId, at: yesterday, event: "register", outcome: "attest_failed", asn: null });
    // Outside a 7-day window.
    await authEvent({ appId, at: daysAgo(10), outcome: "attest_failed", asn: 13335, network: "Cloudflare" });
    await rejection({ appId, at: yesterday, reason: "blocked_user", scope: "user" });
    await env.DB.prepare(
      `INSERT INTO charge (id, kind, account_id, app_id, owner_type, owner_id, provider_type, operation, model, status, cost_nano,
         measured, price_source, measures_json, used_at, usage_day, written_at)
       VALUES (?, 'attempt', ?, ?, 'call', ?, 'openai', 'openai.chat', 'gpt-4o-mini', 'provider_error', NULL, 'complete', 'list_rate', '{}', ?, ?, ?)`,
    )
      .bind(`ch_${crypto.randomUUID().slice(0, 8)}`, ACCOUNT_ID, appId, `call_${crypto.randomUUID().slice(0, 8)}`, yesterday, dayOf(yesterday), yesterday)
      .run();
    // Two users wait on a claim; a blocked one does not count.
    await env.DB.prepare(
      `INSERT INTO app_end_user (app_id, id, status, created_at, claim_pending_since) VALUES
         (?1, 'w1', 'active', 0, 1), (?1, 'w2', 'active', 0, 1), (?1, 'w3', 'blocked', 0, 1), (?1, 'w4', 'active', 0, NULL)`,
    )
      .bind(appId)
      .run();

    const { status, body } = await request(key, "GET", `/v2/admin/apps/${appId}/auth-events/summary?days=7`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ app_id: appId, days: 7, from: dayOf(daysAgo(6)), to: dayOf(daysAgo(0)), pending_users: 2 });
    expect(body.daily).toEqual(
      expect.arrayContaining([
        { date: dayOf(yesterday), event: "token_exchange", outcome: "ok", reason: null, count: 3 },
        { date: dayOf(yesterday), event: "token_exchange", outcome: "issuer_claims_missing", reason: "claims_missing", count: 1 },
      ]),
    );
    expect(body.daily.reduce((sum: number, row: any) => sum + row.count, 0)).toBe(6);
    // The recovered challenge and the unknown network are left out; the old failure is outside the window.
    expect(body.failing_networks).toEqual([{ network_asn: 714, network_name: "Apple", count: 1, last_seen: new Date(yesterday).toISOString() }]);
    expect(body.failed_charges).toEqual([{ date: dayOf(yesterday), count: 1 }]);
    expect(body.rejection_samples).toEqual([{ date: dayOf(yesterday), reason: "blocked_user", scope: "user", count: 1 }]);
    expect(body.token_exchange).toEqual({ total: 4, ok: 3, success_rate: 0.75 });
    expect(body.claim_delay).toEqual({ count: 3, avg_ms: 4_333, p50_ms: 3_000, p95_ms: 9_000 });
  });

  it("has no exchange rate for a window nobody signed in, and refuses a window longer than events are kept", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    const empty = await request(key, "GET", `/v2/admin/apps/${appId}/auth-events/summary`);
    expect(empty.body).toMatchObject({
      days: 30,
      daily: [],
      token_exchange: { total: 0, ok: 0, success_rate: null },
      claim_delay: { count: 0, avg_ms: null, p50_ms: null, p95_ms: null },
      pending_users: 0,
    });
    expect((await request(key, "GET", `/v2/admin/apps/${appId}/auth-events/summary?days=91`)).status).toBe(400);
  });
});

describe("isolation", () => {
  it("answers 404 for another account's app, and never pages into it with a position from one's own", async () => {
    const key = await seedManagementKey();
    const mine = await createApp(key);
    await authEvent({ appId: mine, at: at("2025-07-02"), id: "ae_mine_2" });
    await authEvent({ appId: mine, at: at("2025-07-01"), id: "ae_mine_1" });
    const foreign = await foreignApp();
    await authEvent({ appId: foreign, at: at("2025-06-30"), id: "ae_theirs" });
    await rejection({ appId: foreign, at: at("2025-06-30") });
    for (const path of ["auth-events", "auth-events/summary", "rejection-events"]) {
      expect((await request(key, "GET", `/v2/admin/apps/${foreign}/${path}`)).status, path).toBe(404);
    }
    const first = await request(key, "GET", `/v2/admin/apps/${mine}/auth-events?limit=1`);
    const before = encodeURIComponent(first.body.next_before);
    expect((await request(key, "GET", `/v2/admin/apps/${foreign}/auth-events?before=${before}`)).status).toBe(404);
    const next = await request(key, "GET", `/v2/admin/apps/${mine}/auth-events?before=${before}`);
    expect(next.body.events.map((row: any) => row.id)).toEqual(["ae_mine_1"]);
    expect((await request(key, "GET", `/v2/admin/apps/${mine}/auth-events?before=garbage`)).status).toBe(400);
  });

  it("deletes an app's events with the app, as v1, so an id that comes back starts with none", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    await authEvent({ appId, at: at("2025-07-01") });
    await rejection({ appId, at: at("2025-07-01") });
    expect((await request(key, "DELETE", `/v2/admin/apps/${appId}?confirm=${appId}`)).status).toBe(200);
    const left = await env.DB.batch([
      env.DB.prepare("SELECT COUNT(*) AS n FROM app_auth_event WHERE app_id = ?").bind(appId),
      env.DB.prepare("SELECT COUNT(*) AS n FROM app_rejection_event WHERE app_id = ?").bind(appId),
    ]);
    expect(left.map((result) => (result.results[0] as { n: number }).n)).toEqual([0, 0]);
  });
});

describe("query plans", () => {
  /** The plan of the first query a request sends to `table`, with its real parameters. */
  async function planOf(table: string, send: () => Promise<unknown>): Promise<string> {
    const prepare = env.DB.prepare.bind(env.DB);
    let sent: { sql: string; params: unknown[] } | undefined;
    const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (sent !== undefined || !new RegExp(`\\bFROM ${table}\\b`, "u").test(sql)) return statement;
      const bind = statement.bind.bind(statement);
      return Object.assign(statement, {
        bind: (...params: unknown[]) => {
          sent ??= { sql, params };
          return bind(...params);
        },
      });
    });
    try {
      await send();
    } finally {
      spy.mockRestore();
    }
    expect(sent, `no query to ${table} was sent`).toBeDefined();
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sent!.sql}`).bind(...sent!.params).all<{ detail: string }>();
    return results.map((row) => row.detail).join("\n");
  }

  it("read each list, a deep page, a user and the summary through their indexes", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    await authEvent({ appId, at: at("2025-08-02"), user: "u1" });
    await rejection({ appId, at: at("2025-08-02"), user: "u1" });
    const get = (path: string) => () => request(key, "GET", `/v2/admin/apps/${appId}/${path}`);
    expect(await planOf("app_auth_event", get("auth-events?limit=1"))).toContain("app_auth_event_app_created");
    const deep = await planOf("app_auth_event", get(`auth-events?before=${encodeURIComponent(`${at("2025-08-02")}.zzz`)}`));
    expect(deep).toContain("app_auth_event_app_created");
    expect(await planOf("app_auth_event", get("auth-events?user=u1"))).toContain("app_auth_event_app_user_created");
    expect(await planOf("app_rejection_event", get("rejection-events"))).toContain("app_rejection_event_app_created");
    expect(await planOf("app_rejection_event", get("rejection-events?user=u1"))).toContain("app_rejection_event_app_user_created");
    expect(await planOf("app_auth_event", get("auth-events/summary"))).toContain("app_auth_event_app_created");
    expect(await planOf("app_end_user", get("auth-events/summary"))).toContain("app_end_user_claim_pending");
  });
});

describe("tools", () => {
  it("read the summary, the attempts and the refusals as the CLI calls them", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    await authEvent({ appId, at: daysAgo(1), outcome: "ok" });
    await rejection({ appId, at: daysAgo(1) });
    const summary = await request(key, "POST", "/v2/cli/tools/get_auth_event_summary", { app: appId, days: 7 });
    expect(summary.status).toBe(200);
    expect(summary.body.summary).toBe(`1 sign-in attempt for ${appId} from ${dayOf(daysAgo(6))} to ${dayOf(daysAgo(0))}, 0 waiting on an entitlement claim.`);
    const events = await request(key, "POST", "/v2/cli/tools/list_auth_events", { app: appId });
    expect(events.body.result.events).toHaveLength(1);
    const refusals = await request(key, "POST", "/v2/cli/tools/list_rejection_events", { app: appId });
    expect(refusals.body.result.events).toHaveLength(1);
    expect(refusals.body.summary).toBe(`1 refusal sample for ${appId}.`);
  });
});

/**
 * Step 7b-4: reading an app's sign-in attempts, its refused requests and a
 * summary of both back through the management API and its tools. Every read
 * goes through an app the caller's account owns, and shows only events
 * recorded under that account. The clock is frozen, so day bounds are exact.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { recordAuthEvent } from "../src/client-auth/auth-events.ts";
import { appIds } from "../src/admin/apps.ts";
import { CLAIM_WAIT_TOTALS, claimWaitAt, FAILING_NETWORKS, PENDING_USERS } from "../src/admin/diagnostics.ts";
import { ACCOUNT_ID, clearCaches, LOAD_MANAGEMENT_TIMEOUT_MS, loadManagement, seedHuman, seedManagementKey } from "./helpers.ts";

beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

/** The frozen time every test runs at. */
const NOW = Date.parse("2026-11-20T15:00:00Z");

beforeEach(() => {
  clearCaches();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
    `INSERT INTO app_auth_event (id, app_id, account_id, user_id, event, auth_method, outcome, reason, network_asn, network_name, latency_ms, claim_delay_ms, created_at)
     VALUES (?1, ?2, (SELECT account_id FROM app WHERE id = ?2), ?3, ?4, 'api_key', ?5, ?6, ?7, ?8, 12, ?9, ?10)`,
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

async function rejection(values: {
  appId: string;
  at: number;
  id?: string;
  reason?: string;
  scope?: string | null;
  user?: string | null;
  model?: string;
}): Promise<string> {
  counter += 1;
  const id = values.id ?? `re_${String(counter).padStart(4, "0")}`;
  await env.DB.prepare(
    `INSERT INTO app_rejection_event (id, app_id, account_id, user_id, reason, scope, provider_slug, model, latency_ms, created_at)
     VALUES (?1, ?2, (SELECT account_id FROM app WHERE id = ?2), ?3, ?4, ?5, 'openai', ?6, 3, ?7)`,
  )
    .bind(id, values.appId, values.user ?? null, values.reason ?? "model_not_allowed", values.scope ?? null, values.model ?? "gpt-4o-mini", values.at)
    .run();
  return id;
}

const at = (day: string, ms = 0) => Date.parse(`${day}T12:00:00Z`) + ms;
/** Noon UTC, `days` days before the frozen today. */
const daysAgo = (days: number) => Date.parse("2026-11-20T12:00:00Z") - days * DAY;
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
    // `to` alone, on an indexed read, reads everything kept up to that day, as v1.
    const upTo = await request(key, "GET", `/v2/admin/apps/${appId}/auth-events?to=${dayOf(daysAgo(2))}`);
    expect(upTo.body.events.map((row: any) => row.id)).toEqual(["ae_old"]);
    const upToByUser = await request(key, "GET", `/v2/admin/apps/${appId}/auth-events?user=u1&to=${dayOf(daysAgo(1))}`);
    expect(upToByUser.body.events.map((row: any) => row.id)).toEqual(["ae_recent", "ae_old"]);
    // With an unindexed filter, `to` alone still reads only the 30 days before it.
    const upToFiltered = await request(key, "GET", `/v2/admin/apps/${appId}/auth-events?outcome=attest_failed&to=${dayOf(daysAgo(1))}`);
    expect(upToFiltered.body.events.map((row: any) => row.id)).toEqual(["ae_recent"]);
    expect((await request(key, "GET", `/v2/admin/apps/${appId}/auth-events?from=2026-11-10&to=2026-11-01`)).status).toBe(400);
  });
});

describe("page ends", () => {
  it("hand out a cursor only when an older row exists: none after exactly a full page (Sol 7b-6)", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    for (let index = 0; index < 25; index += 1) {
      await authEvent({ appId, at: at("2025-06-01", index) });
      await rejection({ appId, at: at("2025-06-01", index) });
    }
    for (const path of ["auth-events", "rejection-events"]) {
      const full = await request(key, "GET", `/v2/admin/apps/${appId}/${path}?limit=25`);
      expect(full.body.events).toHaveLength(25);
      expect(full.body.next_before).toBeNull();
    }
    await authEvent({ appId, at: at("2025-05-31") });
    await rejection({ appId, at: at("2025-05-31") });
    for (const path of ["auth-events", "rejection-events"]) {
      const first = await request(key, "GET", `/v2/admin/apps/${appId}/${path}?limit=25`);
      expect(first.body.events).toHaveLength(25);
      expect(first.body.next_before).not.toBeNull();
      const rest = await request(key, "GET", `/v2/admin/apps/${appId}/${path}?limit=25&before=${encodeURIComponent(first.body.next_before)}`);
      expect(rest.body.events).toHaveLength(1);
      expect(rest.body.next_before).toBeNull();
    }
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
         (?1, 'w1', 'active', 0, ?2), (?1, 'w2', 'active', 0, ?2), (?1, 'w3', 'blocked', 0, ?2), (?1, 'w4', 'active', 0, NULL)`,
    )
      .bind(appId, NOW - 86_400_000)
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
    // Apple's failures on their own: the recovered challenge is not one (Sol 7b-6).
    expect(body.apple_failures).toEqual({ count: 1, last_seen: new Date(yesterday).toISOString() });
  });

  it("counts Apple's failures on their own, so ten busier networks never hide them, and says null when there are none (Sol 7b-6)", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    const yesterday = daysAgo(1);
    for (let network = 0; network < 10; network += 1) {
      for (let attempt = 0; attempt < 3; attempt += 1) await authEvent({ appId, at: yesterday, outcome: "attest_failed", asn: 64_500 + network, network: `n${network}` });
    }
    const none = await request(key, "GET", `/v2/admin/apps/${appId}/auth-events/summary?days=7`);
    expect(none.body.apple_failures).toBeNull();
    await authEvent({ appId, at: yesterday, outcome: "attest_failed", asn: 714, network: "Apple" });
    const { body } = await request(key, "GET", `/v2/admin/apps/${appId}/auth-events/summary?days=7`);
    expect(body.failing_networks.map((row: any) => row.network_asn)).not.toContain(714);
    expect(body.apple_failures).toEqual({ count: 1, last_seen: new Date(yesterday).toISOString() });
  });

  it("names at most the ten networks most failures came from, counted in SQL (Gemini Neon 7b-4)", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    const yesterday = daysAgo(1);
    // Twelve networks; network 100 + n failed n + 1 times, and one more success there that does not count.
    for (let n = 0; n < 12; n += 1) {
      for (let i = 0; i <= n; i += 1) await authEvent({ appId, at: yesterday, outcome: "attest_failed", asn: 100 + n, network: `Net ${n}` });
      await authEvent({ appId, at: yesterday, outcome: "ok", asn: 100 + n, network: `Net ${n}` });
    }
    const { body } = await request(key, "GET", `/v2/admin/apps/${appId}/auth-events/summary?days=7`);
    expect(body.failing_networks.map((row: any) => [row.network_asn, row.count])).toEqual(
      Array.from({ length: 10 }, (_, i) => [111 - i, 12 - i]),
    );
    // The daily rows are one per day, event, outcome and reason, whatever the networks.
    expect(body.daily).toEqual([
      { date: dayOf(yesterday), event: "token_exchange", outcome: "attest_failed", reason: null, count: 78 },
      { date: dayOf(yesterday), event: "token_exchange", outcome: "ok", reason: null, count: 12 },
    ]);
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

describe("claim waits", () => {
  async function setup() {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    /** One attempt at `time`. A sign-in first marks the user seen, as the real sign-in does before it answers. */
    const attempt = async (time: number, userId: string, outcome: "ok" | "issuer_claims_missing") => {
      vi.setSystemTime(time);
      if (outcome === "ok") {
        await env.DB.prepare(
          "INSERT INTO app_end_user (app_id, id, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?3) ON CONFLICT (app_id, id) DO UPDATE SET last_seen_at = ?3",
        )
          .bind(appId, userId, time)
          .run();
      }
      await recordAuthEvent({ env, appId, accountId: ACCOUNT_ID, event: "token_exchange", userId, outcome, latencyMs: 1 });
    };
    const since = async (userId: string) =>
      (await env.DB.prepare("SELECT claim_pending_since AS since FROM app_end_user WHERE app_id = ? AND id = ?").bind(appId, userId).first<{ since: number | null }>())
        ?.since ?? null;
    const delays = async (userId: string) =>
      (
        await env.DB.prepare("SELECT claim_delay_ms AS ms FROM app_auth_event WHERE app_id = ? AND user_id = ? AND outcome = 'ok' ORDER BY created_at")
          .bind(appId, userId)
          .all<{ ms: number | null }>()
      ).results.map((row) => row.ms);
    return { key, appId, attempt, since, delays };
  }
  const T0 = NOW - 60_000;

  it("a refusal opens a wait, a repeated one keeps the first start, and the sign-in measures and closes it", async () => {
    const { key, appId, attempt, since, delays } = await setup();
    await attempt(T0, "u1", "issuer_claims_missing");
    await attempt(T0 + 10_000, "u1", "issuer_claims_missing");
    expect(await since("u1")).toBe(T0);
    await attempt(T0 + 30_000, "u1", "ok");
    expect(await delays("u1")).toEqual([30_000]);
    expect(await since("u1")).toBeNull();
    vi.setSystemTime(NOW);
    const summary = await request(key, "GET", `/v2/admin/apps/${appId}/auth-events/summary?days=1`);
    expect(summary.body.claim_delay).toMatchObject({ count: 1, p50_ms: 30_000, p95_ms: 30_000 });
    expect(summary.body.pending_users).toBe(0);
  });

  it("a refusal whose write lands after a later sign-in opens no wait", async () => {
    const { attempt, since, delays } = await setup();
    await attempt(T0 + 30_000, "u2", "ok");
    await attempt(T0 + 10_000, "u2", "issuer_claims_missing");
    expect(await since("u2")).toBeNull();
    expect(await delays("u2")).toEqual([null]);
    // A refusal after the sign-in is a new wait.
    await attempt(T0 + 40_000, "u2", "issuer_claims_missing");
    expect(await since("u2")).toBe(T0 + 40_000);
  });

  it("a wait older than the events' retention is never measured: a return 120 days on starts afresh (Gemini Neon 7b-4)", async () => {
    const { attempt, since, delays } = await setup();
    const later = T0 + 120 * DAY;
    // Refused once, gone for 120 days, then signed in at once: the old wait is closed, not measured.
    await attempt(T0, "u3", "issuer_claims_missing");
    await attempt(later, "u3", "ok");
    expect(await delays("u3")).toEqual([null]);
    expect(await since("u3")).toBeNull();
    // Refused once, gone for 120 days, then a real 2-second wait: that is what is measured.
    await attempt(T0, "u4", "issuer_claims_missing");
    await attempt(later, "u4", "issuer_claims_missing");
    expect(await since("u4")).toBe(later);
    await attempt(later + 2_000, "u4", "ok");
    expect(await delays("u4")).toEqual([2_000]);
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

  it("never gives a deleted app's id to a new app, so nothing recorded under it reaches a later app (Sol 7b-4 round 2)", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    // A sign-in under way when the app is deleted records its event afterwards, under the account it read.
    expect((await request(key, "DELETE", `/v2/admin/apps/${appId}?confirm=${appId}`)).status).toBe(200);
    await recordAuthEvent({ env, appId, accountId: ACCOUNT_ID, event: "token_exchange", userId: "late", outcome: "ok", latencyMs: 1 });
    expect(await env.DB.prepare("SELECT id FROM retired_app_id WHERE id = ?").bind(appId).first()).toEqual({ id: appId });
    // The id generator repeats the deleted id: the new app gets another one.
    const next = vi.spyOn(appIds, "next").mockReturnValueOnce(appId);
    const again = await createApp(key);
    expect(next).toHaveBeenCalledTimes(2);
    expect(again).not.toBe(appId);
    expect((await request(key, "GET", `/v2/admin/apps/${appId}/auth-events`)).status).toBe(404);
    expect((await request(key, "GET", `/v2/admin/apps/${again}/auth-events`)).body.events).toEqual([]);
    // A live app's id is never given out again either.
    vi.spyOn(appIds, "next").mockReturnValueOnce(again);
    expect(await createApp(key)).not.toBe(again);
  });

  it("a missing-claim refusal landing after its app was deleted leaves no user row (Fable 7b-4)", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    expect((await request(key, "DELETE", `/v2/admin/apps/${appId}?confirm=${appId}`)).status).toBe(200);
    await recordAuthEvent({ env, appId, accountId: ACCOUNT_ID, event: "token_exchange", userId: "gone", outcome: "issuer_claims_missing", latencyMs: 1 });
    expect(await env.DB.prepare("SELECT id FROM app_end_user WHERE app_id = ?").bind(appId).first()).toBeNull();
  });

  it("a success with no wait open writes no user row, and the users waiting count only waits from the last 90 days (Fable 7b-4)", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    await recordAuthEvent({ env, appId, accountId: ACCOUNT_ID, event: "token_exchange", userId: "fine", outcome: "ok", latencyMs: 1 });
    expect(await env.DB.prepare("SELECT id FROM app_end_user WHERE app_id = ? AND id = 'fine'").bind(appId).first()).toBeNull();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO app_end_user (app_id, id, created_at, claim_pending_since) VALUES (?, 'recent', ?, ?)").bind(appId, NOW, NOW - 86_400_000),
      env.DB.prepare("INSERT INTO app_end_user (app_id, id, created_at, claim_pending_since) VALUES (?, 'stale', ?, ?)").bind(appId, NOW, NOW - 91 * 86_400_000),
    ]);
    const summary = await request(key, "GET", `/v2/admin/apps/${appId}/auth-events/summary?days=7`);
    expect(summary.body.pending_users).toBe(1);
  });

  it("never shows a row recorded with no account (Sol 7b-4)", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    await env.DB.prepare(
      "INSERT INTO app_auth_event (id, app_id, account_id, event, outcome, latency_ms, created_at) VALUES (?, ?, NULL, 'token_exchange', 'ok', 1, ?)",
    )
      .bind(`ae_old_${crypto.randomUUID()}`, appId, at("2026-11-19"))
      .run();
    expect((await request(key, "GET", `/v2/admin/apps/${appId}/auth-events`)).body.events).toEqual([]);
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
    /** A list page: through `index`, in its order, with no sort of its own. */
    const listed = (plan: string, index: string) => {
      expect(plan).toContain(index);
      expect(plan).not.toContain("TEMP B-TREE");
    };
    listed(await planOf("app_auth_event", get("auth-events?limit=1")), "app_auth_event_app_account_created");
    listed(await planOf("app_auth_event", get(`auth-events?before=${encodeURIComponent(`${at("2025-08-02")}.zzz`)}`)), "app_auth_event_app_account_created");
    listed(await planOf("app_auth_event", get("auth-events?outcome=ok")), "app_auth_event_app_account_created");
    listed(await planOf("app_auth_event", get("auth-events?user=u1")), "app_auth_event_app_user_created");
    listed(await planOf("app_auth_event", get("auth-events?user=u1&outcome=ok&to=2025-08-02")), "app_auth_event_app_user_created");
    listed(await planOf("app_rejection_event", get("rejection-events")), "app_rejection_event_app_account_created");
    listed(await planOf("app_rejection_event", get("rejection-events?user=u1")), "app_rejection_event_app_user_created");
    expect(await planOf("app_auth_event", get("auth-events/summary"))).toContain("app_auth_event_app_account_created");
    expect(await planOf("app_end_user", get("auth-events/summary"))).toContain("app_end_user_claim_pending");
  });

  it("read every claim-wait figure from the covering index, with no sort and no table row, and the failing networks through the time index (Sol 7b-4 round 2, Gemini Neon 7b-4)", async () => {
    const key = await seedManagementKey();
    const appId = await createApp(key);
    await authEvent({ appId, at: at("2026-11-19"), claimDelayMs: 1_000 });
    for (const [name, sql] of [["totals", CLAIM_WAIT_TOTALS], ["p50", claimWaitAt(50)], ["p95", claimWaitAt(95)]] as const) {
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(appId, ACCOUNT_ID, at("2026-11-01"), at("2026-11-20"))
        .all<{ detail: string }>();
      const searches = results.map((row) => row.detail).filter((detail) => /^(SEARCH|SCAN)/u.test(detail));
      expect(searches.length, name).toBeGreaterThan(0);
      // Every read of the table, the inner count's included, is the covering index.
      for (const detail of searches) expect(detail, name).toContain("COVERING INDEX app_auth_event_claim_delay");
      expect(results.map((row) => row.detail).join("\n"), name).not.toContain("TEMP B-TREE");
    }
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${PENDING_USERS}`).bind(appId, 0).all<{ detail: string }>();
    const searches = results.map((row) => row.detail).filter((detail) => /^(SEARCH|SCAN)/u.test(detail));
    expect(searches).toEqual([expect.stringContaining("COVERING INDEX app_end_user_claim_pending")]);
    // The failing networks: the window through the app's time index, never a scan of the table.
    // Its two sorts (the grouping, and the order by count) are over the grouped networks
    // only, never the events: an order by an aggregate always needs one.
    const networks = await env.DB.prepare(`EXPLAIN QUERY PLAN ${FAILING_NETWORKS}`)
      .bind(appId, ACCOUNT_ID, at("2026-11-01"), at("2026-11-20"))
      .all<{ detail: string }>();
    const reads = networks.results.map((row) => row.detail).filter((detail) => /^(SEARCH|SCAN)/u.test(detail));
    expect(reads).toEqual([expect.stringContaining("app_auth_event_app_account_created")]);
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

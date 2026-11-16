import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { seedApp } from "./helpers";

const ORIGIN = "https://example.test";
const AUTH = { authorization: "Bearer agw_mgmt_test-admin-secret" };

async function get(path: string) {
  const response = await exports.default.fetch(`${ORIGIN}${path}`, { headers: AUTH });
  return { status: response.status, body: (await response.json()) as any };
}

/** `datetime('now')`'s own format, so day bucketing compares the way SQL does. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
}

async function recordAuth(
  appId: string,
  overrides: Partial<{
    userId: string | null;
    event: string;
    outcome: string;
    reason: string | null;
    claimDelayMs: number | null;
    clientSdk: string | null;
    networkAsn: number | null;
    networkName: string | null;
    createdAt: string;
  }> = {},
) {
  const {
    userId = "user-1",
    event = "token_exchange",
    outcome = "ok",
    reason = null,
    claimDelayMs = null,
    clientSdk = null,
    networkAsn = null,
    networkName = null,
    createdAt = daysAgo(0),
  } = overrides;
  await env.DB.prepare(
    `INSERT INTO app_auth_event(
       event_id, app_id, user_id, event, auth_method, outcome, reason, claim_delay_ms, client_sdk,
       network_asn, network_name, latency_ms, created_at
     ) VALUES (lower(hex(randomblob(16))), ?, ?, ?, 'api_key', ?, ?, ?, ?, ?, ?, 5, ?)`,
  )
    .bind(appId, userId, event, outcome, reason, claimDelayMs, clientSdk, networkAsn, networkName, createdAt)
    .run();
}

async function recordRejection(
  appId: string,
  eventId: string,
  userId: string,
  reason: string,
  scope: string | null,
  createdAt = new Date().toISOString(),
) {
  await env.DB.prepare(
    `INSERT INTO app_rejection_event(event_id,app_id,user_id,reason,scope,
       provider_slug,model,route,endpoint_slug,auth_method,created_at)
     VALUES (?,?,?,?,?,'openai','gpt-test','openai/v1/responses','chat','api_key',?)`,
  ).bind(eventId, appId, userId, reason, scope, createdAt).run();
}

describe("application auth event summary", () => {
  it("reports outcomes, proxy failures, success rate, delays, and who is still waiting", async () => {
    await seedApp("auth-summary");
    await recordAuth("auth-summary");
    await recordAuth("auth-summary", { userId: "user-2" });
    await recordAuth("auth-summary", {
      userId: "user-3",
      outcome: "issuer_claims_missing",
      reason: "claims_missing",
    });
    await recordAuth("auth-summary", {
      outcome: "issuer_token_rejected",
      reason: "bad_signature",
      userId: null,
    });
    // Registration attempts share the table but are not exchanges, so they must
    // not move the exchange success rate.
    await recordAuth("auth-summary", { event: "register", outcome: "attest_failed", reason: null });
    // Three measured waits, so the percentiles have something to rank.
    for (const delay of [1_000, 5_000, 60_000]) {
      await recordAuth("auth-summary", { userId: "user-4", claimDelayMs: delay });
    }
    // Outside the window entirely.
    await recordAuth("auth-summary", { outcome: "issuer_token_rejected", createdAt: daysAgo(45) });

    await env.DB.prepare(
      `INSERT INTO app_usage_event(
         event_id, organization_id, app_id, user_id, provider_type, model, route, status, created_at
       ) VALUES (lower(hex(randomblob(16))), 'operator-test-organization', 'auth-summary', 'user-1', 'openai', 'gpt-5.6-sol', 'openai/v1/responses', ?, ?)`,
    ).bind("provider_error", daysAgo(0)).run();
    await env.DB.prepare(
      `INSERT INTO app_usage_event(
         event_id, organization_id, app_id, user_id, provider_type, model, route, status, created_at
       ) VALUES (lower(hex(randomblob(16))), 'operator-test-organization', 'auth-summary', 'user-1', 'openai', 'gpt-5.6-sol', 'openai/v1/responses', 'ok', ?)`,
    ).bind(daysAgo(0)).run();
    await recordRejection("auth-summary", "auth-summary-reject", "user-1", "blocked_user", "user");

    await env.DB.prepare(
      "INSERT INTO app_user(app_id, id, status, claim_pending_since) VALUES (?, ?, 'active', ?)",
    ).bind("auth-summary", "user-3", daysAgo(0)).run();
    await env.DB.prepare("INSERT INTO app_user(app_id, id, status) VALUES (?, ?, 'active')")
      .bind("auth-summary", "user-1")
      .run();

    const { status, body } = await get("/v1/admin/apps/auth-summary/auth-events/summary?days=30");
    expect(status).toBe(200);
    expect(body.app_id).toBe("auth-summary");
    expect(body.days).toBe(30);

    const outcomes = Object.fromEntries(
      body.daily.map((row: any) => [`${row.event}:${row.outcome}:${row.reason ?? ""}`, row.count]),
    );
    expect(outcomes).toMatchObject({
      "token_exchange:ok:": 5,
      "token_exchange:issuer_claims_missing:claims_missing": 1,
      "token_exchange:issuer_token_rejected:bad_signature": 1,
      "register:attest_failed:": 1,
    });

    // Only the failing proxied request appears, so the view is about what broke.
    expect(body.usage_failures).toEqual([
      { date: daysAgo(0).slice(0, 10), status: "provider_error", count: 1 },
    ]);
    expect(body.rejection_samples).toEqual([
      { date: daysAgo(0).slice(0, 10), reason: "blocked_user", scope: "user", count: 1 },
    ]);

    // Seven exchanges in the window, five of them fine. The registration and
    // the 45-day-old row are both excluded.
    expect(body.token_exchange).toEqual({ total: 7, ok: 5, success_rate: 5 / 7 });

    expect(body.claim_delay).toEqual({
      count: 3,
      avg_ms: 22_000,
      p50_ms: 5_000,
      p95_ms: 60_000,
    });

    expect(body.pending_users).toBe(1);
  });

  it("calls a window with no exchanges unrated rather than perfect", async () => {
    await seedApp("auth-summary-empty");
    const { status, body } = await get("/v1/admin/apps/auth-summary-empty/auth-events/summary");
    expect(status).toBe(200);
    expect(body.token_exchange).toEqual({ total: 0, ok: 0, success_rate: null });
    expect(body.claim_delay).toEqual({ count: 0, avg_ms: null, p50_ms: null, p95_ms: null });
    expect(body.daily).toEqual([]);
    expect(body.pending_users).toBe(0);
  });

  it("counts usage failures in both timestamp formats through the inclusive final day", async () => {
    const appId = "auth-summary-usage-day";
    await seedApp(appId);
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
      .toISOString().slice(0, 10);
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000)
      .toISOString().slice(0, 10);
    const insert = env.DB.prepare(
      `INSERT INTO app_usage_event(
         event_id, organization_id, app_id, user_id, provider_type, model, route, status, created_at
       ) VALUES (lower(hex(randomblob(16))), 'operator-test-organization', ?, 'user-1',
                 'openai', 'gpt-5.6-sol', 'openai/v1/responses', 'provider_error', ?)`,
    );
    for (const createdAt of [
      `${yesterday}T23:59:59.999Z`,
      `${today} 00:00:00`,
      `${today}T23:59:59.999Z`,
      `${tomorrow} 00:00:00`,
    ]) {
      await insert.bind(appId, createdAt).run();
    }

    const { status, body } = await get(`/v1/admin/apps/${appId}/auth-events/summary?days=1`);
    expect(status).toBe(200);
    expect(body.usage_failures).toEqual([
      { date: today, status: "provider_error", count: 2 },
    ]);
  });

  it("refuses a window it cannot bucket", async () => {
    await seedApp("auth-summary-bad-window");
    const { status, body } = await get(
      "/v1/admin/apps/auth-summary-bad-window/auth-events/summary?days=0",
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe("invalid_request");
  });

  it("lists raw attempts newest first, filtered by outcome", async () => {
    await seedApp("auth-events-list");
    await recordAuth("auth-events-list", { userId: "user-a", clientSdk: "app-ai-gateway-swift/1.7.0" });
    await recordAuth("auth-events-list", {
      userId: "user-b",
      outcome: "issuer_claims_missing",
      reason: "claims_missing",
    });

    const all = await get("/v1/admin/apps/auth-events-list/auth-events");
    expect(all.status).toBe(200);
    expect(all.body.events.map((row: any) => row.user_id)).toEqual(["user-b", "user-a"]);
    expect(all.body.events[0]).toMatchObject({
      event: "token_exchange",
      auth_method: "api_key",
      outcome: "issuer_claims_missing",
      reason: "claims_missing",
      claim_delay_ms: null,
      client_sdk: null,
    });
    expect(all.body.events[1]).toMatchObject({ client_sdk: "app-ai-gateway-swift/1.7.0" });

    const filtered = await get(
      "/v1/admin/apps/auth-events-list/auth-events?outcome=issuer_claims_missing",
    );
    expect(filtered.body.events.map((row: any) => row.user_id)).toEqual(["user-b"]);

    const rejected = await get("/v1/admin/apps/auth-events-list/auth-events?event=nonsense");
    expect(rejected.status).toBe(400);
  });

  it("names the network each attempt came from, and the networks failures came from", async () => {
    const appId = "auth-events-networks";
    await seedApp(appId);
    const apple = { networkAsn: 714, networkName: "Apple Inc." };
    const carrier = { networkAsn: 701, networkName: "Verizon Business" };
    await recordAuth(appId, { ...apple, event: "challenge", outcome: "abandoned", reason: "challenge_unused", userId: null, createdAt: daysAgo(2) });
    await recordAuth(appId, { ...apple, event: "challenge", outcome: "client_failed", reason: "attest_key:com.apple.devicecheck.error:3", userId: null, createdAt: daysAgo(1) });
    await recordAuth(appId, { ...carrier, event: "register", outcome: "attest_failed", userId: null });
    // Neither is a failure to look into: one succeeded, one recovered on its own.
    await recordAuth(appId, { ...carrier });
    await recordAuth(appId, { ...carrier, event: "challenge", outcome: "client_recovered", userId: null });
    // A failure whose network is unknown says nothing about where to look.
    await recordAuth(appId, { outcome: "attest_failed", userId: null });

    const summary = await get(`/v1/admin/apps/${appId}/auth-events/summary?days=7`);
    expect(summary.status).toBe(200);
    expect(summary.body.failing_networks).toEqual([
      { network_asn: 714, network_name: "Apple Inc.", count: 2, last_seen: daysAgo(1).slice(0, 10) + expect.any(String) },
      { network_asn: 701, network_name: "Verizon Business", count: 1, last_seen: expect.any(String) },
    ].map((row) => ({ ...row, last_seen: expect.any(String) })));
    expect(summary.body.daily.some((row: any) => row.event === "challenge" && row.outcome === "abandoned")).toBe(true);

    const challenges = await get(`/v1/admin/apps/${appId}/auth-events?event=challenge`);
    expect(challenges.status).toBe(200);
    expect(challenges.body.events.map((row: any) => row.outcome)).toEqual([
      "client_recovered",
      "client_failed",
      "abandoned",
    ]);
    expect(challenges.body.events[1]).toMatchObject({ network_asn: 714, network_name: "Apple Inc." });
  });

  it("pages and filters refusal samples, with independent date bounds", async () => {
    const appId = "rejection-list";
    await seedApp(appId);
    const old = new Date(Date.now() - 45 * 86_400_000).toISOString();
    await recordRejection(appId, "rejection-a", "user-a", "blocked_app_rate", "user", old);
    await recordRejection(appId, "rejection-b", "user-b", "blocked_app_budget", "app");
    await recordRejection(appId, "rejection-c", "user-a", "blocked_user", "user");
    const base = `/v1/admin/apps/${appId}/rejection-events`;
    const first = await get(`${base}?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.events.map((row: any) => row.user_id)).toEqual(["user-a", "user-b"]);
    expect(first.body.events[0]).toMatchObject({
      reason: "blocked_user", scope: "user", provider_slug: "openai", endpoint_slug: "chat",
    });
    const second = await get(`${base}?limit=2&before_id=${first.body.next_before_id}`);
    expect(second.body.events.map((row: any) => row.user_id)).toEqual(["user-a"]);
    expect((await get(`${base}?reason=blocked_app_budget&scope=app`)).body.events).toHaveLength(1);
    expect((await get(`${base}?user=user-a`)).body.events).toHaveLength(2);
    expect((await get(`${base}?to=${old.slice(0, 10)}`)).body.events).toHaveLength(1);
    expect((await get(`${base}?from=2099-01-01`)).body.events).toHaveLength(0);
    expect((await get(`${base}?from=2026-09-25&to=2026-09-24`)).status).toBe(400);
    expect((await get(`${base}?reason=unknown`)).status).toBe(400);
  });

  it("answers only for apps the caller's organization owns", async () => {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO mgmt_organization(id, name, created_by_user_id, created_at, updated_at)
       VALUES ('auth-events-other-org', 'Other', 'operator-test-owner', datetime('now'), datetime('now'))`,
    ).run();
    await seedApp("auth-events-foreign", { organizationId: "auth-events-other-org" });
    await recordAuth("auth-events-foreign");

    expect((await get("/v1/admin/apps/auth-events-foreign/auth-events/summary")).status).toBe(404);
    expect((await get("/v1/admin/apps/auth-events-foreign/auth-events")).status).toBe(404);
    expect((await get("/v1/admin/apps/auth-events-foreign/rejection-events")).status).toBe(404);
  });
});

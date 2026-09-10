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
    createdAt: string;
  }> = {},
) {
  const {
    userId = "user-1",
    event = "token_exchange",
    outcome = "ok",
    reason = null,
    claimDelayMs = null,
    createdAt = daysAgo(0),
  } = overrides;
  await env.DB.prepare(
    `INSERT INTO app_auth_event(
       app_id, user_id, event, auth_method, outcome, reason, claim_delay_ms, latency_ms, created_at
     ) VALUES (?, ?, ?, 'api_key', ?, ?, ?, 5, ?)`,
  )
    .bind(appId, userId, event, outcome, reason, claimDelayMs, createdAt)
    .run();
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
         app_id, user_id, provider_type, model, route, status, created_at
       ) VALUES ('auth-summary', 'user-1', 'openai', 'gpt-5.6-sol', 'openai/v1/responses', ?, ?)`,
    ).bind("provider_error", daysAgo(0)).run();
    await env.DB.prepare(
      `INSERT INTO app_usage_event(
         app_id, user_id, provider_type, model, route, status, created_at
       ) VALUES ('auth-summary', 'user-1', 'openai', 'gpt-5.6-sol', 'openai/v1/responses', 'ok', ?)`,
    ).bind(daysAgo(0)).run();

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
    await recordAuth("auth-events-list", { userId: "user-a" });
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
    });

    const filtered = await get(
      "/v1/admin/apps/auth-events-list/auth-events?outcome=issuer_claims_missing",
    );
    expect(filtered.body.events.map((row: any) => row.user_id)).toEqual(["user-b"]);

    const rejected = await get("/v1/admin/apps/auth-events-list/auth-events?event=nonsense");
    expect(rejected.status).toBe(400);
  });

  it("answers only for apps the caller's organization owns", async () => {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO console_organization(id, name, created_by_user_id, created_at, updated_at)
       VALUES ('auth-events-other-org', 'Other', 'operator-test-owner', datetime('now'), datetime('now'))`,
    ).run();
    await seedApp("auth-events-foreign", { organizationId: "auth-events-other-org" });
    await recordAuth("auth-events-foreign");

    expect((await get("/v1/admin/apps/auth-events-foreign/auth-events/summary")).status).toBe(404);
    expect((await get("/v1/admin/apps/auth-events-foreign/auth-events")).status).toBe(404);
  });
});

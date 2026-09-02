import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearApiKeyCache } from "../src/core/apikeys";
import { clearAppConfigCache } from "../src/core/config";
import { clearJwksCache } from "../src/core/issuer";
import { pruneAuthEvents, recordAuthEvent } from "../src/core/auth-events";
import app from "../src/index";
import { seedServerApp } from "./helpers";

interface AuthEventRow {
  event_id: string | null;
  app_id: string;
  user_id: string | null;
  event: string;
  auth_method: string | null;
  outcome: string;
  reason: string | null;
  app_version: string | null;
  latency_ms: number | null;
  claim_delay_ms: number | null;
}

async function eventsFor(appId: string): Promise<AuthEventRow[]> {
  const rows = await env.DB
    .prepare("SELECT * FROM app_auth_event WHERE app_id = ? ORDER BY id")
    .bind(appId)
    .all<AuthEventRow>();
  return rows.results;
}

async function pendingSince(appId: string, userId: string): Promise<string | null> {
  const row = await env.DB
    .prepare("SELECT claim_pending_since FROM app_user WHERE app_id = ? AND id = ?")
    .bind(appId, userId)
    .first<{ claim_pending_since: string | null }>();
  return row?.claim_pending_since ?? null;
}

function withDatabase(database: D1Database): Env {
  return { ...env, DB: database };
}

/** A D1 binding whose statements fail before touching the real database. */
function brokenDatabase(): D1Database {
  return {
    prepare() {
      throw new Error("D1 is unavailable");
    },
  } as unknown as D1Database;
}

/**
 * A D1 binding that behaves normally except for `UPDATE app_user`, which is the
 * one statement closing a claim window issues — so a settle failure can be
 * staged without disturbing the authentication around it.
 */
function failingUpdateDatabase(): D1Database {
  return {
    prepare: (query: string) => {
      if (query.includes("update \"app_user\"") || query.includes("UPDATE app_user")) {
        throw new Error("D1 is unavailable");
      }
      return env.DB.prepare(query);
    },
    batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
  } as unknown as D1Database;
}

/**
 * A D1 binding that runs the first `losses` statements for real and *then*
 * reports failure — the ambiguous case retries exist for, where the row landed
 * but the caller never found out.
 */
function lossyDatabase(losses: number): D1Database {
  let lost = 0;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({
    ...statement,
    bind: (...values: unknown[]) => wrap(statement.bind(...values)),
    run: async () => {
      const result = await statement.run();
      if (lost < losses) {
        lost += 1;
        throw new Error("D1 acknowledgement was lost");
      }
      return result;
    },
    all: async () => {
      const result = await statement.all();
      if (lost < losses) {
        lost += 1;
        throw new Error("D1 acknowledgement was lost");
      }
      return result;
    },
  }) as unknown as D1PreparedStatement;
  return {
    prepare: (query: string) => wrap(env.DB.prepare(query)),
    batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
  } as unknown as D1Database;
}

interface SigningFixture {
  publicJwk: JWK;
  privateKey: CryptoKey;
  kid: string;
}

async function signingFixture(kid: string): Promise<SigningFixture> {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  return { publicJwk, privateKey: pair.privateKey, kid };
}

async function issuerToken(
  fixture: SigningFixture,
  claims: Record<string, unknown> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: fixture.kid })
    .setSubject(typeof claims.sub === "string" ? claims.sub : "claim-user")
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(fixture.privateKey);
}

/** One token exchange, with the recording `waitUntil` settled before returning. */
async function exchange(
  appId: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request(`https://example.test/v1/apps/${appId}/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await response.clone().arrayBuffer();
  await waitOnExecutionContext(ctx);
  return response;
}

beforeEach(() => {
  clearApiKeyCache();
  clearJwksCache();
  clearAppConfigCache();
});

afterEach(() => vi.restoreAllMocks());

describe("auth event recording", () => {
  it("records the attempt and never fails the request that made it", async () => {
    await recordAuthEvent({
      env,
      appId: "record-direct",
      event: "token_exchange",
      userId: "user-1",
      authMethod: "api_key",
      outcome: "ok",
      appVersion: "1.2.3",
      latencyMs: 12,
    });

    const [row] = await eventsFor("record-direct");
    expect(row).toMatchObject({
      user_id: "user-1",
      event: "token_exchange",
      auth_method: "api_key",
      outcome: "ok",
      reason: null,
      app_version: "1.2.3",
      latency_ms: 12,
      claim_delay_ms: null,
    });
    expect(row!.event_id).toBeTruthy();
  });

  it("converges rather than duplicating when an acknowledgement is lost", async () => {
    // The row landed; only the answer went missing. A retry re-inserts the same
    // event_id, which the unique index turns into a no-op.
    await recordAuthEvent({
      env: withDatabase(lossyDatabase(1)),
      appId: "record-replay",
      event: "token_exchange",
      outcome: "issuer_token_rejected",
      reason: "bad_signature",
      latencyMs: 3,
    });

    const rows = await eventsFor("record-replay");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ outcome: "issuer_token_rejected", reason: "bad_signature" });
  });

  it("abandons a hopeless recording under its own code instead of throwing", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((value: unknown) => {
      if (typeof value === "string") errors.push(value);
    });

    await expect(
      recordAuthEvent({
        env: withDatabase(brokenDatabase()),
        appId: "record-broken",
        event: "register",
        outcome: "ok",
        latencyMs: 1,
      }),
    ).resolves.toBeUndefined();

    expect(errors.some((line) => line.includes("auth_event_record_failed"))).toBe(true);
    expect(await eventsFor("record-broken")).toEqual([]);
  });
});

describe("token exchange events", () => {
  it("records a success with the verified identity and the client version", async () => {
    const fixture = await signingFixture("event-success");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));
    const key = await seedServerApp("event-success", { issuer: {} });

    const response = await exchange(
      "event-success",
      { api_key: key, issuer_token: await issuerToken(fixture, { sub: "happy-user" }) },
      { "x-app-version": "2.0.0" },
    );

    expect(response.status).toBe(200);
    const rows = await eventsFor("event-success");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      user_id: "happy-user",
      event: "token_exchange",
      auth_method: "api_key",
      outcome: "ok",
      reason: null,
      app_version: "2.0.0",
      claim_delay_ms: null,
    });
    expect(rows[0]!.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("records each failure class with the cause that produced it", async () => {
    const fixture = await signingFixture("event-failures");
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("issuer.test")) return Promise.resolve(Response.json({ keys: [fixture.publicJwk] }));
      return Promise.reject(new Error("unexpected fetch"));
    });
    const key = await seedServerApp("event-failures", { issuer: {} });

    const rejected = await exchange("event-failures", { api_key: key, issuer_token: "not-a-jwt" });
    expect(rejected.status).toBe(403);

    const badKey = await exchange("event-failures", {
      api_key: "agw_not-a-real-key-at-all-padded-to-look-plausible",
      issuer_token: await issuerToken(fixture),
    });
    expect(badKey.status).toBe(403);

    expect((await eventsFor("event-failures")).map((row) => ({
      outcome: row.outcome,
      reason: row.reason,
      user_id: row.user_id,
    }))).toEqual([
      { outcome: "issuer_token_rejected", reason: "bad_signature", user_id: null },
      // Refused before the issuer token was ever looked at, so no identity.
      { outcome: "auth_required", reason: null, user_id: null },
    ]);
  });

  it("does not record the challenge endpoint, which decides nothing", async () => {
    await seedServerApp("event-challenge", { issuer: {} });
    const ctx = createExecutionContext();
    // An API-key app has no App Attest, so this is refused — and still records
    // nothing, because challenge issuance is not an authentication decision.
    await app.fetch(
      new Request("https://example.test/v1/apps/event-challenge/auth/challenge", { method: "POST" }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(await eventsFor("event-challenge")).toEqual([]);
  });
});

describe("claim propagation delay", () => {
  const CLAIMS = { required_claims: [{ path: "entitlements", contains: "pro" }] };

  it("opens the window on the first rejection and keeps it open on the next", async () => {
    const fixture = await signingFixture("claim-window");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));
    const key = await seedServerApp("claim-window", { issuer: CLAIMS });
    const body = async () => ({
      api_key: key,
      issuer_token: await issuerToken(fixture, { sub: "waiting-user" }),
    });

    const first = await exchange("claim-window", await body());
    expect(first.status).toBe(403);
    await expect(first.json()).resolves.toMatchObject({
      error: { code: "issuer_claims_missing" },
    });

    const opened = await pendingSince("claim-window", "waiting-user");
    expect(opened).toBeTruthy();
    // The row is created for a user the gateway had never seen: the purchase is
    // often the first thing they do.
    expect((await eventsFor("claim-window"))[0]).toMatchObject({
      outcome: "issuer_claims_missing",
      reason: "claims_missing",
      user_id: "waiting-user",
    });

    // Backdate it, then reject again: the metric is the wait since the *first*
    // refusal, so a client retrying must not keep resetting it to zero.
    await env.DB
      .prepare("UPDATE app_user SET claim_pending_since = ? WHERE app_id = ? AND id = ?")
      .bind("2026-01-01 00:00:00", "claim-window", "waiting-user")
      .run();
    expect((await exchange("claim-window", await body())).status).toBe(403);
    expect(await pendingSince("claim-window", "waiting-user")).toBe("2026-01-01 00:00:00");
    expect((await eventsFor("claim-window")).length).toBe(2);
  });

  it("measures the wait on the exchange that ends it, then closes the window", async () => {
    const fixture = await signingFixture("claim-recovered");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));
    const key = await seedServerApp("claim-recovered", { issuer: CLAIMS });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      if (typeof value === "string") logs.push(value);
    });

    expect((await exchange("claim-recovered", {
      api_key: key,
      issuer_token: await issuerToken(fixture, { sub: "recovering-user" }),
    })).status).toBe(403);

    const openedAt = new Date(Date.now() - 120_000).toISOString().slice(0, 19).replace("T", " ");
    await env.DB
      .prepare("UPDATE app_user SET claim_pending_since = ? WHERE app_id = ? AND id = ?")
      .bind(openedAt, "claim-recovered", "recovering-user")
      .run();

    const success = await exchange("claim-recovered", {
      api_key: key,
      issuer_token: await issuerToken(fixture, { sub: "recovering-user", entitlements: ["pro"] }),
    });
    expect(success.status).toBe(200);

    const rows = await eventsFor("claim-recovered");
    expect(rows.length).toBe(2);
    expect(rows[1]!.outcome).toBe("ok");
    // Roughly the two minutes the row was backdated by, not an exact figure —
    // the test's own wall time is inside it.
    expect(rows[1]!.claim_delay_ms).toBeGreaterThanOrEqual(120_000);
    expect(rows[1]!.claim_delay_ms).toBeLessThan(180_000);
    expect(await pendingSince("claim-recovered", "recovering-user")).toBeNull();
    expect(logs.some((line) => line.includes("claim_propagation_recovered"))).toBe(true);
  });

  it("still authenticates when closing the window fails", async () => {
    const fixture = await signingFixture("claim-settle-fails");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));
    const key = await seedServerApp("claim-settle-fails", { issuer: CLAIMS });
    await env.DB
      .prepare(
        `INSERT INTO app_user(app_id, id, status, claim_pending_since)
         VALUES (?, ?, 'active', datetime('now', '-2 minutes'))`,
      )
      .bind("claim-settle-fails", "settling-user")
      .run();
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((value: unknown) => {
      if (typeof value === "string") warnings.push(value);
    });

    // The token was minted and the user upserted; only the measurement's own
    // write fails. A completed authentication must not be turned into a 500.
    const ctx = createExecutionContext();
    const response = await app.fetch(
      new Request("https://example.test/v1/apps/claim-settle-fails/auth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: key,
          issuer_token: await issuerToken(fixture, {
            sub: "settling-user",
            entitlements: ["pro"],
          }),
        }),
      }),
      withDatabase(failingUpdateDatabase()),
      ctx,
    );
    await response.clone().arrayBuffer();
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ expires_in: 3600 });
    expect(warnings.some((line) => line.includes("claim_settle_failed"))).toBe(true);
    // No delay is claimed for a window that is still open, so the next
    // successful exchange is what finally measures and closes it.
    expect((await eventsFor("claim-settle-fails"))[0]).toMatchObject({
      outcome: "ok",
      claim_delay_ms: null,
    });
    expect(await pendingSince("claim-settle-fails", "settling-user")).toBeTruthy();
  });

  it("opens no window for a blocked user, whose wait could never end", async () => {
    const fixture = await signingFixture("claim-blocked");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));
    const key = await seedServerApp("claim-blocked", { issuer: CLAIMS });
    await env.DB
      .prepare("INSERT INTO app_user(app_id, id, status) VALUES (?, ?, 'blocked')")
      .bind("claim-blocked", "blocked-user")
      .run();

    const response = await exchange("claim-blocked", {
      api_key: key,
      issuer_token: await issuerToken(fixture, { sub: "blocked-user" }),
    });

    expect(response.status).toBe(403);
    // The refusal is still recorded — it happened — but nobody is told to wait
    // for an entitlement that would not unblock this user anyway.
    expect((await eventsFor("claim-blocked"))[0]).toMatchObject({
      outcome: "issuer_claims_missing",
      user_id: "blocked-user",
    });
    expect(await pendingSince("claim-blocked", "blocked-user")).toBeNull();
  });

  it("measures nothing for a success that was never waiting", async () => {
    const fixture = await signingFixture("claim-never-pending");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));
    const key = await seedServerApp("claim-never-pending", { issuer: CLAIMS });

    const response = await exchange("claim-never-pending", {
      api_key: key,
      issuer_token: await issuerToken(fixture, { sub: "prompt-user", entitlements: ["pro"] }),
    });

    expect(response.status).toBe(200);
    expect((await eventsFor("claim-never-pending"))[0]).toMatchObject({
      outcome: "ok",
      claim_delay_ms: null,
    });
  });
});

describe("auth event retention", () => {
  it("drops attempts past the window and leaves billing history alone", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO app_auth_event(app_id, event, outcome, created_at)
         VALUES ('prune-app', 'token_exchange', 'ok', datetime('now', '-91 days'))`,
      ),
      env.DB.prepare(
        `INSERT INTO app_auth_event(app_id, event, outcome, created_at)
         VALUES ('prune-app', 'token_exchange', 'ok', datetime('now', '-89 days'))`,
      ),
      env.DB.prepare(
        `INSERT INTO app_usage_event(
           app_id, user_id, provider_type, model, route, status, created_at
         ) VALUES ('prune-app', 'user-1', 'openai', 'gpt-5.6-sol', 'openai/v1/responses', 'ok',
                   datetime('now', '-400 days'))`,
      ),
    ]);

    const ctx = createExecutionContext();
    app.scheduled({ cron: "17 3 * * *", scheduledTime: Date.now() } as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);

    const kept = await eventsFor("prune-app");
    expect(kept.length).toBe(1);
    // Usage rows are accounting history and are never pruned, at any age.
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS total FROM app_usage_event WHERE app_id = 'prune-app'")
        .first<{ total: number }>(),
    ).resolves.toEqual({ total: 1 });
  });

  it("takes the retention window it is given, and reports what it took", async () => {
    await env.DB.prepare(
      `INSERT INTO app_auth_event(app_id, event, outcome, created_at)
       VALUES ('prune-window', 'register', 'ok', datetime('now', '-2 days'))`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO app_auth_event(app_id, event, outcome)
       VALUES ('prune-window', 'register', 'ok')`,
    ).run();

    // Counted across the deployment, not per app: it is one sweep.
    expect(await pruneAuthEvents(env, 1)).toBeGreaterThanOrEqual(1);
    expect((await eventsFor("prune-window")).length).toBe(1);
  });
});

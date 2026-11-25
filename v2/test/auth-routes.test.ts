import { env } from "cloudflare:workers";
import { LEDGER_CALL_DEADLINE_MS } from "../src/ledger/database.ts";
import { BACKGROUND_JOB_DEADLINE_MS, boundedJob } from "../src/core/background.ts";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import worker from "../src/index.ts";
import { assertionClientData, sha256 } from "../src/client-auth/app-assertion.ts";
import { drainExpiredChallenges, EXPIRED_CHALLENGES_SQL, recordAuthEvent, settleExpiredChallenges } from "../src/client-auth/auth-events.ts";
import { PROOF_HEADER } from "../src/client-auth/request-proof.ts";
import {
  ACCOUNT_ID,
  attestAuthentication,
  authEvents,
  clearCaches,
  registerTestInstall,
  seedApp,
  seedAppKey,
  signedProof,
  testAssertion,
  tokenForInstall,
  type TestInstall,
} from "./helpers.ts";

const ORIGIN = "https://gateway.test";

/** Sends a request through the Worker and waits for its background work, such as auth events. */
async function call(path: string, init: RequestInit & { address?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cf-connecting-ip", init.address ?? `198.51.100.${Math.floor(Math.random() * 250)}`);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const post = (path: string, body: unknown, init: RequestInit & { address?: string } = {}) =>
  call(path, { ...init, method: "POST", body: JSON.stringify(body) });

async function challengeFor(appId: string): Promise<string> {
  const response = await call(`/v2/apps/${appId}/auth/challenge`, { method: "POST" });
  expect(response.status).toBe(200);
  return ((await response.json()) as { challenge: string }).challenge;
}

/** The token exchange body a device sends for an install. */
async function exchangeBody(install: TestInstall, challenge: string, counter: number): Promise<Record<string, unknown>> {
  const assertion = await testAssertion({
    privateKey: install.privateKey,
    counter,
    clientDataHash: await sha256(assertionClientData(install.appId, challenge, install.keyId)),
  });
  return { key_id: install.keyId, challenge, assertion: assertion.toString("base64") };
}

beforeEach(() => clearCaches());
afterEach(() => vi.restoreAllMocks());

describe("POST /v2/apps/{app}/auth/challenge", () => {
  it("issues a five-minute challenge to an App Attest app", async () => {
    const appId = await seedApp(attestAuthentication());
    const response = await call(`/v2/apps/${appId}/auth/challenge`, { method: "POST" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ expires_in: 300, accepts_app_transaction: true });
    expect(body.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("refuses a server app, a disabled app and an unknown one", async () => {
    const server = await seedApp({ type: "api_key", end_user: { source: "none" } });
    expect(await (await call(`/v2/apps/${server}/auth/challenge`, { method: "POST" })).json()).toMatchObject({
      error: { code: "auth_method_not_supported" },
    });
    const disabled = await seedApp(attestAuthentication(), "disabled");
    expect((await call(`/v2/apps/${disabled}/auth/challenge`, { method: "POST" })).status).toBe(403);
    const missing = await call("/v2/apps/app_missing/auth/challenge", { method: "POST" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "app_not_found" } });
  });

  it("limits each app to 60 calls a minute per network address, and records nothing for a refused call", async () => {
    // The window follows the clock: pin it just after a minute starts, so the
    // 61 calls never straddle two windows on a slow run.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 10, 19, 10, 0, 1) });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const appId = await seedApp(attestAuthentication());
    const address = "203.0.113.77";
    // Sent together to stay fast; the limiter counts each one atomically.
    const statuses = await Promise.all(
      Array.from({ length: 60 }, async () => (await call(`/v2/apps/${appId}/auth/challenge`, { method: "POST", address })).status),
    );
    expect(statuses).toEqual(Array(60).fill(200));
    const refused = await call(`/v2/apps/${appId}/auth/challenge`, { method: "POST", address });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await refused.json()).toMatchObject({
      error: {
        code: "rate_limited",
        data: {
          scope: "app_auth_challenge",
          limit: 60,
          windowSeconds: 60,
          retryAfterSeconds: expect.any(Number),
          resetAt: expect.any(String),
        },
      },
    });
    // Another address is counted on its own.
    expect((await call(`/v2/apps/${appId}/auth/challenge`, { method: "POST", address: "203.0.113.78" })).status).toBe(200);
  });
});

describe("POST /v2/apps/{app}/auth/failure", () => {
  it("still writes a sign-in event, with no wait measured, when D1 cannot read the user's wait (step 8f)", async () => {
    const appId = await seedApp(attestAuthentication());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const prepare = env.DB.prepare.bind(env.DB);
    const flakyDb = new Proxy(env.DB, {
      get(target, property) {
        if (property !== "prepare") return Reflect.get(target, property)?.bind?.(target) ?? Reflect.get(target, property);
        return (sql: string) => {
          if (sql.startsWith("SELECT claim_pending_since")) throw new Error("D1 cannot read");
          return prepare(sql);
        };
      },
    });
    await recordAuthEvent({ env: { ...env, DB: flakyDb } as Env, appId, accountId: ACCOUNT_ID, event: "token_exchange", userId: "u-unread", outcome: "ok", latencyMs: 1 });
    expect(await authEvents(appId)).toEqual([expect.objectContaining({ user_id: "u-unread", outcome: "ok", claim_delay_ms: null })]);
  });

  it("counts every account's abandoned challenges once all their writes are in (step 8f)", async () => {
    const now = Date.now();
    const mine = await seedApp(attestAuthentication());
    // A second account, written directly: signing one up is slow.
    const other = `acc_two_${crypto.randomUUID().slice(0, 8)}`;
    const theirs = `theirs-${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO mgmt_organization (id, name, created_by_user_id, created_at, updated_at) VALUES (?, 'Two', 'usr_test', ?, ?)").bind(
        other,
        new Date(now).toISOString(),
        new Date(now).toISOString(),
      ),
      env.DB.prepare(
        "INSERT INTO app (id, account_id, name, config_json, revision, status, created_at, updated_at) VALUES (?, ?, 'Theirs', '{}', 1, 'active', 0, 0)",
      ).bind(theirs, other),
    ]);
    await env.DB.prepare("DELETE FROM app_auth_challenge").run();
    await env.DB.batch(
      [mine, mine, theirs].map((appId, index) =>
        env.DB.prepare("INSERT INTO app_auth_challenge (challenge, app_id, expires_at, attempted) VALUES (?, ?, ?, 0)").bind(`two-${index}`, appId, now - 1_000),
      ),
    );
    expect(await settleExpiredChallenges(env, env.DB, now)).toEqual({ abandoned: 3, deleted: 3, selected: 3 });
  });

  it("retries a sign-in event through a fresh ledger stub after one breaks (step 8f)", async () => {
    const appId = await seedApp(attestAuthentication());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let stubs = 0;
    // The first stub is broken for good; any later one reaches the real ledger.
    const flaky = {
      ...env,
      ACCOUNT_LEDGER: {
        idFromName: (name: string) => name,
        get: (name: string) => {
          stubs += 1;
          if (stubs === 1) return { query: () => Promise.reject(new Error("broken stub")) };
          return env.ACCOUNT_LEDGER.get(env.ACCOUNT_LEDGER.idFromName(name));
        },
      },
    } as unknown as Env;
    await recordAuthEvent({ env: flaky, appId, accountId: ACCOUNT_ID, event: "token_exchange", userId: "u-fresh", outcome: "ok", latencyMs: 1 });
    expect((await authEvents(appId)).map((event) => event.user_id)).toEqual(["u-fresh"]);
  });

  it("gives up the expired-challenge clean-up as one job inside the request's background time, with a warning (step 8f)", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Its D1 read never answers.
    const stalledDb = { prepare: () => ({ bind: () => ({ all: () => new Promise(() => undefined) }) }) } as unknown as D1Database;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // As `/auth/challenge` runs it, one challenge in a hundred.
    const job = boundedJob(settleExpiredChallenges(env, stalledDb), "settling expired challenges", "auth_challenges_prune_failed");
    await vi.advanceTimersByTimeAsync(BACKGROUND_JOB_DEADLINE_MS);
    vi.useRealTimers();
    expect(await job).toBeUndefined();
    expect(warned.mock.calls.some(([line]) => String(line).includes('"message":"auth_challenges_prune_failed"'))).toBe(true);
  });

  it("gives up a sign-in event whose D1 lookup never answers, inside the request's background time, with a warning (step 8f)", async () => {
    const appId = await seedApp(attestAuthentication());
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // A success reads the user's wait from D1 first; that read never answers.
    const stalledDb = { prepare: () => ({ bind: () => ({ first: () => new Promise(() => undefined), run: () => new Promise(() => undefined) }) }) };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const writing = recordAuthEvent({ env: { ...env, DB: stalledDb } as unknown as Env, appId, accountId: ACCOUNT_ID, event: "token_exchange", userId: "u-stalled", outcome: "ok", latencyMs: 1 });
    await vi.advanceTimersByTimeAsync(BACKGROUND_JOB_DEADLINE_MS);
    vi.useRealTimers();
    await writing;
    expect(warned.mock.calls.some(([line]) => String(line).includes('"message":"auth_event_record_failed"'))).toBe(true);
  });

  it("gives up an event write the ledger never answers, inside the request's background time, with a warning (step 8f)", async () => {
    const appId = await seedApp(attestAuthentication());
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stalled = { ...env, ACCOUNT_LEDGER: { idFromName: (name: string) => name, get: () => ({ query: () => new Promise(() => undefined) }) } } as unknown as Env;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const writing = recordAuthEvent({ env: stalled, appId, accountId: ACCOUNT_ID, event: "challenge", outcome: "client_failed", latencyMs: 1 });
    await vi.advanceTimersByTimeAsync(LEDGER_CALL_DEADLINE_MS);
    vi.useRealTimers();
    await writing;
    expect(warned.mock.calls.some(([line]) => String(line).includes('"message":"auth_event_record_failed"'))).toBe(true);
  });

  it("answers once the challenge is spent, and writes the event after the answer, so a stalled ledger never holds it (step 8f)", async () => {
    const appId = await seedApp(attestAuthentication());
    const challenge = await challengeFor(appId);
    const stalled = { ...env, ACCOUNT_LEDGER: { idFromName: (name: string) => name, get: () => ({ query: () => new Promise(() => undefined) }) } } as unknown as Env;
    const report = { challenge, step: "attest_key", error: { domain: "com.apple.devicecheck.error", code: 3 } };
    // The background work is never awaited: the stalled event write would never end.
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v2/apps/${appId}/auth/failure`, {
        method: "POST",
        body: JSON.stringify(report),
        headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.10" },
      }),
      stalled,
      createExecutionContext(),
    );
    expect(await response.json()).toEqual({ recorded: true });
  });

  it("records one report per challenge, as a challenge auth event", async () => {
    const appId = await seedApp(attestAuthentication());
    const challenge = await challengeFor(appId);
    const report = {
      challenge,
      step: "attest_key",
      error: { domain: "com.apple.devicecheck.error", code: 3 },
      underlying_error: { domain: "NSURLErrorDomain", code: -1001 },
    };
    expect(await (await post(`/v2/apps/${appId}/auth/failure`, report)).json()).toEqual({ recorded: true });
    expect(await (await post(`/v2/apps/${appId}/auth/failure`, report)).json()).toEqual({ recorded: false });
    const [event] = await authEvents(appId);
    expect(event).toMatchObject({
      event: "challenge",
      outcome: "client_failed",
      reason: "attest_key:com.apple.devicecheck.error:3>NSURLErrorDomain:-1001",
    });
  });

  it("records a recovery, and stores an odd error domain as other", async () => {
    const appId = await seedApp(attestAuthentication());
    const challenge = await challengeFor(appId);
    await post(`/v2/apps/${appId}/auth/failure`, {
      challenge,
      step: "register",
      error: { domain: "has spaces", code: 1 },
      recovered: true,
    });
    expect((await authEvents(appId))[0]).toMatchObject({ outcome: "client_recovered", reason: "register:other:1" });
  });
});

describe("POST /v2/apps/{app}/auth/register", () => {
  // The first registration in this file: it pays for the Worker's first load of App Attest's certificate code,
  // which can take seconds on a loaded machine. That cold load is part of what it covers, so it keeps it, with a
  // fair limit.
  it("refuses a forged attestation, spends the challenge, and records the refusal", { timeout: 30_000 }, async () => {
    const appId = await seedApp(attestAuthentication());
    const challenge = await challengeFor(appId);
    const body = { key_id: "a2V5", attestation: "bm90LWFuLWF0dGVzdGF0aW9u", challenge };
    const response = await post(`/v2/apps/${appId}/auth/register`, body);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "attest_failed" } });
    const again = await post(`/v2/apps/${appId}/auth/register`, body);
    expect(await again.json()).toMatchObject({ error: { code: "attest_failed", message: expect.stringMatching(/Challenge/) } });
    expect((await authEvents(appId)).map((event) => [event.event, event.outcome])).toEqual([
      ["register", "attest_failed"],
      ["register", "attest_failed"],
    ]);
  });

  it("refuses an issuer token from an app that identifies users by install", async () => {
    const appId = await seedApp(attestAuthentication());
    const challenge = await challengeFor(appId);
    const response = await post(`/v2/apps/${appId}/auth/register`, {
      key_id: "a2V5",
      attestation: "eA",
      challenge,
      issuer_token: "x",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
  });
});

describe("POST /v2/apps/{app}/auth/token with App Attest", () => {
  it("exchanges an assertion for a token that says requests are signed", async () => {
    const appId = await seedApp(attestAuthentication());
    const install = await registerTestInstall(appId);
    const response = await post(`/v2/apps/${appId}/auth/token`, await exchangeBody(install, await challengeFor(appId), 1));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ access_token: expect.any(String), expires_in: 3600, verify_on: "every_request" });
    expect((await authEvents(appId)).at(-1)).toMatchObject({
      event: "token_exchange",
      outcome: "ok",
      auth_method: "attest",
      user_id: install.keyId,
    });
  });

  it("refuses a replayed counter, a used challenge, and an assertion for another key", async () => {
    const appId = await seedApp(attestAuthentication());
    const install = await registerTestInstall(appId);
    const challenge = await challengeFor(appId);
    expect((await post(`/v2/apps/${appId}/auth/token`, await exchangeBody(install, challenge, 5))).status).toBe(200);
    const usedChallenge = await post(`/v2/apps/${appId}/auth/token`, await exchangeBody(install, challenge, 6));
    expect(await usedChallenge.json()).toMatchObject({ error: { code: "attest_failed", message: expect.stringMatching(/Challenge/) } });
    const replay = await post(`/v2/apps/${appId}/auth/token`, await exchangeBody(install, await challengeFor(appId), 5));
    expect(await replay.json()).toMatchObject({ error: { code: "attest_failed", message: expect.stringMatching(/replayed/) } });
    const other = await registerTestInstall(appId);
    const wrongKey = await exchangeBody(other, await challengeFor(appId), 1);
    const forged = await post(`/v2/apps/${appId}/auth/token`, { ...wrongKey, key_id: install.keyId });
    expect(forged.status).toBe(403);
  });

  it("refuses a blocked user, a key in an environment no longer allowed, and an app key in the body", async () => {
    const appId = await seedApp(attestAuthentication({ environments: ["production"] }));
    const blocked = await registerTestInstall(appId);
    await env.DB.prepare("INSERT INTO app_end_user(app_id, id, status, created_at) VALUES (?, ?, 'blocked', ?)")
      .bind(appId, blocked.userId, Date.now())
      .run();
    expect(await (await post(`/v2/apps/${appId}/auth/token`, await exchangeBody(blocked, await challengeFor(appId), 1))).json())
      .toMatchObject({ error: { code: "auth_required", message: "User is blocked" } });
    const development = await registerTestInstall(appId, { environment: "development" });
    expect(await (await post(`/v2/apps/${appId}/auth/token`, await exchangeBody(development, await challengeFor(appId), 1))).json())
      .toMatchObject({ error: { code: "attest_failed", message: expect.stringMatching(/environment/) } });
    expect(await (await post(`/v2/apps/${appId}/auth/token`, { api_key: "agw_x", issuer_token: "x" })).json()).toMatchObject({
      error: { code: "auth_method_not_supported" },
    });
  });
});

describe("POST /v2/apps/{app}/auth/token with an app key and an issuer", () => {
  async function issuerApp() {
    const pair = await generateKeyPair("RS256", { extractable: true });
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ keys: [jwk] }));
    const appId = await seedApp({
      type: "api_key",
      end_user: {
        source: "issuer",
        issuer: {
          jwks_url: `https://issuer.test/${crypto.randomUUID()}/jwks.json`,
          issuer: "https://issuer.test/",
          audience: "aud",
          user_id_claim: "sub",
          required_claims: [{ path: "entitlements", contains: "pro" }],
          max_token_lifetime_seconds: 3600,
        },
      },
    });
    const issuerToken = (claims: Record<string, unknown>) => {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer("https://issuer.test/")
        .setAudience("aud")
        .setSubject("person-1")
        .setIssuedAt(now)
        .setExpirationTime(now + 600)
        .sign(pair.privateKey);
    };
    return { appId, issuerToken };
  }

  it("gives a token for the issuer's user, which stops working when the app key is revoked", async () => {
    const { appId, issuerToken } = await issuerApp();
    const key = await seedAppKey(appId);
    const response = await post(`/v2/apps/${appId}/auth/token`, {
      api_key: key.key,
      issuer_token: await issuerToken({ entitlements: ["pro"] }),
    });
    expect(response.status).toBe(200);
    const { access_token: token, verify_on } = (await response.json()) as { access_token: string; verify_on?: string };
    expect(verify_on).toBeUndefined();
    const me = await call(`/v2/apps/${appId}/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(await me.json()).toEqual({ user_id: "person-1", install_id: null, limits: {
        requests_today: null,
        requests_remaining: null,
        requests_per_minute: null,
        requests_per_day: null,
        monthly_cost_usd: 0,
        monthly_budget_usd: null,
        budget_scope: "user",
        blocked: false,
      } });
    await env.DB.prepare("UPDATE app_key SET status = 'revoked' WHERE id = ?").bind(key.id).run();
    clearCaches();
    expect((await call(`/v2/apps/${appId}/me`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it("refuses a token missing the entitlement claim, and records who it refused", async () => {
    const { appId, issuerToken } = await issuerApp();
    const key = await seedAppKey(appId);
    const response = await post(`/v2/apps/${appId}/auth/token`, { api_key: key.key, issuer_token: await issuerToken({}) });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "issuer_claims_missing" } });
    expect((await authEvents(appId)).at(-1)).toMatchObject({
      outcome: "issuer_claims_missing",
      reason: "claims_missing",
      user_id: "person-1",
    });
  });

  it("measures how long a user waited for the entitlement claim, from the first refusal to the sign-in that ends it (step 7b-4)", async () => {
    // A frozen clock, moved by hand: each attempt is recorded at an exact time.
    const start = Date.parse("2026-11-20T15:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    try {
      const { appId, issuerToken } = await issuerApp();
      const key = await seedAppKey(appId);
      const pendingSince = () =>
        env.DB.prepare("SELECT claim_pending_since AS since FROM app_end_user WHERE app_id = ? AND id = 'person-1'").bind(appId).first<{ since: number | null }>();
      // Two refusals: only the first opens the wait.
      expect((await post(`/v2/apps/${appId}/auth/token`, { api_key: key.key, issuer_token: await issuerToken({}) })).status).toBe(403);
      expect((await pendingSince())?.since).toBe(start);
      vi.setSystemTime(start + 1_000);
      expect((await post(`/v2/apps/${appId}/auth/token`, { api_key: key.key, issuer_token: await issuerToken({}) })).status).toBe(403);
      expect((await pendingSince())?.since).toBe(start);
      // Five seconds after the first refusal, the sign-in that succeeds closes the wait and records it.
      vi.setSystemTime(start + 5_000);
      const ok = await post(`/v2/apps/${appId}/auth/token`, { api_key: key.key, issuer_token: await issuerToken({ entitlements: ["pro"] }) });
      expect(ok.status).toBe(200);
      expect((await pendingSince())?.since).toBeNull();
      expect((await authEvents(appId)).at(-1)).toMatchObject({ outcome: "ok", claim_delay_ms: 5_000 });
      // A later sign-in has no wait to close.
      vi.setSystemTime(start + 6_000);
      await post(`/v2/apps/${appId}/auth/token`, { api_key: key.key, issuer_token: await issuerToken({ entitlements: ["pro"] }) });
      expect(((await authEvents(appId)).at(-1) as { claim_delay_ms: number | null }).claim_delay_ms).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an app key of another app", async () => {
    const { appId, issuerToken } = await issuerApp();
    const otherApp = await seedApp({ type: "api_key", end_user: { source: "none" } });
    const otherKey = await seedAppKey(otherApp);
    const response = await post(`/v2/apps/${appId}/auth/token`, {
      api_key: otherKey.key,
      issuer_token: await issuerToken({ entitlements: "pro" }),
    });
    expect(await response.json()).toMatchObject({ error: { code: "auth_required" } });
  });
});

describe("GET /v2/apps/{app}/me", () => {
  it("answers without the month's spend when the account's ledger cannot give it, with a warning (step 8f)", async () => {
    const appId = await seedApp({ type: "api_key", end_user: { source: "header", header: "x-end-user-id" } });
    const key = await seedAppKey(appId);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const down = () => Promise.reject(new Error("ledger down"));
    const ledgerDown = { ...env, ACCOUNT_LEDGER: { idFromName: (name: string) => name, get: () => ({ query: down }) } } as unknown as Env;
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v2/apps/${appId}/me`, { headers: { authorization: `Bearer ${key.key}`, "x-end-user-id": "user-8", "cf-connecting-ip": "198.51.100.9" } }),
      ledgerDown,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { limits: { monthly_cost_usd: number | null } }).limits.monthly_cost_usd).toBeNull();
    expect(warned.mock.calls.some(([line]) => String(line).includes('"message":"budget_total_unread"'))).toBe(true);
  });

  it("names the user an app key and header give, and whether they are blocked", async () => {
    const appId = await seedApp({ type: "api_key", end_user: { source: "header", header: "x-end-user-id" } });
    const key = await seedAppKey(appId);
    const headers = { authorization: `Bearer ${key.key}`, "x-end-user-id": "user-7" };
    expect(await (await call(`/v2/apps/${appId}/me`, { headers })).json()).toEqual({
      user_id: "user-7",
      install_id: null,
      limits: {
      requests_today: null,
      requests_remaining: null,
      requests_per_minute: null,
      requests_per_day: null,
      monthly_cost_usd: 0,
      monthly_budget_usd: null,
      budget_scope: "user",
      blocked: false,
    },
    });
    await env.DB.prepare("INSERT INTO app_end_user(app_id, id, status, created_at) VALUES (?, 'user-7', 'blocked', ?)")
      .bind(appId, Date.now())
      .run();
    expect(await (await call(`/v2/apps/${appId}/me`, { headers })).json()).toMatchObject({ limits: { blocked: true } });
    expect((await call(`/v2/apps/${appId}/me`, { headers: { authorization: `Bearer ${key.key}` } })).status).toBe(400);
    expect((await call(`/v2/apps/${appId}/me`, { headers: { ...headers, authorization: "Bearer agw_wrong" } })).status).toBe(401);
  });

  it("answers 404 for an app that identifies no end users", async () => {
    const appId = await seedApp({ type: "api_key", end_user: { source: "none" } });
    const key = await seedAppKey(appId);
    const response = await call(`/v2/apps/${appId}/me`, { headers: { authorization: `Bearer ${key.key}` } });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "auth_method_not_supported" } });
  });

  it("needs a fresh proof over the /v2 path on every request of an App Attest app", async () => {
    const appId = await seedApp(attestAuthentication());
    const install = await registerTestInstall(appId);
    const token = await tokenForInstall(install);
    const url = `${ORIGIN}/v2/apps/${appId}/me`;
    const unsigned = await call(`/v2/apps/${appId}/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toMatchObject({ error: { code: "assertion_required" } });

    const proof = await signedProof({ install, token, method: "GET", url, counter: 1 });
    const signed = await call(`/v2/apps/${appId}/me`, { headers: { authorization: `Bearer ${token}`, [PROOF_HEADER]: proof } });
    expect(await signed.json()).toEqual({ user_id: install.keyId, install_id: install.keyId, limits: {
        requests_today: null,
        requests_remaining: null,
        requests_per_minute: null,
        requests_per_day: null,
        monthly_cost_usd: 0,
        monthly_budget_usd: null,
        budget_scope: "install",
        blocked: false,
      } });

    const replayed = await call(`/v2/apps/${appId}/me`, { headers: { authorization: `Bearer ${token}`, [PROOF_HEADER]: proof } });
    expect(replayed.status).toBe(403);
    expect(await replayed.json()).toMatchObject({ error: { code: "attest_failed", message: expect.stringMatching(/replayed/) } });

    // A proof signed over v1's path does not verify on v2.
    const v1Proof = await signedProof({ install, token, method: "GET", url: `${ORIGIN}/v1/apps/${appId}/me`, counter: 2 });
    const wrongPath = await call(`/v2/apps/${appId}/me`, { headers: { authorization: `Bearer ${token}`, [PROOF_HEADER]: v1Proof } });
    expect(await wrongPath.json()).toMatchObject({ error: { code: "attest_failed" } });
  });

  it("accepts the token alone when the app checks App Attest only at the exchange", async () => {
    const appId = await seedApp(attestAuthentication({ verify_on: "token_exchange" }));
    const install = await registerTestInstall(appId);
    const token = await tokenForInstall(install);
    expect((await call(`/v2/apps/${appId}/me`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  it("refuses a token of another app, and an App Attest token on a server app", async () => {
    const attestApp = await seedApp(attestAuthentication({ verify_on: "token_exchange" }));
    const token = await tokenForInstall(await registerTestInstall(attestApp));
    const otherAttestApp = await seedApp(attestAuthentication({ verify_on: "token_exchange" }));
    expect((await call(`/v2/apps/${otherAttestApp}/me`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    const serverApp = await seedApp({ type: "api_key", end_user: { source: "none" } });
    expect((await call(`/v2/apps/${serverApp}/me`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it("refuses requests to an app whose settings cannot be read", async () => {
    const appId = await seedApp({ type: "not_a_type" });
    const response = await call(`/v2/apps/${appId}/me`, { headers: { authorization: "Bearer agw_x" } });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
  });
});

describe("expired challenges", () => {
  it("records each unused one as abandoned once, and deletes them all", async () => {
    const appId = await seedApp(attestAuthentication());
    const now = Date.now();
    // Earlier tests in this file leave challenges behind, some made under a
    // fake clock fixed on 2026-11-19. Once the real clock passes their expiry
    // they would be counted here too, so start with none.
    await env.DB.prepare("DELETE FROM app_auth_challenge").run();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO app_auth_challenge(challenge, app_id, expires_at, attempted) VALUES ('old-unused', ?, ?, 0)").bind(appId, now - 1000),
      env.DB.prepare("INSERT INTO app_auth_challenge(challenge, app_id, expires_at, attempted) VALUES ('old-tried', ?, ?, 1)").bind(appId, now - 1000),
      env.DB.prepare("INSERT INTO app_auth_challenge(challenge, app_id, expires_at, attempted) VALUES ('fresh', ?, ?, 0)").bind(appId, now + 60_000),
    ]);
    expect(await settleExpiredChallenges(env, env.DB, now)).toEqual({ abandoned: 1, deleted: 2, selected: 2 });
    expect(await settleExpiredChallenges(env, env.DB, now)).toEqual({ abandoned: 0, deleted: 0, selected: 0 });
    const events = await authEvents(appId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "challenge:old-unused", outcome: "abandoned", created_at: now - 1000 - 300_000 });
  });

  it("copies a challenge's version only when it is shaped like one: a challenge written before the check may hold any text (Sol 7b-4 round 3)", async () => {
    const appId = await seedApp(attestAuthentication());
    const now = Date.now();
    await env.DB.prepare("DELETE FROM app_auth_challenge").run();
    await env.DB.batch(
      [
        ["free-text", "sk-proj-0123456789abcdef"],
        ["version", "1.2.3 (45)"],
        ["none", null],
      ].map(([challenge, version]) =>
        env.DB.prepare("INSERT INTO app_auth_challenge(challenge, app_id, expires_at, attempted, app_version) VALUES (?, ?, ?, 0, ?)").bind(
          challenge,
          appId,
          now - 1000,
          version,
        ),
      ),
    );
    expect(await settleExpiredChallenges(env, env.DB, now)).toEqual({ abandoned: 3, deleted: 3, selected: 3 });
    const versions = Object.fromEntries((await authEvents(appId)).map((event: any) => [event.id, event.app_version]));
    expect(versions).toEqual({ "challenge:free-text": null, "challenge:version": "1.2.3 (45)", "challenge:none": null });
  });

  it("settles a backlog a bounded batch at a time, oldest first, and says when one is left (Sol 7b-4 round 4)", async () => {
    const appId = await seedApp(attestAuthentication());
    const now = Date.now();
    await env.DB.prepare("DELETE FROM app_auth_challenge").run();
    await env.DB.batch(
      Array.from({ length: 5 }, (_, index) =>
        env.DB.prepare("INSERT INTO app_auth_challenge(challenge, app_id, expires_at, attempted, app_version) VALUES (?, ?, ?, ?, ?)").bind(
          `backlog-${index}`,
          appId,
          now - 10_000 + index,
          index === 1 ? 1 : 0,
          `1.0.${index}`,
        ),
      ),
    );
    const warned: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => void warned.push(String(line)));
    // A batch of 2 stands in for 1,000: the oldest two go first.
    expect(await settleExpiredChallenges(env, env.DB, now, 2)).toEqual({ abandoned: 1, deleted: 2, selected: 2 });
    const left = await env.DB.prepare("SELECT challenge FROM app_auth_challenge ORDER BY expires_at").all<{ challenge: string }>();
    expect(left.results.map((row) => row.challenge)).toEqual(["backlog-2", "backlog-3", "backlog-4"]);
    // The hourly drain goes on while batches come back full, up to its limit, and says a backlog is left.
    expect(await drainExpiredChallenges(env, env.DB, 1, now, 2)).toEqual({ abandoned: 2, deleted: 2, batches: 1 });
    expect(warned.filter((line) => line.includes('"message":"auth_challenges_backlog_left"'))).toHaveLength(1);
    // With room for more batches it clears the rest in one run, and stops at the first batch that is not full.
    expect(await drainExpiredChallenges(env, env.DB, 5, now, 2)).toEqual({ abandoned: 1, deleted: 1, batches: 1 });
    expect(await drainExpiredChallenges(env, env.DB, 5, now, 2)).toEqual({ abandoned: 0, deleted: 0, batches: 1 });
    expect(warned.filter((line) => line.includes('"message":"auth_challenges_backlog_left"'))).toHaveLength(1);
    const versions = (await authEvents(appId)).map((event: any) => event.app_version).sort();
    expect(versions).toEqual(["1.0.0", "1.0.2", "1.0.3", "1.0.4"]);
  });

  it("clears a burst in one hourly run, a full batch after another (Sol 7b-4 round 5)", async () => {
    const appId = await seedApp(attestAuthentication());
    const now = Date.now();
    await env.DB.prepare("DELETE FROM app_auth_challenge").run();
    await env.DB.batch(
      Array.from({ length: 5 }, (_, index) =>
        env.DB.prepare("INSERT INTO app_auth_challenge(challenge, app_id, expires_at, attempted) VALUES (?, ?, ?, 0)").bind(`burst-${index}`, appId, now - 10_000 + index),
      ),
    );
    const warned: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => void warned.push(String(line)));
    expect(await drainExpiredChallenges(env, env.DB, 5, now, 2)).toEqual({ abandoned: 5, deleted: 5, batches: 3 });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM app_auth_challenge").first<{ n: number }>())?.n).toBe(0);
    expect(warned.filter((line) => line.includes('"message":"auth_challenges_backlog_left"'))).toEqual([]);
  });

  it("keeps draining when another clean-up deleted part of a full batch first (Sol 7b-4 round 6)", async () => {
    const appId = await seedApp(attestAuthentication());
    const now = Date.now();
    await env.DB.prepare("DELETE FROM app_auth_challenge").run();
    await env.DB.batch(
      Array.from({ length: 5 }, (_, index) =>
        env.DB.prepare("INSERT INTO app_auth_challenge(challenge, app_id, expires_at, attempted) VALUES (?, ?, ?, 0)").bind(`race-${index}`, appId, now - 10_000 + index),
      ),
    );
    // The first batch selects race-0 and race-1; a clean-up started by a challenge request deletes race-0 before it writes.
    let raced = false;
    // Another clean-up deletes a challenge of the batch just before this one's delete runs.
    const db = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver)?.bind?.(target) ?? Reflect.get(target, property, receiver);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith("DELETE FROM app_auth_challenge WHERE challenge IN")) return statement;
          return {
            bind: (...values: unknown[]) => ({
              run: async () => {
                if (!raced) {
                  raced = true;
                  await target.prepare("DELETE FROM app_auth_challenge WHERE challenge = 'race-0'").run();
                }
                return statement.bind(...values).run();
              },
            }),
          };
        };
      },
    });
    expect(await drainExpiredChallenges(env, db, 5, now, 2)).toMatchObject({ deleted: 4, batches: 3 });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM app_auth_challenge").first<{ n: number }>())?.n).toBe(0);
  });

  it("picks a batch through the expiry index, with no sort", async () => {
    const plan = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${EXPIRED_CHALLENGES_SQL}`).bind(Date.now(), 1000).all<{ detail: string }>()).results
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("app_auth_challenge_expiry");
    expect(plan).not.toContain("TEMP B-TREE");
  });
});


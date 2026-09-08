import { Buffer } from "node:buffer";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearApiKeyCache } from "../src/core/apikeys";
import { appAttestEnvironment } from "../src/core/appattest";
import { pruneAuthChallenges } from "../src/core/auth-events";
import { clearAppConfigCache } from "../src/core/config";
import { clearJwksCache } from "../src/core/issuer";
import { verifyGatewayToken } from "../src/core/jwt";
import { database } from "../src/db";
import { appApiKey, appUser } from "../src/db/schema";
import app from "../src/index";
import { TEST_AUDIENCE, TEST_ISSUER, seedApp, seedServerApp } from "./helpers";

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
    .setSubject(typeof claims.sub === "string" ? claims.sub : "firebase-user")
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(fixture.privateKey);
}

async function exchangeToken(appId: string, body: Record<string, unknown>): Promise<Response> {
  return app.fetch(
    new Request(`https://example.test/v1/apps/${appId}/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    createExecutionContext(),
  );
}

async function registerAttestKey(appId: string, body: Record<string, unknown>): Promise<Response> {
  return app.fetch(
    new Request(`https://example.test/v1/apps/${appId}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    createExecutionContext(),
  );
}

function authDataWithAaguid(aaguid: Uint8Array): Uint8Array {
  const authData = Buffer.alloc(87);
  Buffer.from(aaguid).copy(authData, 37);
  return authData;
}

beforeEach(() => {
  clearApiKeyCache();
  clearJwksCache();
  clearAppConfigCache();
});

afterEach(() => vi.restoreAllMocks());

describe("issuer-backed API key exchange", () => {
  it("uses verified issuer identity and emits auth_method=api_key", async () => {
    const fixture = await signingFixture("api-key-success");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));
    const key = await seedServerApp("api-key-success", {
      issuer: { required_claims: [{ path: "entitlements", contains: "pro" }] },
    });

    const response = await exchangeToken("api-key-success", {
      api_key: key,
      issuer_token: await issuerToken(fixture, { sub: "firebase-uid", entitlements: ["pro"] }),
    });

    expect(response.status).toBe(200);
    const body = await response.json<{ access_token: string }>();
    await expect(
      verifyGatewayToken(body.access_token, env.JWT_SECRET, "api-key-success"),
    ).resolves.toMatchObject({
      userId: "firebase-uid",
      authMethod: "api_key",
      credentialType: "gateway_token",
      apiKeyId: "key_api-key-success",
    });
    await expect(
      env.DB.prepare("SELECT id FROM app_user WHERE app_id = ? AND id = ?")
        .bind("api-key-success", "firebase-uid")
        .first(),
    ).resolves.not.toBeNull();
  });

  it("rejects revoked and wrong-app keys before issuer verification", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const revokedKey = await seedServerApp("api-key-revoked", { issuer: {} });
    const wrongAppKey = await seedServerApp("api-key-other");
    await database(env.DB)
      .update(appApiKey)
      .set({ status: "revoked" })
      .where(eq(appApiKey.id, "key_api-key-revoked"));

    for (const key of [revokedKey, wrongAppKey]) {
      clearApiKeyCache();
      const response = await exchangeToken("api-key-revoked", {
        api_key: key,
        issuer_token: "not-a-jwt",
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "auth_required", message: "Gateway API key was rejected" },
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not accept a revoked key from the API-key cache", async () => {
    const fixture = await signingFixture("api-key-revocation-cache");
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));
    const key = await seedServerApp("api-key-revocation-cache", { issuer: {} });
    const token = await issuerToken(fixture, { sub: "cache-user" });

    const initial = await exchangeToken("api-key-revocation-cache", {
      api_key: key,
      issuer_token: token,
    });
    expect(initial.status).toBe(200);

    await database(env.DB)
      .update(appApiKey)
      .set({ status: "revoked" })
      .where(eq(appApiKey.id, "key_api-key-revocation-cache"));

    const revoked = await exchangeToken("api-key-revocation-cache", {
      api_key: key,
      issuer_token: token,
    });
    expect(revoked.status).toBe(403);
    await expect(revoked.json()).resolves.toMatchObject({
      error: { code: "auth_required", message: "Gateway API key was rejected" },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("enforces issuer required claims", async () => {
    const fixture = await signingFixture("api-key-required-claims");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));
    const key = await seedServerApp("api-key-required-claims", {
      issuer: { required_claims: [{ path: "entitlements", contains: "pro" }] },
    });

    const response = await exchangeToken("api-key-required-claims", {
      api_key: key,
      issuer_token: await issuerToken(fixture),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "issuer_claims_missing" },
    });
  });

  it("does not mint a token for a blocked issuer user", async () => {
    const fixture = await signingFixture("api-key-blocked-user");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));
    const key = await seedServerApp("api-key-blocked-user", { issuer: {} });
    await database(env.DB).insert(appUser).values({
      appId: "api-key-blocked-user",
      id: "blocked-user",
      status: "blocked",
      lastSeenAt: "2026-01-02 03:04:05",
    });

    const response = await exchangeToken("api-key-blocked-user", {
      api_key: key,
      issuer_token: await issuerToken(fixture, { sub: "blocked-user" }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "auth_required", message: "User is blocked" },
    });
    await expect(
      env.DB.prepare("SELECT last_seen_at FROM app_user WHERE app_id = ? AND id = ?")
        .bind("api-key-blocked-user", "blocked-user")
        .first<{ last_seen_at: string | null }>(),
    ).resolves.toEqual({ last_seen_at: "2026-01-02 03:04:05" });
  });

  it("persists the client-proof key ID from an exchanged token into usage events", async () => {
    const fixture = await signingFixture("api-key-usage-attribution");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("issuer.test")) return Response.json({ keys: [fixture.publicJwk] });
      return Response.json({
        usage: { input_tokens: 2, output_tokens: 1 },
      });
    });
    const key = await seedServerApp("api-key-usage-attribution", {
      issuer: {},
      endpoints: {
        chat: { api_style: "responses", provider: "openai", model: "gpt-5.6-sol" },
      },
    });
    const exchange = await exchangeToken("api-key-usage-attribution", {
      api_key: key,
      issuer_token: await issuerToken(fixture, { sub: "attributed-user" }),
    });
    expect(exchange.status).toBe(200);
    const { access_token: accessToken } = await exchange.json<{ access_token: string }>();
    const ctx = createExecutionContext();
    const response = await app.fetch(
      new Request(
        "https://example.test/v1/apps/api-key-usage-attribution/endpoints/chat",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            "x-app-version": "1.0",
          },
          body: JSON.stringify({ input: "hello" }),
        },
      ),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    await response.text();
    await waitOnExecutionContext(ctx);

    await expect(
      env.DB.prepare(
        "SELECT api_key_id, auth_method, user_id, endpoint_slug FROM app_usage_event WHERE app_id = ?",
      )
        .bind("api-key-usage-attribution")
        .first(),
    ).resolves.toEqual({
      api_key_id: "key_api-key-usage-attribution",
      auth_method: "api_key",
      user_id: "attributed-user",
      endpoint_slug: "chat",
    });
  });

  it("rejects bare keys on the data plane while issuer-less key apps stay unchanged", async () => {
    const issuerBackedKey = await seedServerApp("api-key-data-plane-issuer", { issuer: {} });
    for (const route of [
      "me",
      "proxy/openai/v1/responses",
      "endpoints/chat",
    ]) {
      const issuerBacked = await app.fetch(
        new Request(`https://example.test/v1/apps/api-key-data-plane-issuer/${route}`, {
          method: route === "me" ? "GET" : "POST",
          headers: { authorization: `Bearer ${issuerBackedKey}` },
        }),
        env,
        createExecutionContext(),
      );
      expect(issuerBacked.status, route).toBe(401);
    }

    const machineKey = await seedServerApp("api-key-data-plane-machine");
    const machine = await app.fetch(
      new Request("https://example.test/v1/apps/api-key-data-plane-machine/me", {
        headers: {
          authorization: `Bearer ${machineKey}`,
          "x-end-user-id": "machine-customer",
        },
      }),
      env,
      createExecutionContext(),
    );
    expect(machine.status).toBe(200);
    await expect(machine.json()).resolves.toMatchObject({ user_id: "machine-customer" });
  });

  it("refuses to exchange against a stored issuer block with no tenant scope", async () => {
    // No lenient read path: a row written before `iss`/`aud` became required
    // would accept tokens from every tenant of a shared-JWKS provider, so it is
    // treated as the broken configuration it is rather than run as written.
    const fixture = await signingFixture("stored-unscoped");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));
    const key = await seedServerApp("issuer-unscoped", { issuer: {} });
    await env.DB.prepare(
      "UPDATE app SET config_json = json_remove(config_json, '$.authentication.issuer.issuer', '$.authentication.issuer.audience') WHERE id = ?",
    )
      .bind("issuer-unscoped")
      .run();
    clearAppConfigCache();

    const response = await exchangeToken("issuer-unscoped", {
      api_key: key,
      issuer_token: await issuerToken(fixture),
    });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "internal_error" } });
  });

  it("rejects unsupported token-exchange combinations clearly", async () => {
    await seedApp("attest-rejects-api-key");
    const attest = await exchangeToken("attest-rejects-api-key", {
      api_key: "agw_not-for-attest",
      issuer_token: "unused",
    });
    expect(attest.status).toBe(400);
    await expect(attest.json()).resolves.toMatchObject({
      error: { code: "auth_method_not_supported" },
    });

    const machineKey = await seedServerApp("machine-no-exchange");
    const machine = await exchangeToken("machine-no-exchange", {
      api_key: machineKey,
      issuer_token: "unused",
    });
    expect(machine.status).toBe(400);
    await expect(machine.json()).resolves.toMatchObject({
      error: { code: "auth_method_not_supported" },
    });
  });
});

describe("blocked App Attest users", () => {
  it("rejects registration and token exchange without triggering key replacement", async () => {
    const fixture = await signingFixture("blocked-attest-register");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));
    await seedApp("blocked-attest-register");
    await database(env.DB).insert(appUser).values({
      appId: "blocked-attest-register",
      id: "blocked-user",
      status: "blocked",
      attestKeyId: "registered-key",
      attestPublicKey: "not-used",
    });
    await env.DB.prepare(
      "INSERT INTO app_auth_challenge(challenge, app_id, expires_at) VALUES (?, ?, datetime('now', '+5 minutes'))",
    ).bind("blocked-challenge", "blocked-attest-register").run();

    const response = await registerAttestKey("blocked-attest-register", {
      issuer_token: await issuerToken(fixture, { sub: "blocked-user" }),
      key_id: "replacement-key",
      attestation: "not-used",
      challenge: "blocked-challenge",
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "auth_required", message: "User is blocked" },
    });

    const tokenResponse = await exchangeToken("blocked-attest-register", {
      issuer_token: await issuerToken(fixture, { sub: "blocked-user" }),
      key_id: "registered-key",
      assertion: "not-used",
      challenge: "blocked-challenge",
    });
    expect(tokenResponse.status).toBe(403);
    await expect(tokenResponse.json()).resolves.toMatchObject({
      error: { code: "auth_required", message: "User is blocked" },
    });
    await expect(
      env.DB.prepare("SELECT challenge FROM app_auth_challenge WHERE app_id = ?")
        .bind("blocked-attest-register")
        .first(),
    ).resolves.toEqual({ challenge: "blocked-challenge" });
    await expect(
      env.DB.prepare(
        "SELECT attest_key_id, attest_public_key, last_seen_at FROM app_user WHERE app_id = ? AND id = ?",
      )
        .bind("blocked-attest-register", "blocked-user")
        .first(),
    ).resolves.toEqual({
      attest_key_id: "registered-key",
      attest_public_key: "not-used",
      last_seen_at: null,
    });
  });
});

describe("App Attest environments", () => {
  const development = () => authDataWithAaguid(Buffer.from("appattestdevelop"));
  const production = () => authDataWithAaguid(
    Buffer.concat([Buffer.from("appattest"), Buffer.alloc(7)]),
  );

  it("rejects the development AAGUID unless the application opted into it", () => {
    expect(() => appAttestEnvironment(development(), ["production"])).toThrow();
    expect(appAttestEnvironment(development(), ["development"])).toBe("development");
    expect(appAttestEnvironment(development(), ["production", "development"])).toBe("development");
  });

  it("accepts production whenever it is allowed", () => {
    expect(appAttestEnvironment(production(), ["production"])).toBe("production");
    expect(appAttestEnvironment(production(), ["production", "development"])).toBe("production");
  });

  it("rejects production for an application that only allows development", () => {
    expect(() => appAttestEnvironment(production(), ["development"])).toThrow();
  });

  it("rejects unknown AAGUIDs", () => {
    expect(() => appAttestEnvironment(authDataWithAaguid(Buffer.alloc(16, 7)), ["production", "development"]))
      .toThrow();
  });
});

describe("withdrawing an App Attest environment", () => {
  async function seedRegisteredKey(
    appId: string,
    attestEnvironment: "production" | "development" | null,
  ) {
    const fixture = await signingFixture(appId);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));
    // Seeded without an `environments` opt-in, so the app is production-only.
    await seedApp(appId);
    await database(env.DB).insert(appUser).values({
      appId,
      id: "registered-user",
      attestKeyId: "registered-key",
      attestPublicKey: "not-used",
      ...(attestEnvironment === null ? {} : { attestEnvironment }),
    });
    await env.DB.prepare(
      "INSERT INTO app_auth_challenge(challenge, app_id, expires_at) VALUES (?, ?, datetime('now', '+5 minutes'))",
    ).bind(`${appId}-challenge`, appId).run();
    return exchangeToken(appId, {
      issuer_token: await issuerToken(fixture, { sub: "registered-user" }),
      key_id: "registered-key",
      assertion: "not-used",
      challenge: `${appId}-challenge`,
    });
  }

  it("stops a key registered in an environment the app no longer allows", async () => {
    const response = await seedRegisteredKey("attest-env-withdrawn", "development");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "attest_failed",
        message: "The registered App Attest environment is no longer allowed",
      },
    });
  });

  it("keeps accepting a key registered in an environment the app still allows", async () => {
    const response = await seedRegisteredKey("attest-env-kept", "production");
    // Fails later, on the unusable assertion, rather than on the environment.
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.not.toMatchObject({
      error: { message: "The registered App Attest environment is no longer allowed" },
    });
  });

  it("treats a key predating the recorded environment as production", async () => {
    const response = await seedRegisteredKey("attest-env-legacy", null);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.not.toMatchObject({
      error: { message: "The registered App Attest environment is no longer allowed" },
    });
  });
});

describe("App Attest challenge retention", () => {
  async function seedChallenges(appId: string): Promise<void> {
    await seedApp(appId);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO app_auth_challenge(challenge, app_id, expires_at) VALUES (?, ?, datetime('now', '-1 minute'))",
      ).bind(`${appId}-expired-1`, appId),
      env.DB.prepare(
        "INSERT INTO app_auth_challenge(challenge, app_id, expires_at) VALUES (?, ?, datetime('now', '-1 day'))",
      ).bind(`${appId}-expired-2`, appId),
      env.DB.prepare(
        "INSERT INTO app_auth_challenge(challenge, app_id, expires_at) VALUES (?, ?, datetime('now', '+5 minutes'))",
      ).bind(`${appId}-live`, appId),
    ]);
  }

  async function challengesFor(appId: string): Promise<string[]> {
    const rows = await env.DB
      .prepare("SELECT challenge FROM app_auth_challenge WHERE app_id = ? ORDER BY challenge")
      .bind(appId)
      .all<{ challenge: string }>();
    return rows.results.map((row) => row.challenge);
  }

  it("drops expired challenges on the nightly sweep and keeps the live ones", async () => {
    await seedChallenges("prune-challenges");

    const ctx = createExecutionContext();
    app.scheduled({ cron: "17 3 * * *", scheduledTime: Date.now() } as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);

    await expect(challengesFor("prune-challenges")).resolves.toEqual(["prune-challenges-live"]);
  });

  it("reports how many it took", async () => {
    await seedChallenges("prune-challenge-count");

    // Counted across the deployment, not per app: it is one sweep.
    expect(await pruneAuthChallenges(env)).toBeGreaterThanOrEqual(2);
    await expect(challengesFor("prune-challenge-count")).resolves.toEqual([
      "prune-challenge-count-live",
    ]);
  });
});

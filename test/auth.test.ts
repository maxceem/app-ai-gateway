import { Buffer } from "node:buffer";
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appAttestEnvironment } from "../src/core/appattest";
import { clearAppConfigCache, invalidateAppConfig } from "../src/core/config";
import { clearJwksCache } from "../src/core/issuer";
import { verifyGatewayToken } from "../src/core/jwt";
import { storeAttestedUser } from "../src/routes/auth";
import app from "../src/index";
import { seedApp, TEST_DEVELOPMENT_SECRET } from "./helpers";

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
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(fixture.privateKey);
}

function authPolicy(input: {
  enableDevAccess?: boolean;
  allowedEnvironments?: string[];
} = {}): Record<string, unknown> {
  return {
    jwks_url: "https://issuer.auth.test/.well-known/jwks.json",
    user_id_claim: "sub",
    required_claims: [{ path: "entitlements", contains: "pro" }],
    appattest_environments: input.allowedEnvironments ?? ["production", "development"],
    ...(input.enableDevAccess === false
      ? {}
      : {
          dev_access: true,
        }),
    max_token_lifetime_seconds: 3600,
  };
}

async function exchangeDevelopmentToken(
  appId: string,
  body: Record<string, unknown>,
): Promise<Response> {
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

function authDataWithAaguid(aaguid: Uint8Array): Uint8Array {
  const authData = Buffer.alloc(87);
  Buffer.from(aaguid).copy(authData, 37);
  return authData;
}

beforeEach(() => {
  clearJwksCache();
  clearAppConfigCache();
});

afterEach(() => vi.restoreAllMocks());

describe("per-app development authentication", () => {
  it("uses the verified issuer identity and emits auth_method=dev", async () => {
    const fixture = await signingFixture("dev-success");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));
    await seedApp("dev-success", { auth: authPolicy() });

    const response = await exchangeDevelopmentToken("dev-success", {
      issuer_token: await issuerToken(fixture, { sub: "firebase-uid", entitlements: ["pro"] }),
      dev_secret: TEST_DEVELOPMENT_SECRET,
    });

    expect(response.status).toBe(200);
    const body = await response.json<{ access_token: string }>();
    await expect(
      verifyGatewayToken(body.access_token, env.JWT_SECRET, "dev-success"),
    ).resolves.toMatchObject({
      userId: "firebase-uid",
      authMethod: "dev",
    });
    await expect(
      env.DB.prepare("SELECT id FROM app_user WHERE app_id = ? AND id = ?")
        .bind("dev-success", "firebase-uid")
        .first(),
    ).resolves.not.toBeNull();
  });

  it("rejects a token signed by the wrong issuer", async () => {
    const trusted = await signingFixture("shared-kid");
    const wrongIssuer = await signingFixture("shared-kid");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [trusted.publicJwk] }));
    await seedApp("dev-wrong-issuer", {
      auth: authPolicy(),
    });

    const response = await exchangeDevelopmentToken("dev-wrong-issuer", {
      issuer_token: await issuerToken(wrongIssuer),
      dev_secret: TEST_DEVELOPMENT_SECRET,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "issuer_token_rejected" },
    });
  });

  it("rejects the wrong per-app secret without verifying the issuer token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await seedApp("dev-wrong-secret", { auth: authPolicy() });

    const response = await exchangeDevelopmentToken("dev-wrong-secret", {
      issuer_token: "not-a-jwt",
      dev_secret: "wrong-secret",
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "auth_required" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("always enforces required claims for development access", async () => {
    const fixture = await signingFixture("required-claims");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));
    const tokenWithoutEntitlement = await issuerToken(fixture);
    await seedApp("dev-required-claims", { auth: authPolicy() });

    const response = await exchangeDevelopmentToken("dev-required-claims", {
      issuer_token: tokenWithoutEntitlement,
      dev_secret: TEST_DEVELOPMENT_SECRET,
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "issuer_token_rejected" },
    });
  });

  it("rejects the legacy user_id development body", async () => {
    await seedApp("dev-legacy-body", { auth: authPolicy() });
    const response = await exchangeDevelopmentToken("dev-legacy-body", {
      user_id: "impersonated-user",
      dev_secret: TEST_DEVELOPMENT_SECRET,
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request" },
    });
  });
});

describe("per-app App Attest environments", () => {
  it("accepts development AAGUIDs only when development is allowed", () => {
    const development = authDataWithAaguid(Buffer.from("appattestdevelop"));
    expect(appAttestEnvironment(development, ["production", "development"])).toBe("development");
    expect(() => appAttestEnvironment(development, ["production"])).toThrow();
  });

  it("accepts production AAGUIDs when production is allowed and rejects unknown values", () => {
    const production = authDataWithAaguid(
      Buffer.concat([Buffer.from("appattest"), Buffer.alloc(7)]),
    );
    expect(appAttestEnvironment(production, ["production"])).toBe("production");
    expect(() =>
      appAttestEnvironment(authDataWithAaguid(Buffer.alloc(16, 7)), ["production", "development"]),
    ).toThrow();
  });

  it("records the environment when an attested user is registered", async () => {
    await seedApp("attest-environment-store");
    await storeAttestedUser({
      env,
      appId: "attest-environment-store",
      userId: "registered-user",
      keyId: "registered-key",
      publicKeyPem: "public-key",
      environment: "development",
    });
    await expect(
      env.DB.prepare("SELECT attest_env FROM app_user WHERE app_id = ? AND id = ?")
        .bind("attest-environment-store", "registered-user")
        .first<{ attest_env: string | null }>(),
    ).resolves.toEqual({ attest_env: "development" });
  });

  it("rejects token exchange after a registered environment is removed from policy", async () => {
    const fixture = await signingFixture("attest-revoked");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));
    await seedApp("attest-revoked", {
      auth: authPolicy({
        enableDevAccess: false,
        allowedEnvironments: ["production", "development"],
      }),
    });
    await storeAttestedUser({
      env,
      appId: "attest-revoked",
      userId: "firebase-user",
      keyId: "development-key",
      publicKeyPem: "public-key",
      environment: "development",
    });
    const row = await env.DB.prepare("SELECT config_json FROM app WHERE id = ?")
      .bind("attest-revoked")
      .first<{ config_json: string }>();
    const updatedConfig = JSON.parse(row!.config_json) as {
      authentication: { app_attest: { environments: string[] } };
    };
    updatedConfig.authentication.app_attest.environments = ["production"];
    await env.DB.prepare("UPDATE app SET config_json = ? WHERE id = ?")
      .bind(JSON.stringify(updatedConfig), "attest-revoked")
      .run();
    invalidateAppConfig("attest-revoked");

    const response = await app.fetch(
      new Request("https://example.test/v1/apps/attest-revoked/auth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          issuer_token: await issuerToken(fixture, { entitlements: ["pro"] }),
          key_id: "development-key",
          assertion: "unused-assertion",
          challenge: "unused-challenge",
        }),
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "attest_failed" },
    });
  });
});

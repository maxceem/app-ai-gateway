import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearJwksCache, verifyIssuerToken } from "../src/core/issuer";
import type { IssuerAuthConfig } from "../src/core/types";

const baseConfig: IssuerAuthConfig = {
  jwks_url: "https://issuer.test/.well-known/jwks.json",
  user_id_claim: "sub",
  required_claims: [],
  max_token_lifetime_seconds: 3600,
};

async function signingFixture(kid: string): Promise<{
  publicJwk: JWK;
  token: (claims?: Record<string, unknown>, lifetime?: number) => Promise<string>;
}> {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  const token = async (claims: Record<string, unknown> = {}, lifetime = 300): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuedAt(now)
      .setExpirationTime(now + lifetime);
    if (typeof claims.sub !== "string") jwt.setSubject("issuer-user");
    return jwt.sign(pair.privateKey);
  };
  return { publicJwk, token };
}

beforeEach(() => clearJwksCache());
afterEach(() => vi.restoreAllMocks());

describe("issuer JWT verification", () => {
  it("accepts a valid zero-config issuer token", async () => {
    const fixture = await signingFixture("key-1");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));
    await expect(verifyIssuerToken(await fixture.token(), baseConfig)).resolves.toMatchObject({
      userId: "issuer-user",
    });
  });

  it("matches audience, scope, and nested array requirements uniformly", async () => {
    const fixture = await signingFixture("key-claims");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));
    const config: IssuerAuthConfig = {
      ...baseConfig,
      required_claims: [
        { path: "aud", contains: "ai-gateway" },
        { path: "scope", contains: "ai.invoke" },
        { path: "claims.entitlements", contains: "pro" },
      ],
    };
    const valid = await fixture.token({
      aud: ["mobile", "ai-gateway"],
      scope: "openid ai.invoke profile",
      claims: { entitlements: ["basic", "pro"] },
    });
    await expect(verifyIssuerToken(valid, config)).resolves.toMatchObject({ userId: "issuer-user" });
    const missingAudience = await fixture.token({
      aud: ["mobile"],
      scope: "openid ai.invoke profile",
      claims: { entitlements: ["pro"] },
    });
    await expect(verifyIssuerToken(missingAudience, config)).rejects.toMatchObject({
      code: "issuer_token_rejected",
    });
  });

  it("accepts only Firebase-shaped tokens from the configured project with the pro entitlement", async () => {
    const fixture = await signingFixture("firebase-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));
    const firebaseConfig: IssuerAuthConfig = {
      ...baseConfig,
      jwks_url: "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
      required_claims: [
        { path: "iss", contains: "https://securetoken.google.com/calorie-tracker-production" },
        { path: "aud", contains: "calorie-tracker-production" },
        { path: "revenueCatEntitlements", contains: "pro" },
      ],
    };
    const valid = await fixture.token({
      iss: "https://securetoken.google.com/calorie-tracker-production",
      aud: "calorie-tracker-production",
      sub: "firebase-anonymous-uid",
      auth_time: Math.floor(Date.now() / 1000),
      firebase: { sign_in_provider: "anonymous" },
      revenueCatEntitlements: ["pro"],
    });
    await expect(verifyIssuerToken(valid, firebaseConfig)).resolves.toMatchObject({
      userId: "firebase-anonymous-uid",
    });

    const otherProject = await fixture.token({
      iss: "https://securetoken.google.com/attacker-project",
      aud: "attacker-project",
      sub: "attacker-uid",
      revenueCatEntitlements: ["pro"],
    });
    await expect(verifyIssuerToken(otherProject, firebaseConfig)).rejects.toMatchObject({
      code: "issuer_token_rejected",
    });
  });

  it("rejects tokens whose declared lifetime exceeds the configured cap", async () => {
    const fixture = await signingFixture("key-long");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));
    await expect(verifyIssuerToken(await fixture.token({}, 3601), baseConfig)).rejects.toMatchObject({
      code: "issuer_token_rejected",
    });
  });

  it("refetches JWKS exactly once when kid is unknown", async () => {
    const fixture = await signingFixture("unknown-key");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [] }));
    await expect(verifyIssuerToken(await fixture.token(), baseConfig)).rejects.toMatchObject({
      code: "issuer_token_rejected",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("rejects HS256 even when the JWKS contains a matching oct key", async () => {
    const secret = new TextEncoder().encode("attacker-controlled-symmetric-secret");
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", kid: "symmetric-key" })
      .setSubject("issuer-user")
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(secret);
    const encodedSecret = btoa(String.fromCharCode(...secret))
      .replace(/\+/gu, "-")
      .replace(/\//gu, "_")
      .replace(/=+$/gu, "");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      keys: [{ kty: "oct", kid: "symmetric-key", alg: "HS256", k: encodedSecret }],
    }));

    await expect(verifyIssuerToken(token, baseConfig)).rejects.toMatchObject({
      code: "issuer_token_rejected",
    });
  });

  it("rejects a token when the matched JWK declares a different algorithm", async () => {
    const fixture = await signingFixture("key-alg-mismatch");
    fixture.publicJwk.alg = "PS256";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));

    await expect(verifyIssuerToken(await fixture.token(), baseConfig)).rejects.toMatchObject({
      code: "issuer_token_rejected",
    });
  });
});

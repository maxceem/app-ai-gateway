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
    // A valid token missing a required claim is its own behaviour class: the
    // caller has to wait for the claim, not fetch another token.
    await expect(verifyIssuerToken(missingAudience, config)).rejects.toMatchObject({
      status: 403,
      code: "issuer_claims_missing",
      reason: "claims_missing",
      userId: "issuer-user",
    });
  });

  it("accepts any listed value when contains is an array of alternatives", async () => {
    const fixture = await signingFixture("key-any-of");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));
    const config: IssuerAuthConfig = {
      ...baseConfig,
      required_claims: [{ path: "revenueCatEntitlements", contains: ["pro", "pro_test"] }],
    };
    const testEntitlement = await fixture.token({ revenueCatEntitlements: ["pro_test"] });
    await expect(verifyIssuerToken(testEntitlement, config)).resolves.toMatchObject({ userId: "issuer-user" });
    const prodEntitlement = await fixture.token({ revenueCatEntitlements: ["pro"] });
    await expect(verifyIssuerToken(prodEntitlement, config)).resolves.toMatchObject({ userId: "issuer-user" });
    const neither = await fixture.token({ revenueCatEntitlements: ["basic"] });
    await expect(verifyIssuerToken(neither, config)).rejects.toMatchObject({ code: "issuer_claims_missing" });
  });

  it("accepts only Firebase-shaped tokens from the configured project with the pro entitlement", async () => {
    const fixture = await signingFixture("firebase-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [fixture.publicJwk] }));
    const firebaseConfig: IssuerAuthConfig = {
      ...baseConfig,
      jwks_url: "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
      required_claims: [
        { path: "iss", contains: "https://securetoken.google.com/example-production" },
        { path: "aud", contains: "example-production" },
        { path: "revenueCatEntitlements", contains: "pro" },
      ],
    };
    const valid = await fixture.token({
      iss: "https://securetoken.google.com/example-production",
      aud: "example-production",
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
      code: "issuer_claims_missing",
      reason: "claims_missing",
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
    // A fresh Response per call: a body can only be read once, and reusing one
    // would make the refetch fail to parse rather than come back keyless —
    // which is a different rejection entirely.
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(Response.json({ keys: [] })));
    await expect(verifyIssuerToken(await fixture.token(), baseConfig)).rejects.toMatchObject({
      code: "issuer_token_rejected",
      reason: "unknown_kid",
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
      reason: "alg_mismatch",
    });
  });
});

/**
 * The mapping itself, cause by cause. Nine distinct failures once shared one
 * opaque code, which is what made a subscription still syncing indistinguishable
 * from a forged token — for the operator and for the client.
 */
describe("issuer rejection reasons", () => {
  /** A fresh `Response` per call: a JWKS body can only be read once. */
  const serveJwks = (keys: unknown) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(Response.json({ keys })));

  it("names the cause behind every token-invalid rejection", async () => {
    const fixture = await signingFixture("reason-key");
    const jwks = () => serveJwks([fixture.publicJwk]);

    // Not a JWT at all: `jose` throws before any check of ours runs.
    jwks();
    await expect(verifyIssuerToken("not-a-jwt", baseConfig)).rejects.toMatchObject({
      status: 403,
      code: "issuer_token_rejected",
      reason: "bad_signature",
    });

    // A header with no kid never reaches the key lookup.
    clearJwksCache();
    jwks();
    const noKid = await new SignJWT({ sub: "issuer-user" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign((await generateKeyPair("RS256", { extractable: true })).privateKey);
    await expect(verifyIssuerToken(noKid, baseConfig)).rejects.toMatchObject({
      code: "issuer_token_rejected",
      reason: "header_invalid",
    });

    clearJwksCache();
    serveJwks([]);
    await expect(verifyIssuerToken(await fixture.token(), baseConfig)).rejects.toMatchObject({
      code: "issuer_token_rejected",
      reason: "unknown_kid",
    });

    clearJwksCache();
    jwks();
    await expect(verifyIssuerToken(await fixture.token({}, -60), baseConfig)).rejects.toMatchObject({
      code: "issuer_token_rejected",
      reason: "expired",
    });

    clearJwksCache();
    jwks();
    await expect(verifyIssuerToken(await fixture.token({}, 3601), baseConfig)).rejects.toMatchObject({
      code: "issuer_token_rejected",
      reason: "lifetime_exceeded",
    });

    clearJwksCache();
    jwks();
    await expect(
      verifyIssuerToken(await fixture.token(), { ...baseConfig, user_id_claim: "absent" }),
    ).rejects.toMatchObject({ code: "issuer_token_rejected", reason: "user_id_missing" });
  });

  it("answers 503 when the gateway itself could not verify anything", async () => {
    const fixture = await signingFixture("jwks-down");

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    await expect(verifyIssuerToken(await fixture.token(), baseConfig)).rejects.toMatchObject({
      status: 503,
      code: "issuer_verification_unavailable",
      reason: "jwks_unreachable",
    });

    clearJwksCache();
    vi.spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(new Response("nope", { status: 500 })));
    await expect(verifyIssuerToken(await fixture.token(), baseConfig)).rejects.toMatchObject({
      status: 503,
      reason: "jwks_unreachable",
    });

    clearJwksCache();
    serveJwks("not-an-array");
    await expect(verifyIssuerToken(await fixture.token(), baseConfig)).rejects.toMatchObject({
      status: 503,
      code: "issuer_verification_unavailable",
      reason: "jwks_invalid",
    });

    // A 200 carrying an HTML error page — a captive portal, a CDN's own error
    // document — is the same failure. Left unguarded the parse error falls into
    // the catch-all and blames the caller's token for an outage upstream of it.
    clearJwksCache();
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response("<html>502 Bad Gateway</html>", {
        headers: { "content-type": "text/html" },
      })),
    );
    await expect(verifyIssuerToken(await fixture.token(), baseConfig)).rejects.toMatchObject({
      status: 503,
      code: "issuer_verification_unavailable",
      reason: "jwks_invalid",
    });
  });

  it("carries the verified user id on a claims-missing rejection", async () => {
    // The signature is checked before the claims are, so this identity is
    // trustworthy — which is what lets the route open a propagation window for
    // the right user instead of guessing from an unverified body.
    const fixture = await signingFixture("claims-user");
    serveJwks([fixture.publicJwk]);
    const config: IssuerAuthConfig = {
      ...baseConfig,
      required_claims: [{ path: "entitlements", contains: "pro" }],
    };

    await expect(
      verifyIssuerToken(await fixture.token({ sub: "waiting-user" }), config),
    ).rejects.toMatchObject({
      status: 403,
      code: "issuer_claims_missing",
      reason: "claims_missing",
      userId: "waiting-user",
    });

    // Callers that skip the requirement cannot reach that rejection at all.
    await expect(
      verifyIssuerToken(await fixture.token({ sub: "waiting-user" }), config, {
        skipRequiredClaims: true,
      }),
    ).resolves.toMatchObject({ userId: "waiting-user" });
  });
});

import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueGatewayToken, verifyGatewayToken } from "../src/client-auth/gateway-token";

afterEach(() => vi.restoreAllMocks());

const secret = "method-gateway-secret-with-at-least-32-bytes";

describe("gateway JWT auth method", () => {
  it("refuses a token that does not name how it was obtained", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ app: "method-app" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject("method-user")
      .setJti("method-jti")
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(new TextEncoder().encode(secret));

    await expect(verifyGatewayToken(token, secret, "method-app")).rejects.toMatchObject({
      status: 401,
      code: "auth_required",
    });
  });
});

/**
 * The key cache is module-level, so these secrets are used by nothing else:
 * a warm entry from another test would make the import count say nothing.
 */
describe("the imported HMAC key", () => {
  const secretOne = "key-cache-secret-one-with-at-least-32-bytes";
  const secretTwo = "key-cache-secret-two-with-at-least-32-bytes";

  it("imports once per secret, whatever it then signs and verifies", async () => {
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    const { token } = await issueGatewayToken(secretOne, {
      appId: "key-cache-app",
      userId: "user-1",
      authMethod: "attest",
    });
    expect(importKey).toHaveBeenCalledTimes(1);

    // A token signed with the cached key still verifies, twice over, and the
    // second verification imports nothing.
    for (const _attempt of [1, 2]) {
      await expect(verifyGatewayToken(token, secretOne, "key-cache-app")).resolves.toMatchObject({
        userId: "user-1",
        authMethod: "attest",
        credentialType: "gateway_token",
      });
    }
    expect(importKey).toHaveBeenCalledTimes(1);

    // Another secret is another key, and a token signed with it is not this
    // application's: the cache never makes one secret answer for another.
    const other = await issueGatewayToken(secretTwo, {
      appId: "key-cache-app",
      userId: "user-2",
      authMethod: "attest",
    });
    expect(importKey).toHaveBeenCalledTimes(2);
    await expect(verifyGatewayToken(other.token, secretOne, "key-cache-app"))
      .rejects.toMatchObject({ status: 401, code: "auth_required" });
    expect(importKey).toHaveBeenCalledTimes(2);
  });
});

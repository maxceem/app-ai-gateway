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

  /**
   * An attest token is bound to the install whose key signs every request it
   * is sent with. One without an install could not be checked against any
   * key, and an API-key token that claimed one would be naming a proof it was
   * never asked for.
   */
  it("requires an install on an attest token, and refuses one anywhere else", async () => {
    const now = Math.floor(Date.now() / 1000);
    const sign = (claims: Record<string, unknown>) => new SignJWT({ app: "method-app", ...claims })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject("method-user")
      .setJti(crypto.randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(new TextEncoder().encode(secret));

    await expect(verifyGatewayToken(await sign({ auth_method: "attest" }), secret, "method-app"))
      .rejects.toMatchObject({ status: 401, code: "auth_required" });
    await expect(verifyGatewayToken(await sign({ auth_method: "attest", install: "" }), secret, "method-app"))
      .rejects.toMatchObject({ status: 401, code: "auth_required" });
    await expect(verifyGatewayToken(await sign({ auth_method: "api_key", install: "k" }), secret, "method-app"))
      .rejects.toMatchObject({ status: 401, code: "auth_required" });
    await expect(verifyGatewayToken(await sign({ auth_method: "attest", install: "key-1" }), secret, "method-app"))
      .resolves.toMatchObject({ authMethod: "attest", installId: "key-1" });
    await expect(verifyGatewayToken(await sign({ auth_method: "api_key" }), secret, "method-app"))
      .resolves.toMatchObject({ authMethod: "api_key", installId: null });
    // Only a caller that may accept an unsigned request lets an install-less
    // attest token through, and never an empty install.
    await expect(verifyGatewayToken(await sign({ auth_method: "attest" }), secret, "method-app", { legacyAttest: true }))
      .resolves.toMatchObject({ authMethod: "attest", installId: null });
    await expect(verifyGatewayToken(await sign({ auth_method: "attest", install: "" }), secret, "method-app", { legacyAttest: true }))
      .rejects.toMatchObject({ status: 401, code: "auth_required" });
  });

  it("issues the install claim on attest tokens", async () => {
    const { token } = await issueGatewayToken(secret, {
      appId: "method-app",
      userId: "method-user",
      authMethod: "attest",
      installId: "key-2",
    });
    const payload = JSON.parse(atob(token.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/")));
    expect(payload).toMatchObject({ auth_method: "attest", install: "key-2", sub: "method-user" });
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
      installId: "key-cache-install",
    });
    expect(importKey).toHaveBeenCalledTimes(1);

    // A token signed with the cached key still verifies, twice over, and the
    // second verification imports nothing.
    for (const _attempt of [1, 2]) {
      await expect(verifyGatewayToken(token, secretOne, "key-cache-app")).resolves.toMatchObject({
        userId: "user-1",
        authMethod: "attest",
        credentialType: "gateway_token",
        installId: "key-cache-install",
      });
    }
    expect(importKey).toHaveBeenCalledTimes(1);

    // Another secret is another key, and a token signed with it is not this
    // application's: the cache never makes one secret answer for another.
    const other = await issueGatewayToken(secretTwo, {
      appId: "key-cache-app",
      userId: "user-2",
      authMethod: "attest",
      installId: "key-cache-install-2",
    });
    expect(importKey).toHaveBeenCalledTimes(2);
    await expect(verifyGatewayToken(other.token, secretOne, "key-cache-app"))
      .rejects.toMatchObject({ status: 401, code: "auth_required" });
    expect(importKey).toHaveBeenCalledTimes(2);
  });
});

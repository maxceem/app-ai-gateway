import { env } from "cloudflare:workers";
import { decodeJwt, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { issueGatewayToken, verifyGatewayToken, verifyGatewayTokenAndShare } from "../src/client-auth/gateway-token.ts";

describe("gateway tokens", () => {
  it("carry the install and Apple Account of an App Attest exchange", async () => {
    const { token, expiresIn } = await issueGatewayToken(env.JWT_SECRET, {
      appId: "app1",
      userId: "user1",
      authMethod: "attest",
      installId: "key1",
      appleAccountId: "acct1",
    });
    expect(expiresIn).toBe(3600);
    await expect(verifyGatewayToken(token, env.JWT_SECRET, "app1")).resolves.toEqual({
      appId: "app1",
      userId: "user1",
      credentialType: "gateway_token",
      authMethod: "attest",
      installId: "key1",
      appleAccountId: "acct1",
    });
  });

  it("carry the app key of an issuer exchange", async () => {
    const { token } = await issueGatewayToken(env.JWT_SECRET, { appId: "app1", userId: "u", authMethod: "api_key", apiKeyId: "key_1" });
    await expect(verifyGatewayToken(token, env.JWT_SECRET, "app1")).resolves.toMatchObject({
      authMethod: "api_key",
      apiKeyId: "key_1",
      installId: null,
    });
  });

  it("are refused for another app, with another secret, or tampered", async () => {
    const { token } = await issueGatewayToken(env.JWT_SECRET, { appId: "app1", userId: "u", authMethod: "api_key" });
    await expect(verifyGatewayToken(token, env.JWT_SECRET, "app2")).rejects.toMatchObject({ status: 401, code: "auth_required" });
    await expect(verifyGatewayToken(token, "another-secret-with-at-least-thirty-two-bytes", "app1")).rejects.toMatchObject({
      code: "auth_required",
    });
    const [head, , signature] = token.split(".");
    const forged = `${head}.${btoa(JSON.stringify({ app: "app1", sub: "admin" })).replace(/=+$/, "")}.${signature}`;
    await expect(verifyGatewayToken(forged, env.JWT_SECRET, "app1")).rejects.toMatchObject({ code: "auth_required" });
  });

  it("carry the app's credential sealed, bound to the one token it was sealed into (split keys)", async () => {
    const share = "shr_abcdefghij0123456789.secret-part-of-the-share-0123456789";
    const { token } = await issueGatewayToken(env.JWT_SECRET, { appId: "app1", userId: "u", authMethod: "attest", installId: "k", keyShare: share });
    const claims = decodeJwt(token);
    expect(claims.key_share).toEqual(expect.any(String));
    expect(JSON.stringify(claims)).not.toContain("secret-part");
    await expect(verifyGatewayTokenAndShare(token, env.JWT_SECRET, "app1")).resolves.toMatchObject({ share, identity: { installId: "k" } });
    // A token without one carries none.
    const plain = await issueGatewayToken(env.JWT_SECRET, { appId: "app1", userId: "u", authMethod: "attest", installId: "k" });
    expect(decodeJwt(plain.token).key_share).toBeUndefined();
    await expect(verifyGatewayTokenAndShare(plain.token, env.JWT_SECRET, "app1")).resolves.toMatchObject({ share: null });

    // Moved into another token this gateway signed (another jti, user or app), it does not open.
    const key = new TextEncoder().encode(env.JWT_SECRET);
    const now = Math.floor(Date.now() / 1000);
    const signed = (payload: Record<string, unknown>, sub: string, jti: string) =>
      new SignJWT(payload).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setSubject(sub).setIssuedAt(now).setExpirationTime(now + 60).setJti(jti).sign(key);
    const moved = { app: "app1", auth_method: "attest", install: "k", key_share: claims.key_share };
    await expect(verifyGatewayTokenAndShare(await signed(moved, "u", "another-jti"), env.JWT_SECRET, "app1")).rejects.toMatchObject({ code: "auth_required" });
    await expect(verifyGatewayTokenAndShare(await signed(moved, "someone-else", claims.jti!), env.JWT_SECRET, "app1")).rejects.toMatchObject({ code: "auth_required" });
    await expect(verifyGatewayTokenAndShare(await signed({ ...moved, app: "app2" }, "u", claims.jti!), env.JWT_SECRET, "app2")).rejects.toMatchObject({ code: "auth_required" });
    // The same claims signed again, untouched, still open: only the binding was changed above.
    await expect(verifyGatewayTokenAndShare(await signed(moved, "u", claims.jti!), env.JWT_SECRET, "app1")).resolves.toMatchObject({ share });
    // A tampered or malformed sealed value is refused like any bad token.
    const tampered = (claims.key_share as string).slice(0, -2) + ((claims.key_share as string).endsWith("AA") ? "BB" : "AA");
    await expect(verifyGatewayTokenAndShare(await signed({ ...moved, key_share: tampered }, "u", claims.jti!), env.JWT_SECRET, "app1")).rejects.toMatchObject({ code: "auth_required" });
    await expect(verifyGatewayTokenAndShare(await signed({ ...moved, key_share: 42 }, "u", claims.jti!), env.JWT_SECRET, "app1")).rejects.toMatchObject({ code: "auth_required" });
    await expect(verifyGatewayTokenAndShare(await signed({ ...moved, key_share: "!!" }, "u", claims.jti!), env.JWT_SECRET, "app1")).rejects.toMatchObject({ code: "auth_required" });
  });

  it("are refused when an App Attest token names no install", async () => {
    const key = new TextEncoder().encode(env.JWT_SECRET);
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ app: "app1", auth_method: "attest" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject("u")
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setJti("j")
      .sign(key);
    await expect(verifyGatewayToken(token, env.JWT_SECRET, "app1")).rejects.toMatchObject({ code: "auth_required" });
  });

  // Ported from v1's `jwt.test.ts`.
  it("are refused when they do not say how they were obtained, or claim what their method never has", async () => {
    const key = new TextEncoder().encode(env.JWT_SECRET);
    const now = Math.floor(Date.now() / 1000);
    const sign = (claims: Record<string, unknown>) =>
      new SignJWT({ app: "app1", ...claims })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setSubject("u")
        .setIssuedAt(now)
        .setExpirationTime(now + 60)
        .setJti(crypto.randomUUID())
        .sign(key);
    for (const claims of [
      {},
      { auth_method: "password" },
      { auth_method: "attest", install: "" },
      { auth_method: "api_key", install: "k" },
      { auth_method: "attest", install: "key-1", apple_account: "" },
      { auth_method: "attest", install: "key-1", apple_account: 7 },
      { auth_method: "api_key", apple_account: "acct" },
      { auth_method: "api_key", api_key_id: "" },
    ]) {
      await expect(verifyGatewayToken(await sign(claims), env.JWT_SECRET, "app1"), JSON.stringify(claims)).rejects.toMatchObject({
        status: 401,
        code: "auth_required",
      });
    }
    await expect(verifyGatewayToken(await sign({ auth_method: "attest", install: "key-1" }), env.JWT_SECRET, "app1")).resolves.toMatchObject({
      installId: "key-1",
      appleAccountId: null,
    });
  });

  it("are refused when signed with another algorithm", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ app: "app1", auth_method: "api_key" })
      .setProtectedHeader({ alg: "HS512", typ: "JWT" })
      .setSubject("u")
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setJti("j")
      .sign(new TextEncoder().encode(env.JWT_SECRET));
    await expect(verifyGatewayToken(token, env.JWT_SECRET, "app1")).rejects.toMatchObject({ code: "auth_required" });
  });
});

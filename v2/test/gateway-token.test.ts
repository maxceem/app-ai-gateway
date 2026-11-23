import { env } from "cloudflare:workers";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { issueGatewayToken, verifyGatewayToken } from "../src/client-auth/gateway-token.ts";

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

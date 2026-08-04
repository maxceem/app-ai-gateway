import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { verifyGatewayToken } from "../src/core/jwt";

const secret = "legacy-gateway-secret-with-at-least-32-bytes";

describe("gateway JWT auth method", () => {
  it("treats a legacy token without auth_method as attested", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ app: "legacy-app" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject("legacy-user")
      .setJti("legacy-jti")
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(new TextEncoder().encode(secret));

    await expect(verifyGatewayToken(token, secret, "legacy-app")).resolves.toMatchObject({
      userId: "legacy-user",
      authMethod: "attest",
    });
  });
});

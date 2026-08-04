import { jwtVerify, SignJWT } from "jose";
import { GatewayError } from "./errors";
import type { GatewayAuthMethod, GatewayIdentity } from "./types";

const encoder = new TextEncoder();

function key(secret: string): Uint8Array {
  if (encoder.encode(secret).byteLength < 32) {
    throw new GatewayError(500, "internal_error", "JWT_SECRET must be at least 32 bytes");
  }
  return encoder.encode(secret);
}

export async function issueGatewayToken(
  secret: string,
  appId: string,
  userId: string,
  authMethod: GatewayAuthMethod,
  ttlSeconds: number,
): Promise<{ token: string; expiresIn: number }> {
  const expiresIn = Math.min(3600, Math.max(60, ttlSeconds));
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ app: appId, auth_method: authMethod })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + expiresIn)
    .setJti(crypto.randomUUID())
    .sign(key(secret));
  return { token, expiresIn };
}

export async function verifyGatewayToken(
  token: string,
  secret: string,
  expectedAppId: string,
): Promise<GatewayIdentity> {
  try {
    const { payload, protectedHeader } = await jwtVerify(token, key(secret), {
      algorithms: ["HS256"],
      typ: "JWT",
    });
    if (
      protectedHeader.alg !== "HS256" ||
      payload.app !== expectedAppId ||
      typeof payload.sub !== "string" ||
      payload.sub.length === 0 ||
      typeof payload.jti !== "string" ||
      typeof payload.exp !== "number" ||
      (payload.auth_method !== undefined &&
        payload.auth_method !== "dev" &&
        payload.auth_method !== "attest")
    ) {
      throw new Error("Required gateway token claims are missing");
    }
    return {
      appId: expectedAppId,
      userId: payload.sub,
      jti: payload.jti,
      expiresAt: payload.exp,
      authMethod: (payload.auth_method as GatewayAuthMethod | undefined) ?? "attest",
    };
  } catch {
    throw new GatewayError(401, "auth_required", "A valid gateway access token is required");
  }
}

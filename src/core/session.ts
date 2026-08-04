import { jwtVerify, SignJWT } from "jose";
import { GatewayError } from "./errors";

const encoder = new TextEncoder();

export const CONSOLE_COOKIE = "gw_console";
export const CONSOLE_REQUEST_HEADER = "x-console-request";
export const CONSOLE_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function key(secret: string): Uint8Array {
  if (encoder.encode(secret).byteLength < 32) {
    throw new GatewayError(500, "internal_error", "JWT_SECRET must be at least 32 bytes");
  }
  return encoder.encode(secret);
}

export interface ConsoleSession {
  expiresAt: number;
}

/**
 * Console sessions are separate from gateway access tokens: `aud` keeps a leaked
 * gateway token from ever authenticating an admin request and vice versa.
 */
export async function issueConsoleSession(
  secret: string,
  ttlSeconds = CONSOLE_SESSION_TTL_SECONDS,
): Promise<{ token: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlSeconds;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject("admin")
    .setAudience("gateway-console")
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .setJti(crypto.randomUUID())
    .sign(key(secret));
  return { token, expiresAt };
}

export async function verifyConsoleSession(token: string, secret: string): Promise<ConsoleSession> {
  try {
    const { payload, protectedHeader } = await jwtVerify(token, key(secret), {
      algorithms: ["HS256"],
      typ: "JWT",
      audience: "gateway-console",
    });
    if (protectedHeader.alg !== "HS256" || payload.sub !== "admin" || typeof payload.exp !== "number") {
      throw new Error("Required console session claims are missing");
    }
    return { expiresAt: payload.exp };
  } catch {
    throw new GatewayError(401, "auth_required", "A valid console session is required");
  }
}

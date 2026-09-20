import { jwtVerify, SignJWT } from "jose";
import { GatewayError } from "./errors";
import type { GatewayAuthMethod, GatewayIdentity } from "./types";

const encoder = new TextEncoder();

/**
 * How many imported keys to hold. A deployment signs and verifies with one
 * secret; the suites use a handful, and an old one being evicted only costs the
 * import it was saving.
 */
const MAX_KEY_CACHE_ENTRIES = 8;

/**
 * HMAC keys by secret, imported once each. Handing jose the raw bytes makes it
 * import a `CryptoKey` on every sign and every verify, and a verify is on the
 * hot path of every proxied request.
 */
const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(secret: string): Promise<CryptoKey> {
  const bytes = encoder.encode(secret);
  if (bytes.byteLength < 32) {
    throw new GatewayError(500, "internal_error", "JWT_SECRET must be at least 32 bytes");
  }
  return crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function key(secret: string): Promise<CryptoKey> {
  const cached = keyCache.get(secret);
  // A cached secret passed the length check when it was imported.
  if (cached) return cached;
  const imported: Promise<CryptoKey> = importKey(secret).catch((error: unknown) => {
    // An import that failed is not a key: forget it, so the next call tries
    // again instead of being served the same rejection forever.
    if (keyCache.get(secret) === imported) keyCache.delete(secret);
    throw error;
  });
  keyCache.set(secret, imported);
  // Insertion order is eviction order, so the oldest secret goes first.
  if (keyCache.size > MAX_KEY_CACHE_ENTRIES) {
    const oldest = keyCache.keys().next();
    if (!oldest.done) keyCache.delete(oldest.value);
  }
  return imported;
}

export async function issueGatewayToken(
  secret: string,
  appId: string,
  userId: string,
  authMethod: GatewayAuthMethod,
  ttlSeconds: number,
  options: { apiKeyId?: string } = {},
): Promise<{ token: string; expiresIn: number }> {
  const expiresIn = Math.min(3600, Math.max(60, ttlSeconds));
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    app: appId,
    auth_method: authMethod,
    ...(options.apiKeyId === undefined ? {} : { api_key_id: options.apiKeyId }),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + expiresIn)
    .setJti(crypto.randomUUID())
    .sign(await key(secret));
  return { token, expiresIn };
}

export async function verifyGatewayToken(
  token: string,
  secret: string,
  expectedAppId: string,
): Promise<GatewayIdentity> {
  try {
    const { payload, protectedHeader } = await jwtVerify(token, await key(secret), {
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
      (payload.api_key_id !== undefined &&
        (typeof payload.api_key_id !== "string" || payload.api_key_id.length === 0)) ||
      (payload.auth_method !== undefined &&
        payload.auth_method !== "attest" &&
        payload.auth_method !== "api_key")
    ) {
      throw new Error("Required gateway token claims are missing");
    }
    return {
      appId: expectedAppId,
      userId: payload.sub,
      jti: payload.jti,
      expiresAt: payload.exp,
      authMethod: (payload.auth_method as GatewayAuthMethod | undefined) ?? "attest",
      credentialType: "gateway_token",
      ...(typeof payload.api_key_id === "string" ? { apiKeyId: payload.api_key_id } : {}),
    };
  } catch {
    throw new GatewayError(401, "auth_required", "A valid gateway access token is required");
  }
}

import { jwtVerify, SignJWT } from "jose";
import { GatewayError } from "../core/errors";
import { ttlCache } from "../core/ttl-cache";
import type { AuthMethod, GatewayIdentity } from "../core/types";

const encoder = new TextEncoder();

/** How long a gateway token lives; the client runs its exchange again after that. */
const GATEWAY_TOKEN_TTL_SECONDS = 3600;

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
const keyCache = ttlCache<string, Promise<CryptoKey>>({
  name: "jwt-hmac-key",
  // An imported key never goes stale: the cache key is the secret itself, so a
  // rotated secret is a different entry. Only the bound retires anything.
  ttlMs: Number.POSITIVE_INFINITY,
  maxEntries: MAX_KEY_CACHE_ENTRIES,
});

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
    // again instead of being served the same rejection forever. Only if it is
    // still the stored promise — a later import may have replaced it.
    if (keyCache.get(secret) === imported) keyCache.delete(secret);
    throw error;
  });
  // Insertion order is eviction order, so the oldest secret goes first.
  keyCache.set(secret, imported);
  return imported;
}

/** A gateway token for one user of one application, naming the API key it was minted from, if any. */
export async function issueGatewayToken(
  secret: string,
  claims: { appId: string; userId: string; authMethod: AuthMethod; apiKeyId?: string },
): Promise<{ token: string; expiresIn: number }> {
  const expiresIn = GATEWAY_TOKEN_TTL_SECONDS;
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    app: claims.appId,
    auth_method: claims.authMethod,
    ...(claims.apiKeyId === undefined ? {} : { api_key_id: claims.apiKeyId }),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.userId)
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
      (payload.auth_method !== "attest" && payload.auth_method !== "api_key")
    ) {
      throw new Error("Required gateway token claims are missing");
    }
    return {
      appId: expectedAppId,
      userId: payload.sub,
      authMethod: payload.auth_method,
      credentialType: "gateway_token",
      ...(typeof payload.api_key_id === "string" ? { apiKeyId: payload.api_key_id } : {}),
    };
  } catch {
    throw new GatewayError(401, "auth_required", "A valid gateway access token is required");
  }
}

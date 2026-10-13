import { jwtVerify, SignJWT } from "jose";
import { GatewayError } from "../core/errors";
import { ttlCache } from "../core/ttl-cache";
import type { GatewayIdentity } from "../core/types";

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

/**
 * What a gateway token says: one user of one application, and how they proved
 * it — the API key it was minted from, or the App Attest key of the install
 * that signs every request it is sent with.
 */
export type GatewayTokenClaims =
  | { appId: string; userId: string; authMethod: "api_key"; apiKeyId?: string }
  | { appId: string; userId: string; authMethod: "attest"; installId: string };

/** A gateway token for one user of one application. */
export async function issueGatewayToken(
  secret: string,
  claims: GatewayTokenClaims,
): Promise<{ token: string; expiresIn: number }> {
  const expiresIn = GATEWAY_TOKEN_TTL_SECONDS;
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    app: claims.appId,
    auth_method: claims.authMethod,
    ...(claims.authMethod === "api_key" && claims.apiKeyId !== undefined ? { api_key_id: claims.apiKeyId } : {}),
    // The install is the App Attest key id: every request this token is sent
    // with has to carry an assertion that key signed, so a copied token is
    // worth nothing without the device it was minted on.
    ...(claims.authMethod === "attest" ? { install: claims.installId } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.userId)
    .setIssuedAt(now)
    .setExpirationTime(now + expiresIn)
    .setJti(crypto.randomUUID())
    .sign(await key(secret));
  return { token, expiresIn };
}

/**
 * A gateway token's identity, or `401 auth_required`.
 *
 * An attest token must name its install. `legacyAttest` is the one exception:
 * a token minted before installs existed, accepted only for an application
 * under the `bearer_without_assertion` compatibility switch and only on a
 * request that carries no proof, so a shipped 1.x client is not locked out for
 * the hour its token has left after the gateway is updated. It comes back with
 * a null `installId`.
 */
export async function verifyGatewayToken(
  token: string,
  secret: string,
  expectedAppId: string,
  options: { legacyAttest?: boolean } = {},
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
      (payload.auth_method !== "attest" && payload.auth_method !== "api_key") ||
      // An attest token names its install, and only an attest token does.
      (payload.auth_method === "attest"
        ? payload.install === undefined
          ? options.legacyAttest !== true
          : typeof payload.install !== "string" || payload.install.length === 0
        : payload.install !== undefined)
    ) {
      throw new Error("Required gateway token claims are missing");
    }
    return {
      appId: expectedAppId,
      userId: payload.sub,
      authMethod: payload.auth_method,
      credentialType: "gateway_token",
      installId: payload.auth_method === "attest" && typeof payload.install === "string" ? payload.install : null,
      ...(typeof payload.api_key_id === "string" ? { apiKeyId: payload.api_key_id } : {}),
    };
  } catch {
    throw new GatewayError(401, "auth_required", "A valid gateway access token is required");
  }
}

import { jwtVerify, SignJWT } from "jose";
import { GatewayError } from "../core/errors.ts";
import { ttlCache } from "../core/ttl-cache.ts";
import type { GatewayIdentity } from "../core/types.ts";

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

/** The HKDF label of the key a token's share is sealed under (plan step 8j). */
const SHARE_INFO = "agw-key-share";
const SHARE_IV_BYTES = 12;

/**
 * AES-GCM keys for sealing shares into tokens, by `JWT_SECRET`: derived once
 * each, as the HMAC keys above are imported once.
 */
const shareKeyCache = ttlCache<string, Promise<CryptoKey>>({
  name: "jwt-share-key",
  ttlMs: Number.POSITIVE_INFINITY,
  maxEntries: MAX_KEY_CACHE_ENTRIES,
});

function shareKey(secret: string): Promise<CryptoKey> {
  const cached = shareKeyCache.get(secret);
  if (cached) return cached;
  const derived: Promise<CryptoKey> = (async () => {
    const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(SHARE_INFO) },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  })().catch((error: unknown) => {
    if (shareKeyCache.get(secret) === derived) shareKeyCache.delete(secret);
    throw error;
  });
  shareKeyCache.set(secret, derived);
  return derived;
}

/** What a sealed share is bound to: the one token it was sealed into. */
function shareBinding(jti: string, appId: string, userId: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify([SHARE_INFO, jti, appId, userId]));
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(text)) throw new Error("not base64url");
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * The app's credential, sealed into its token: AES-GCM under a key derived
 * from `JWT_SECRET`, bound to the token's `jti`, `app` and `sub`. A token can
 * be read by whoever holds it, so the credential is never a plain claim.
 */
async function sealShare(secret: string, share: string, binding: Uint8Array<ArrayBuffer>): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(SHARE_IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: binding }, await shareKey(secret), encoder.encode(share)),
  );
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return toBase64Url(out);
}

async function openShare(secret: string, claim: string, binding: Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = fromBase64Url(claim);
  if (bytes.length <= SHARE_IV_BYTES + 16) throw new Error("sealed share too short");
  const opened = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, SHARE_IV_BYTES), additionalData: binding },
    await shareKey(secret),
    bytes.subarray(SHARE_IV_BYTES),
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(opened);
}

/**
 * What a gateway token says: one user of one application, and how they proved
 * it — the API key it was minted from, or the App Attest key of the install
 * it was minted for.
 *
 * `keyShare`, for an account with split keys on (plan step 8j), is the app's
 * credential that opens its keyslot: the app key itself, or the iOS share
 * the install sent. It is sealed into the token, never written in it plainly.
 */
export type GatewayTokenClaims =
  | { appId: string; userId: string; authMethod: "api_key"; apiKeyId?: string; keyShare?: string }
  | {
    appId: string;
    userId: string;
    authMethod: "attest";
    installId: string;
    /** The Apple Account the exchange's App Store transaction named; absent or null where it named none. */
    appleAccountId?: string | null;
    keyShare?: string;
  };

/** A gateway token for one user of one application. */
export async function issueGatewayToken(
  secret: string,
  claims: GatewayTokenClaims,
): Promise<{ token: string; expiresIn: number }> {
  const expiresIn = GATEWAY_TOKEN_TTL_SECONDS;
  const now = Math.floor(Date.now() / 1000);
  const jti = crypto.randomUUID();
  const keyShare =
    claims.keyShare === undefined ? undefined : await sealShare(secret, claims.keyShare, shareBinding(jti, claims.appId, claims.userId));
  const token = await new SignJWT({
    app: claims.appId,
    auth_method: claims.authMethod,
    ...(claims.authMethod === "api_key" && claims.apiKeyId !== undefined ? { api_key_id: claims.apiKeyId } : {}),
    // The install is the App Attest key id: limits and budgets count per
    // install, and where the application verifies every request, each one
    // has to carry an assertion that key signed, so a copied token is worth
    // nothing without the device it was minted on.
    ...(claims.authMethod === "attest" ? { install: claims.installId } : {}),
    // Signed into the token rather than looked up per request: Apple's
    // signature proved it once, at the exchange, and the token lives an hour.
    ...(claims.authMethod === "attest" && typeof claims.appleAccountId === "string"
      ? { apple_account: claims.appleAccountId }
      : {}),
    ...(keyShare === undefined ? {} : { key_share: keyShare }),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.userId)
    .setIssuedAt(now)
    .setExpirationTime(now + expiresIn)
    .setJti(jti)
    .sign(await key(secret));
  return { token, expiresIn };
}

/**
 * A gateway token's identity, or `401 auth_required`. See
 * {@link verifyGatewayTokenAndShare}, which also opens the app's credential
 * a token for a split-key account carries.
 */
export async function verifyGatewayToken(
  token: string,
  secret: string,
  expectedAppId: string,
): Promise<GatewayIdentity> {
  return (await verifyGatewayTokenAndShare(token, secret, expectedAppId)).identity;
}

/**
 * A gateway token's identity, and the app's credential sealed into it (null
 * when it carries none), or `401 auth_required`.
 *
 * An attest token must name its install, in either `verify_on` mode: the
 * install is what its limits, budget and usage are counted by, and a token
 * without one (as the gateway minted them before installs existed) is refused
 * like any other malformed token. An API-key token names none.
 */
export async function verifyGatewayTokenAndShare(
  token: string,
  secret: string,
  expectedAppId: string,
): Promise<{ identity: GatewayIdentity; share: string | null }> {
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
        ? typeof payload.install !== "string" || payload.install.length === 0
        : payload.install !== undefined) ||
      // An Apple Account is optional on an attest token, and never on another.
      (payload.apple_account !== undefined &&
        (payload.auth_method !== "attest" ||
          typeof payload.apple_account !== "string" ||
          payload.apple_account.length === 0)) ||
      (payload.key_share !== undefined && typeof payload.key_share !== "string")
    ) {
      throw new Error("Required gateway token claims are missing");
    }
    const fields = {
      appId: expectedAppId,
      userId: payload.sub,
      credentialType: "gateway_token" as const,
      ...(typeof payload.api_key_id === "string" ? { apiKeyId: payload.api_key_id } : {}),
    };
    const identity: GatewayIdentity = payload.auth_method === "attest"
      ? {
        ...fields,
        authMethod: "attest",
        installId: payload.install as string,
        appleAccountId: typeof payload.apple_account === "string" ? payload.apple_account : null,
      }
      : { ...fields, authMethod: "api_key", installId: null, appleAccountId: null };
    const share =
      typeof payload.key_share === "string"
        ? await openShare(secret, payload.key_share, shareBinding(payload.jti, expectedAppId, payload.sub))
        : null;
    return { identity, share };
  } catch {
    throw new GatewayError(401, "auth_required", "A valid gateway access token is required");
  }
}

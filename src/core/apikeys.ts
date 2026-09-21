import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { database, type Database } from "../db";
import { appApiKey } from "../db/schema";
import { GatewayError } from "./errors";
import { ttlCache } from "./ttl-cache";
import type { GatewayIdentity } from "./types";

interface ApiKeyRecord {
  id: string;
  appId: string;
}

type ApiKeyCacheKey = `hash:${string}` | `id:${string}`;

const encoder = new TextEncoder();
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
const HIT_TTL_MS = 60_000;
const MISS_TTL_MS = 10_000;
const MAX_API_KEY_CACHE_ENTRIES = 10_000;

/**
 * Resolved credentials, `null` for one that resolved to nothing.
 *
 * Misses are cached too, so an unauthenticated caller controls the keys of this
 * cache. It is bounded and evicts insertion-oldest first, and misses are stored
 * with a much shorter TTL than hits so a freshly created key is not refused for
 * a whole minute.
 *
 * Exported for the tests that read its keys and narrow its bound; nothing in
 * the Worker reads it but this file.
 */
export const apiKeyCache = ttlCache<ApiKeyCacheKey, ApiKeyRecord | null>({
  name: "api-key",
  ttlMs: HIT_TTL_MS,
  maxEntries: MAX_API_KEY_CACHE_ENTRIES,
});

/**
 * How often a key's `last_used_at` is worth rewriting, and the interval the
 * statement in {@link markApiKeyUsed} matches in SQL.
 */
const MARK_USED_INTERVAL_MS = 3_600_000;
/**
 * Whether this isolate has already issued that statement for a key inside the
 * current interval — the entry is the claim, and its expiry is the interval
 * elapsing. Without it the recorder pays a D1 round trip on every single
 * request to be told the row is already current, which it is for fifty-nine
 * minutes out of sixty.
 *
 * Remembering it per isolate does not make the column any less accurate: every
 * isolate still issues at most one statement an hour per key, and the SQL
 * predicate makes all but the first of those a no-op, so `last_used_at` is
 * still within an hour of the truth however many isolates are serving the key.
 *
 * The ids come back from D1, so no caller invents them, but a deployment with
 * many keys still accumulates entries: it is bounded like the cache above and
 * evicts insertion-oldest first. Losing an entry costs one no-op UPDATE.
 */
const lastMarkedAt = ttlCache<string, true>({
  name: "api-key-marked",
  ttlMs: MARK_USED_INTERVAL_MS,
  maxEntries: MAX_API_KEY_CACHE_ENTRIES,
});

function randomString(length: number, alphabet: string): string {
  const limit = 256 - (256 % alphabet.length);
  let result = "";
  while (result.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(Math.max(32, length - result.length)));
    for (const byte of bytes) {
      if (byte >= limit) continue;
      result += alphabet[byte % alphabet.length]!;
      if (result.length === length) break;
    }
  }
  return result;
}

export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(key));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function generateApiKey(): Promise<{
  id: string;
  key: string;
  keyHash: string;
  keyPrefix: string;
}> {
  const key = `agw_${randomString(48, BASE62)}`;
  return {
    id: `key_${randomString(20, BASE36)}`,
    key,
    keyHash: await hashApiKey(key),
    keyPrefix: key.slice(0, 12),
  };
}

/*
 * Both lookups take the database rather than the environment, because which
 * database they read stays explicit at the call site. Both cached and uncached
 * security lookups use the authoritative primary; the cache TTL is the only
 * intentional revocation window.
 */
async function lookupApiKeyHash(db: Database, hash: string): Promise<ApiKeyRecord | null> {
  const row = await db.query.appApiKey.findFirst({
    columns: { id: true, appId: true },
    where: and(eq(appApiKey.keyHash, hash), eq(appApiKey.status, "active")),
  });
  return row ? { id: row.id, appId: row.appId } : null;
}

async function lookupApiKeyId(db: Database, id: string): Promise<ApiKeyRecord | null> {
  const row = await db.query.appApiKey.findFirst({
    columns: { id: true, appId: true },
    where: and(eq(appApiKey.id, id), eq(appApiKey.status, "active")),
  });
  return row ? { id: row.id, appId: row.appId } : null;
}

/**
 * Reads the active key straight from D1. Used by the token-exchange path, where
 * revocation must take effect immediately, so nothing caches its answer.
 */
export async function lookupApiKeyUncached(
  env: Env,
  credential: string,
): Promise<ApiKeyRecord | null> {
  return lookupApiKeyHash(database(env.DB), await hashApiKey(credential));
}

async function lookupCachedApiKey(
  cacheKey: ApiKeyCacheKey,
  lookup: () => Promise<ApiKeyRecord | null>,
): Promise<ApiKeyRecord | null> {
  const now = Date.now();
  const cached = apiKeyCache.peek(cacheKey);
  if (cached && cached.expiresAt > now) {
    // Re-storing on its own window keeps the cache in least-recently-used
    // order without moving the expiry a hit is serving under.
    apiKeyCache.set(cacheKey, cached.value, {
      storedAt: cached.storedAt,
      ttlMs: cached.expiresAt - cached.storedAt,
    });
    return cached.value;
  }

  apiKeyCache.delete(cacheKey);
  const lookupStartedAt = Date.now();
  const value = await lookup();
  apiKeyCache.set(cacheKey, value, {
    // A slow read must not add its own duration to the revocation window.
    storedAt: lookupStartedAt,
    ttlMs: value ? HIT_TTL_MS : MISS_TTL_MS,
  });
  return value;
}

/**
 * Resolves an active key ID through the same short, bounded cache used for raw
 * API-key authentication. Gateway tokens carry this ID so revocation can take
 * effect without waiting for the token itself to expire.
 */
export async function lookupActiveApiKeyById(
  env: Env,
  id: string,
): Promise<ApiKeyRecord | null> {
  return lookupCachedApiKey(`id:${id}`, () => lookupApiKeyId(database(env.DB), id));
}

export async function verifyApiKey(
  credential: string,
  env: Env,
  expectedAppId: string,
  userId: string | null,
): Promise<GatewayIdentity> {
  const hash = await hashApiKey(credential);
  const value = await lookupCachedApiKey(
    `hash:${hash}`,
    () => lookupApiKeyHash(database(env.DB), hash),
  );
  if (!value || value.appId !== expectedAppId) {
    throw new GatewayError(401, "auth_required", "A valid gateway API key is required");
  }
  return {
    appId: expectedAppId,
    /*
     * Carried through as given, `null` included. An application with no
     * end-user source has no user, and standing the key's own id in for one
     * would put a synthetic person in the usage table, the user list and the
     * limiter — which is the reading this whole shape exists to refuse.
     * `apiKeyId` below already records which credential served the request.
     */
    userId,
    jti: value.id,
    expiresAt: Number.MAX_SAFE_INTEGER,
    authMethod: "api_key",
    credentialType: "api_key",
    apiKeyId: value.id,
  };
}

export async function markApiKeyUsed(env: Env, apiKeyId: string): Promise<void> {
  // A fresh entry is this isolate saying it has already issued the statement
  // inside the current interval; the entry expiring is the interval elapsing.
  if (lastMarkedAt.get(apiKeyId)) return;
  // Claimed before the statement is awaited, so a burst of concurrent requests
  // on this isolate issues one UPDATE between them rather than one each.
  lastMarkedAt.set(apiKeyId, true);
  try {
    await database(env.DB)
      .update(appApiKey)
      .set({ lastUsedAt: sql`datetime('now')` })
      .where(
        and(
          eq(appApiKey.id, apiKeyId),
          // The same hour as MARK_USED_INTERVAL_MS, stated again here because
          // this is what keeps the column accurate across isolates: whichever
          // of them gets here first writes, and the rest find the row current.
          or(
            isNull(appApiKey.lastUsedAt),
            lt(appApiKey.lastUsedAt, sql`datetime('now', '-1 hour')`),
          ),
        ),
      );
  } catch (error) {
    // The claim is given back, because the caller retries this operation and a
    // retry that found its own claim standing would return without writing
    // anything and report the step as landed. Nothing here is lost by letting
    // the next attempt reach D1: the statement is idempotent.
    lastMarkedAt.delete(apiKeyId);
    throw error;
  }
}

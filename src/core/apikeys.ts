import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { database } from "../db";
import { appApiKey } from "../db/schema";
import { GatewayError } from "./errors";
import type { GatewayIdentity } from "./types";

interface ApiKeyRecord {
  id: string;
  appId: string;
}

interface CachedApiKey {
  expiresAt: number;
  value: ApiKeyRecord | null;
}

// Misses are cached too, so an unauthenticated caller controls the keys of this
// map. It is bounded and evicts insertion-oldest first, and misses expire much
// sooner than hits so a freshly created key is not refused for a whole minute.
const apiKeyCache = new Map<string, CachedApiKey>();
const encoder = new TextEncoder();
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
const HIT_TTL_MS = 60_000;
const MISS_TTL_MS = 10_000;
const MAX_API_KEY_CACHE_ENTRIES = 10_000;

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

async function lookupApiKeyHash(env: Env, hash: string): Promise<ApiKeyRecord | null> {
  const row = await database(env.DB).query.appApiKey.findFirst({
    columns: { id: true, appId: true },
    where: and(eq(appApiKey.keyHash, hash), eq(appApiKey.status, "active")),
  });
  return row ? { id: row.id, appId: row.appId } : null;
}

/**
 * Reads the active key straight from D1. Used by the token-exchange path, where
 * revocation must take effect immediately.
 */
export async function lookupApiKeyUncached(
  env: Env,
  credential: string,
): Promise<ApiKeyRecord | null> {
  return lookupApiKeyHash(env, await hashApiKey(credential));
}

function rememberApiKey(hash: string, value: ApiKeyRecord | null): void {
  // Re-inserting keeps the map in least-recently-used order.
  apiKeyCache.delete(hash);
  apiKeyCache.set(hash, {
    expiresAt: Date.now() + (value ? HIT_TTL_MS : MISS_TTL_MS),
    value,
  });
  if (apiKeyCache.size > MAX_API_KEY_CACHE_ENTRIES) {
    const oldest = apiKeyCache.keys().next();
    if (!oldest.done) apiKeyCache.delete(oldest.value);
  }
}

export async function verifyApiKey(
  credential: string,
  env: Env,
  expectedAppId: string,
  userId: string | null,
): Promise<GatewayIdentity> {
  const hash = await hashApiKey(credential);
  const cached = apiKeyCache.get(hash);
  let value: ApiKeyRecord | null;
  if (cached && cached.expiresAt > Date.now()) {
    value = cached.value;
    apiKeyCache.delete(hash);
    apiKeyCache.set(hash, cached);
  } else {
    value = await lookupApiKeyHash(env, hash);
    rememberApiKey(hash, value);
  }
  if (!value || value.appId !== expectedAppId) {
    throw new GatewayError(401, "auth_required", "A valid gateway API key is required");
  }
  return {
    appId: expectedAppId,
    userId: userId ?? value.id,
    jti: value.id,
    expiresAt: Number.MAX_SAFE_INTEGER,
    authMethod: "api_key",
    credentialType: "api_key",
    apiKeyId: value.id,
  };
}

export async function markApiKeyUsed(env: Env, apiKeyId: string): Promise<void> {
  await database(env.DB)
    .update(appApiKey)
    .set({ lastUsedAt: sql`datetime('now')` })
    .where(
      and(
        eq(appApiKey.id, apiKeyId),
        or(
          isNull(appApiKey.lastUsedAt),
          lt(appApiKey.lastUsedAt, sql`datetime('now', '-1 hour')`),
        ),
      ),
    );
}

export function clearApiKeyCache(): void {
  apiKeyCache.clear();
}

/** Cached credential hashes, oldest first. Exposed for tests. */
export function apiKeyCacheHashes(): string[] {
  return [...apiKeyCache.keys()];
}

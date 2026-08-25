import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { database } from "../db";
import { appApiKey } from "../db/schema";
import { GatewayError } from "./errors";
import type { GatewayIdentity } from "./types";

interface CachedApiKey {
  expiresAt: number;
  value: { id: string; appId: string } | null;
}

const apiKeyCache = new Map<string, CachedApiKey>();
const encoder = new TextEncoder();
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
const CONFIG_CACHE_TTL_MS = 60_000;

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

export async function verifyApiKey(
  credential: string,
  env: Env,
  expectedAppId: string,
  userId: string | null,
): Promise<GatewayIdentity> {
  const hash = await hashApiKey(credential);
  let resolved = apiKeyCache.get(hash);
  if (!resolved || resolved.expiresAt <= Date.now()) {
    const row = await database(env.DB).query.appApiKey.findFirst({
      columns: { id: true, appId: true },
      where: and(eq(appApiKey.keyHash, hash), eq(appApiKey.status, "active")),
    });
    resolved = {
      expiresAt: Date.now() + CONFIG_CACHE_TTL_MS,
      value: row ? { id: row.id, appId: row.appId } : null,
    };
    apiKeyCache.set(hash, resolved);
  }
  if (!resolved.value || resolved.value.appId !== expectedAppId) {
    throw new GatewayError(401, "auth_required", "A valid gateway API key is required");
  }
  return {
    appId: expectedAppId,
    userId: userId ?? resolved.value.id,
    jti: resolved.value.id,
    expiresAt: Number.MAX_SAFE_INTEGER,
    authMethod: "api_key",
    apiKeyId: resolved.value.id,
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

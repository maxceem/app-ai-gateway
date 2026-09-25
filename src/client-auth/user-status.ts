import { ttlCache } from "../core/ttl-cache";

const BLOCK_CACHE_TTL_MS = 10_000;

/** A bounded, isolate-local admission cache. Entries are pending reads from D1. */
export const blockedUserCache = ttlCache<string, Promise<boolean>>({
  name: "blocked-user",
  ttlMs: BLOCK_CACHE_TTL_MS,
  maxEntries: 50_000,
});

const cacheKey = (appId: string, userId: string): string => JSON.stringify([appId, userId]);

/** Read the sole authoritative block status from the D1 primary. */
export async function appUserBlocked(db: D1Database, appId: string, userId: string): Promise<boolean> {
  const row = await db.prepare("SELECT status FROM app_user WHERE app_id = ? AND id = ?")
    .bind(appId, userId).first<{ status: "active" | "blocked" }>();
  // A missing row is not an administrative block; authentication is decided elsewhere.
  return row?.status === "blocked";
}

/** Admission tolerates at most ten seconds of staleness across isolates. */
export function cachedAppUserBlocked(db: D1Database, appId: string, userId: string): Promise<boolean> {
  const key = cacheKey(appId, userId);
  const cached = blockedUserCache.get(key);
  if (cached !== undefined) return cached;

  // Store before awaiting, so concurrent requests share this read. The TTL is
  // measured from its start. An invalidation cannot be undone by completion.
  const pending = appUserBlocked(db, appId, userId);
  blockedUserCache.set(key, pending);
  void pending.catch(() => {
    // A newer request or invalidation may have replaced this entry meanwhile.
    if (blockedUserCache.peek(key)?.value === pending) blockedUserCache.delete(key);
  });
  return pending;
}

export function invalidateBlockedCache(appId: string, userId: string): void {
  blockedUserCache.delete(cacheKey(appId, userId));
}

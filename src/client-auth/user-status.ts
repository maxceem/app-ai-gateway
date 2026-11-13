import { readOrKnown, STALE_READ_MAX_MS } from "../core/stale-read";
import { ttlCache } from "../core/ttl-cache";

const BLOCK_CACHE_TTL_MS = 10_000;

/** A bounded, isolate-local admission cache. Entries are pending reads from D1. */
export const blockedUserCache = ttlCache<string, Promise<boolean>>({
  name: "blocked-user",
  ttlMs: BLOCK_CACHE_TTL_MS,
  maxEntries: 50_000,
});

/**
 * The last status D1 actually answered, kept past the admission cache's TTL so
 * a D1 stall can be ridden out with it; see `../core/stale-read`. A user known
 * to be blocked stays refused.
 */
const lastKnownBlocked = ttlCache<string, boolean>({
  name: "blocked-user-last-known",
  ttlMs: STALE_READ_MAX_MS,
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
  const known = lastKnownBlocked.peek(key);
  const cached = blockedUserCache.get(key);
  if (cached !== undefined) {
    // A read that has answered is the answer. One still in flight — shared
    // with the request that started it — is waited for no longer than that
    // request waits, so a stalled D1 holds no caller beyond the budget.
    if (known === undefined || known.storedAt >= blockedUserCache.peek(key)!.storedAt) return cached;
    return readOrKnown("user_status", known, () => cached);
  }

  return readOrKnown("user_status", known, () => {
    // Store before awaiting, so concurrent requests share this read. The TTL is
    // measured from its start. An invalidation cannot be undone by completion.
    const startedAt = Date.now();
    const pending = appUserBlocked(db, appId, userId);
    blockedUserCache.set(key, pending, { storedAt: startedAt });
    void pending.then(
      (blocked) => {
        // Only this entry's own answer, so an invalidation meanwhile wins.
        if (blockedUserCache.peek(key)?.value === pending) lastKnownBlocked.set(key, blocked, { storedAt: startedAt });
      },
      () => {
        // A newer request or invalidation may have replaced this entry meanwhile.
        if (blockedUserCache.peek(key)?.value === pending) blockedUserCache.delete(key);
      },
    );
    return pending;
  });
}

export function invalidateBlockedCache(appId: string, userId: string): void {
  blockedUserCache.delete(cacheKey(appId, userId));
  lastKnownBlocked.delete(cacheKey(appId, userId));
}

/**
 * The one in-isolate cache.
 *
 * Every warm map the Worker keeps is the same three decisions — how long a
 * value stays fresh, how many of them to hold, and what to drop when there are
 * too many — and this is that shape once.
 *
 * A caller owns the *policy*: the TTL, the bound, and why the bound is safe.
 * The arithmetic, the eviction and being emptied between tests are this
 * module's — a cache registers itself here at creation, so
 * {@link clearAllCaches} reaches it whether or not anyone remembered it
 * exists.
 */

export interface TtlCacheEntry<V> {
  value: V;
  /** When this entry was stored, which is the instant its window is measured from. */
  storedAt: number;
  expiresAt: number;
}

export interface TtlCache<K, V> {
  /** The value if it is still fresh at `now`, else undefined. */
  get(key: K, now?: number): V | undefined;
  /** The entry whether or not it has expired: for stale-on-error readers and for tests. */
  peek(key: K): TtlCacheEntry<V> | undefined;
  /**
   * Stores under the cache's TTL unless `ttlMs` overrides it; `storedAt` lets a
   * slow read not extend its own window. Re-inserting refreshes the entry's
   * place in eviction order.
   */
  set(key: K, value: V, options?: { ttlMs?: number; storedAt?: number }): void;
  delete(key: K): boolean;
  clear(): void;
  /** Keys, insertion-oldest first. */
  keys(): K[];
  readonly size: number;
  /** Narrows the bound; restored by {@link clearAllCaches}. Exposed for tests only. */
  setLimit(limit: number): void;
}

/**
 * Every cache created here, so that emptying them is one call rather than a
 * hand-kept list that a new cache can be left out of.
 */
const registry = new Set<{ reset(): void }>();

export function ttlCache<K, V>(options: {
  /** For the registry and for debugging; nothing reads it as an identity. */
  name: string;
  ttlMs: number;
  maxEntries: number;
}): TtlCache<K, V> {
  const entries = new Map<K, TtlCacheEntry<V>>();
  let limit = options.maxEntries;

  const cache: TtlCache<K, V> = {
    get(key, now = Date.now()) {
      const entry = entries.get(key);
      if (entry === undefined || entry.expiresAt <= now) return undefined;
      return entry.value;
    },
    peek(key) {
      return entries.get(key);
    },
    set(key, value, put = {}) {
      const storedAt = put.storedAt ?? Date.now();
      // Deleting first keeps the map in insertion order, so eviction below
      // drops the entry that has been there longest rather than one that was
      // just refreshed.
      entries.delete(key);
      entries.set(key, { value, storedAt, expiresAt: storedAt + (put.ttlMs ?? options.ttlMs) });
      if (entries.size > limit) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
    },
    delete(key) {
      return entries.delete(key);
    },
    clear() {
      entries.clear();
    },
    keys() {
      return [...entries.keys()];
    },
    get size() {
      return entries.size;
    },
    setLimit(next) {
      limit = next;
    },
  };

  registry.add({
    reset() {
      entries.clear();
      limit = options.maxEntries;
    },
  });
  return cache;
}

/**
 * Empties every cache created through {@link ttlCache} and restores every
 * bound. The one call a test suite needs: a suite shares one isolate with the
 * rest of its barrel, so a row a test rewrites straight in D1 is otherwise
 * still answered from whatever an earlier file left warm.
 */
export function clearAllCaches(): void {
  for (const cache of registry) cache.reset();
}

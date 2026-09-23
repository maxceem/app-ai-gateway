import { describe, expect, it } from "vitest";
import { clearAllCaches, ttlCache } from "../src/core/ttl-cache";

describe("ttl cache", () => {
  it("serves a value while it is fresh and stops at its expiry", () => {
    const cache = ttlCache<string, number>({ name: "test-fresh", ttlMs: 1_000, maxEntries: 10 });
    const storedAt = 10_000;
    cache.set("a", 1, { storedAt });

    expect(cache.get("a", storedAt)).toBe(1);
    expect(cache.get("a", storedAt + 999)).toBe(1);
    // The expiry instant is already past: a window of exactly the TTL is what
    // every caller here means by fresh.
    expect(cache.get("a", storedAt + 1_000)).toBeUndefined();
    expect(cache.get("missing", storedAt)).toBeUndefined();
  });

  it("peeks an expired entry, which is what a stale-on-error reader needs", () => {
    const cache = ttlCache<string, string>({ name: "test-peek", ttlMs: 1_000, maxEntries: 10 });
    cache.set("a", "kept", { storedAt: 1_000 });

    expect(cache.get("a")).toBeUndefined();
    expect(cache.peek("a")).toEqual({ value: "kept", storedAt: 1_000, expiresAt: 2_000 });
    expect(cache.peek("missing")).toBeUndefined();
  });

  it("takes a per-put TTL and a storedAt the caller chose", () => {
    const cache = ttlCache<string, string>({ name: "test-put", ttlMs: 60_000, maxEntries: 10 });
    // A slow read must not add its own duration to the window it is storing.
    const lookupStartedAt = Date.now() - 5_000;
    cache.set("hit", "value", { storedAt: lookupStartedAt });
    cache.set("miss", "value", { storedAt: lookupStartedAt, ttlMs: 1_000 });

    expect(cache.peek("hit")?.expiresAt).toBe(lookupStartedAt + 60_000);
    expect(cache.get("hit")).toBe("value");
    expect(cache.peek("miss")?.expiresAt).toBe(lookupStartedAt + 1_000);
    expect(cache.get("miss")).toBeUndefined();
  });

  it("holds its bound and evicts the oldest entry first", () => {
    const cache = ttlCache<string, number>({ name: "test-bound", ttlMs: 60_000, maxEntries: 3 });
    for (const [index, key] of ["a", "b", "c", "d"].entries()) cache.set(key, index);

    expect(cache.keys()).toEqual(["b", "c", "d"]);
    expect(cache.size).toBe(3);
    expect(cache.get("a")).toBeUndefined();
  });

  it("moves a re-inserted entry to the back of the eviction order", () => {
    const cache = ttlCache<string, number>({ name: "test-refresh", ttlMs: 60_000, maxEntries: 3 });
    for (const [index, key] of ["a", "b", "c"].entries()) cache.set(key, index);
    cache.set("a", 99);
    cache.set("d", 3);

    // "a" was stored first but re-inserted last, so "b" is now the oldest.
    expect(cache.keys()).toEqual(["c", "a", "d"]);
    expect(cache.get("a")).toBe(99);
  });

  it("deletes one entry and clears every entry", () => {
    const cache = ttlCache<string, number>({ name: "test-delete", ttlMs: 60_000, maxEntries: 10 });
    cache.set("a", 1);
    cache.set("b", 2);

    expect(cache.delete("a")).toBe(true);
    expect(cache.delete("a")).toBe(false);
    expect(cache.keys()).toEqual(["b"]);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("narrows its bound for a test and gets the production one back from clearAllCaches", () => {
    const cache = ttlCache<string, number>({ name: "test-limit", ttlMs: 60_000, maxEntries: 5 });
    cache.setLimit(2);
    for (const [index, key] of ["a", "b", "c"].entries()) cache.set(key, index);
    expect(cache.keys()).toEqual(["b", "c"]);

    clearAllCaches();
    for (const [index, key] of ["a", "b", "c"].entries()) cache.set(key, index);
    expect(cache.keys()).toEqual(["a", "b", "c"]);
  });

  /**
   * The reason nothing keeps a list of caches to empty: a cache created after
   * the suite started is still reached, so a cache added to the Worker tomorrow
   * cannot be left out of the one call every suite makes.
   */
  it("clears a cache created after another one", () => {
    const first = ttlCache<string, number>({ name: "test-first", ttlMs: 60_000, maxEntries: 10 });
    first.set("a", 1);
    const second = ttlCache<string, number>({ name: "test-second", ttlMs: 60_000, maxEntries: 10 });
    second.set("a", 2);

    clearAllCaches();

    expect(first.size).toBe(0);
    expect(second.size).toBe(0);
  });

  it("never expires an entry stored with an infinite TTL", () => {
    const cache = ttlCache<string, string>({
      name: "test-infinite",
      ttlMs: Number.POSITIVE_INFINITY,
      maxEntries: 2,
    });
    cache.set("a", "key", { storedAt: 0 });

    expect(cache.get("a", Number.MAX_SAFE_INTEGER)).toBe("key");
    expect(cache.peek("a")?.expiresAt).toBe(Number.POSITIVE_INFINITY);
  });
});

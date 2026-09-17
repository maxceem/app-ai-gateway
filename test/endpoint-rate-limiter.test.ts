import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ENDPOINT_RATE_LIMITS,
  enforceEndpointRateLimit,
} from "../src/core/endpoint-rate-limit";
import type { EndpointRateLimiter } from "../src/do/EndpointRateLimiter";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// Keep Durable Object alarms ahead of the real runtime scheduler while each
// test controls Date.now(). Ten seconds into the minute preserves Retry-After: 50.
const ANCHOR = Math.floor((Date.now() + DAY) / MINUTE) * MINUTE + 10_000;

afterEach(() => vi.useRealTimers());

describe("EndpointRateLimiter", () => {
  it("atomically admits exactly the limit under concurrency", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR);
    const limiter = env.ENDPOINT_RATE_LIMITER.getByName(
      `endpoint-rate:test:concurrent:${crypto.randomUUID()}`,
    );
    const results = await Promise.all(
      Array.from({ length: 30 }, () => limiter.check({ limit: 10, windowMs: MINUTE })),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(10);
    expect(
      results
        .filter((result) => result.allowed)
        .map((result) => result.allowed ? result.count : 0)
        .sort((left, right) => left - right),
    ).toEqual(Array.from({ length: 10 }, (_, index) => index + 1));
  });

  it("isolates subjects and starts a fresh count at the fixed-window boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR);
    const suffix = crypto.randomUUID();
    const first = env.ENDPOINT_RATE_LIMITER.getByName(`endpoint-rate:test:first:${suffix}`);
    const second = env.ENDPOINT_RATE_LIMITER.getByName(`endpoint-rate:test:second:${suffix}`);

    expect(await first.check({ limit: 1, windowMs: MINUTE })).toMatchObject({ allowed: true });
    expect(await first.check({ limit: 1, windowMs: MINUTE })).toMatchObject({ allowed: false });
    expect(await second.check({ limit: 1, windowMs: MINUTE })).toMatchObject({ allowed: true });

    vi.setSystemTime(Math.ceil(ANCHOR / MINUTE) * MINUTE);
    expect(await first.check({ limit: 1, windowMs: MINUTE })).toEqual({
      allowed: true,
      count: 1,
    });
  });

  it("recovers its counter after the object instance is evicted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR);
    const name = `endpoint-rate:test:eviction:${crypto.randomUUID()}`;
    const limiter = env.ENDPOINT_RATE_LIMITER.getByName(name);
    expect(await limiter.check({ limit: 2, windowMs: MINUTE })).toMatchObject({ allowed: true });
    expect(await limiter.check({ limit: 2, windowMs: MINUTE })).toMatchObject({ allowed: true });

    await evictDurableObject(limiter);

    expect(
      await env.ENDPOINT_RATE_LIMITER.getByName(name).check({ limit: 2, windowMs: MINUTE }),
    ).toMatchObject({ allowed: false });
  });

  it("does not write or reschedule when an attempt is already denied", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR);
    const limiter = env.ENDPOINT_RATE_LIMITER.getByName(
      `endpoint-rate:test:denied-write:${crypto.randomUUID()}`,
    );
    await limiter.check({ limit: 1, windowMs: MINUTE });
    let writes = 0;

    await runInDurableObject(limiter, async (instance, state) => {
      const originalTransaction = state.storage.transaction;
      const runTransaction = originalTransaction.bind(state.storage);
      state.storage.transaction = (closure) => runTransaction(async (transaction) => {
        const observed = new Proxy(transaction, {
          get(target, property) {
            const value = Reflect.get(target, property);
            if (typeof value !== "function") return value;
            if (["put", "delete", "setAlarm", "deleteAlarm"].includes(String(property))) {
              return (...args: unknown[]) => {
                writes++;
                return Reflect.apply(value, target, args);
              };
            }
            return value.bind(target);
          },
        });
        return closure(observed);
      });

      try {
        expect(
          await (instance as EndpointRateLimiter).check({ limit: 1, windowMs: MINUTE }),
        ).toMatchObject({ allowed: false });
      } finally {
        state.storage.transaction = originalTransaction;
      }
    });
    expect(writes).toBe(0);
  });

  it("fully deletes dormant storage and leaves no recurring alarm", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR);
    const limiter = env.ENDPOINT_RATE_LIMITER.getByName(
      `endpoint-rate:test:cleanup:${crypto.randomUUID()}`,
    );
    await limiter.check({ limit: 1, windowMs: MINUTE });
    vi.setSystemTime(Math.ceil(ANCHOR / MINUTE) * MINUTE);

    expect(await runDurableObjectAlarm(limiter)).toBe(true);
    await runInDurableObject(limiter, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .toArray(),
      ).toEqual([]);
      expect(await state.storage.list()).toEqual(new Map());
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(await runDurableObjectAlarm(limiter)).toBe(false);
  });

  it("does not let a delayed old alarm erase a newer window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR);
    const limiter = env.ENDPOINT_RATE_LIMITER.getByName(
      `endpoint-rate:test:delayed-alarm:${crypto.randomUUID()}`,
    );
    await limiter.check({ limit: 2, windowMs: MINUTE });

    const nextWindow = Math.ceil(ANCHOR / MINUTE) * MINUTE;
    vi.setSystemTime(nextWindow + 1);
    expect(await limiter.check({ limit: 2, windowMs: MINUTE })).toEqual({
      allowed: true,
      count: 1,
    });
    await runInDurableObject(limiter, async (_instance, state) => {
      await state.storage.setAlarm(Date.now());
    });

    expect(await runDurableObjectAlarm(limiter)).toBe(true);
    await runInDurableObject(limiter, async (_instance, state) => {
      expect(await state.storage.get("counter")).toMatchObject({
        windowStart: nextWindow,
        count: 1,
      });
      expect(await state.storage.getAlarm()).toBe(nextWindow + MINUTE);
    });
  });

  it("rejects invalid trusted policies before storing a counter", async () => {
    const limiter = env.ENDPOINT_RATE_LIMITER.getByName(
      `endpoint-rate:test:invalid:${crypto.randomUUID()}`,
    );
    const messages = await runInDurableObject(limiter, async (instance) => {
      const endpointLimiter = instance as EndpointRateLimiter;
      const invalid = async (limit: number, windowMs: number) => {
        try {
          await endpointLimiter.check({ limit, windowMs });
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      };
      return [
        await invalid(0, MINUTE),
        await invalid(1, Number.POSITIVE_INFINITY),
      ];
    });
    expect(messages).toEqual([
      "Rate limit must be a positive safe integer",
      "Rate limit window must be a positive safe integer",
    ]);
    await runInDurableObject(limiter, async (_instance, state) => {
      expect(await state.storage.list()).toEqual(new Map());
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });
});

describe("enforceEndpointRateLimit", () => {
  it("names the policy that refused and keeps the scope out of the object name", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR);
    const scopeId = `private-scope:${crypto.randomUUID()}`;
    let objectName = "";
    const namespace = new Proxy(env.ENDPOINT_RATE_LIMITER, {
      get(target, property, receiver) {
        if (property !== "getByName") return Reflect.get(target, property, receiver);
        return (name: string) => {
          objectName = name;
          return target.getByName(name);
        };
      },
    });
    const testEnv = new Proxy(env, {
      get: (target, property, receiver) =>
        property === "ENDPOINT_RATE_LIMITER"
          ? namespace
          : Reflect.get(target, property, receiver),
    }) as Env;

    for (let spent = 0; spent < ENDPOINT_RATE_LIMITS.submission.limit; spent++)
      await enforceEndpointRateLimit(testEnv, "submission", scopeId);

    // The refusal has to name the policy, its ceiling and what shares it:
    // "too many attempts" leaves a caller unable to tell a limit they can wait
    // out from one somebody else spent for them.
    await expect(
      enforceEndpointRateLimit(testEnv, "submission", scopeId),
    ).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      message:
        "You can answer an approval page at most 10 times per minute, " +
        "counted across this operation. Try again in 50 seconds.",
      headers: { "Retry-After": "50" },
      data: {
        scope: "submission",
        limit: 10,
        windowSeconds: 60,
        retryAfterSeconds: 50,
        resetAt: new Date(ANCHOR + 50_000).toISOString(),
      },
    });
    expect(objectName).toMatch(/^endpoint-rate:[0-9a-f]{64}$/u);
    expect(objectName).not.toContain(scopeId);
  });

  it("says when a day-long window reopens rather than how far away it is", async () => {
    vi.useFakeTimers();
    // Fixed rather than derived from the clock: the wording below depends on
    // how far the refusal is from the window's edge, so a run that happened to
    // start near midnight UTC would otherwise assert a different sentence.
    vi.setSystemTime(Date.UTC(2031, 0, 1, 6, 0, 0));
    const scopeId = `203.0.113.${crypto.randomUUID()}`;

    for (let spent = 0; spent < ENDPOINT_RATE_LIMITS.bootstrap.limit; spent++)
      await enforceEndpointRateLimit(env, "bootstrap", scopeId);

    await expect(
      enforceEndpointRateLimit(env, "bootstrap", scopeId),
    ).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      message:
        "You can create an account at most 3 times per day, counted across " +
        "everyone sharing your network address. Try again after " +
        "2031-01-02T00:00:00.000Z.",
      headers: { "Retry-After": "64800" },
      data: {
        scope: "bootstrap",
        limit: 3,
        windowSeconds: 86_400,
        retryAfterSeconds: 64_800,
        resetAt: "2031-01-02T00:00:00.000Z",
      },
    });
  });
});

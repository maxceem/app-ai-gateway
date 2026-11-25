import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ENDPOINT_RATE_LIMITS,
  clientAddress,
  enforceEndpointRateLimit,
} from "../src/core/flood-limit.ts";
import type { FloodLimiter } from "../src/do/FloodLimiter";
import worker from "../src/index.ts";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { seedApp } from "./helpers.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// Keep Durable Object alarms ahead of the real runtime scheduler while each
// test controls Date.now(). Ten seconds into the minute preserves Retry-After: 50.
const ANCHOR = Math.floor((Date.now() + DAY) / MINUTE) * MINUTE + 10_000;

afterEach(() => vi.useRealTimers());

describe("FloodLimiter", () => {
  it("atomically admits exactly the limit under concurrency", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR);
    const limiter = env.FLOOD_LIMITER.getByName(
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
    const first = env.FLOOD_LIMITER.getByName(`endpoint-rate:test:first:${suffix}`);
    const second = env.FLOOD_LIMITER.getByName(`endpoint-rate:test:second:${suffix}`);

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
    const limiter = env.FLOOD_LIMITER.getByName(name);
    expect(await limiter.check({ limit: 2, windowMs: MINUTE })).toMatchObject({ allowed: true });
    expect(await limiter.check({ limit: 2, windowMs: MINUTE })).toMatchObject({ allowed: true });

    await evictDurableObject(limiter);

    expect(
      await env.FLOOD_LIMITER.getByName(name).check({ limit: 2, windowMs: MINUTE }),
    ).toMatchObject({ allowed: false });
  });

  it("does not write or reschedule when an attempt is already denied", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR);
    const limiter = env.FLOOD_LIMITER.getByName(
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
          await (instance as FloodLimiter).check({ limit: 1, windowMs: MINUTE }),
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
    const limiter = env.FLOOD_LIMITER.getByName(
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
    const limiter = env.FLOOD_LIMITER.getByName(
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
    const limiter = env.FLOOD_LIMITER.getByName(
      `endpoint-rate:test:invalid:${crypto.randomUUID()}`,
    );
    const messages = await runInDurableObject(limiter, async (instance) => {
      const endpointLimiter = instance as FloodLimiter;
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
  it("names the policy that refused, with Retry-After", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(ANCHOR);
    const scopeId = `app:${crypto.randomUUID()}`;
    // Sent together to stay fast; the limiter counts each one atomically.
    await Promise.all(
      Array.from({ length: ENDPOINT_RATE_LIMITS.app_auth_challenge.limit }, () =>
        enforceEndpointRateLimit(env, "app_auth_challenge", scopeId),
      ),
    );
    const refusal = enforceEndpointRateLimit(env, "app_auth_challenge", scopeId);
    await expect(refusal).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      headers: { "Retry-After": "50" },
      data: { scope: "app_auth_challenge", limit: 60, windowSeconds: 60, retryAfterSeconds: 50 },
    });
    // Another scope is counted on its own.
    await expect(enforceEndpointRateLimit(env, "app_auth_challenge", `${scopeId}:other`)).resolves.toBeUndefined();
  });

  it("answers a retryable 503 when the limiter object fails, not a 500", async () => {
    const down = {
      ...env,
      FLOOD_LIMITER: { getByName: () => ({ check: async () => { throw new Error("Exceeded allowed rows read in Durable Objects free tier."); } }) },
    } as unknown as Env;
    await expect(enforceEndpointRateLimit(down, "app_auth_token", "app:x")).rejects.toMatchObject({
      status: 503,
      code: "service_unavailable",
      reason: "platform_unavailable",
    });
  });

  it("refuses a token exchange with a retryable 503 when the limiter object fails", async () => {
    const appId = await seedApp({ type: "api_key", end_user: { source: "none" } });
    const down = {
      ...env,
      FLOOD_LIMITER: { getByName: () => ({ check: async () => { throw new Error("Durable Object reset"); } }) },
    } as unknown as Env;
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://gateway.test/v2/apps/${appId}/auth/token`, {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.21" },
      }),
      down,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).not.toBeNull();
  });
});

describe("clientAddress", () => {
  const counted = (address?: string) => clientAddress(new Request("https://gateway.test/", {
    headers: address === undefined ? {} : { "cf-connecting-ip": address },
  }));

  it("counts every address in one IPv6 /64 as one subject, and nothing else with it", () => {
    const network = counted("2001:db8:aa:bb::1");
    expect(network).toBe("2001:db8:aa:bb::/64");
    for (const sibling of [
      "2001:db8:aa:bb::2",
      "2001:0DB8:00AA:00BB:ffff:ffff:ffff:ffff",
      "2001:db8:aa:bb:1:2:3:4",
    ]) expect(counted(sibling)).toBe(network);
    expect(counted("2001:db8:aa:bc::1")).not.toBe(network);
    expect(counted("::1")).toBe("0:0:0:0::/64");
    expect(counted("2001:db8::")).toBe("2001:db8:0:0::/64");
  });

  it("keeps IPv4 whole, reads an IPv4-mapped address as IPv4, and leaves the rest as written", () => {
    expect(counted("203.0.113.7")).toBe("203.0.113.7");
    expect(counted("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(counted("0:0:0:0:0:FFFF:cb00:7107")).toBe("203.0.113.7");
    expect(counted("::ffff:cb00:7108")).toBe("203.0.113.8");
    expect(counted("2001:db8::1::2")).toBe("2001:db8::1::2");
    expect(counted()).toBe("local");
  });
});

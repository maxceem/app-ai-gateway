import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SPEND_REFRESH_MS, type UserLimiter } from "../src/do/UserLimiter";

/** Writes a scope's month the way the usage triggers would. */
async function spent(appId: string, userKey: string | null, month: string, microusd: number) {
  await env.DB.prepare(
    `INSERT INTO app_usage_spend(organization_id, app_id, scope, user_key, month, microusd)
     VALUES ('operator-test-organization', ?, ?, ?, ?, ?)
     ON CONFLICT(scope, app_id, user_key, month) DO UPDATE SET microusd = excluded.microusd`,
  ).bind(appId, userKey === null ? "app" : "user", userKey ?? "", month, microusd).run();
}

/**
 * An application's own limits: the month's spend read from D1 and fixed windows.
 */
describe("UserLimiter", () => {
  it("keeps request windows and separate session leases without billing data", async () => {
    const limiter = env.USER_LIMITER.getByName("user-limiter:tables");
    await limiter.getStatus(Date.now());
    await runInDurableObject(limiter, async (_instance, state) => {
      const tables = state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name",
        )
        .toArray()
        .map((row) => row.name);
      expect(tables).toEqual(["request_windows", "session_leases"]);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("reads the month's spend from D1 and holds it for the refresh window", async () => {
    const appId = "user-limiter-spend";
    const limiter = env.USER_LIMITER.getByName(appId);
    const now = Date.UTC(2026, 6, 23, 12);
    const check = (at: number) => limiter.checkAndIncrement({
      now: at, rpm: null, rpd: null, monthlyBudgetMicrousd: 500, spend: { appId, userKey: null },
    });
    await spent(appId, null, "2026-07", 400);
    expect(await check(now)).toEqual({ allowed: true });
    // Spend settles past the budget, but the figure read a moment ago stands
    // until it ages out.
    await spent(appId, null, "2026-07", 500);
    expect(await check(now + SPEND_REFRESH_MS - 1)).toEqual({ allowed: true });
    expect(await check(now + SPEND_REFRESH_MS)).toMatchObject({ allowed: false, reason: "budget" });
    // Spend is per UTC month, so the next one starts from nothing.
    expect(await check(Date.UTC(2026, 7, 1))).toEqual({ allowed: true });
  });

  it("shares one D1 read among requests that find the spend stale together", async () => {
    const appId = "user-limiter-shared-read";
    await spent(appId, null, "2026-07", 100);
    const limiter = env.USER_LIMITER.getByName(appId);
    await runInDurableObject(limiter, async (instance) => {
      let reads = 0;
      const db = env.DB;
      const counting = new Proxy(db, {
        get: (target, property, receiver) => property === "prepare"
          ? (query: string) => {
            reads += 1;
            return target.prepare(query);
          }
          : Reflect.get(target, property, receiver),
      });
      (instance as unknown as { env: Env }).env = { ...env, DB: counting };
      const now = Date.UTC(2026, 6, 23, 12);
      const results = await Promise.all(Array.from({ length: 20 }, () =>
        (instance as UserLimiter).checkAndIncrement({
          now, rpm: null, rpd: null, monthlyBudgetMicrousd: 500, spend: { appId, userKey: null },
        })));
      expect(results.every((result) => result.allowed)).toBe(true);
      expect(reads).toBe(1);
    });
  });

  it("measures a user's budget against that user's own month", async () => {
    const appId = "user-limiter-user-spend";
    const limiter = env.USER_LIMITER.getByName(`${appId}:u1`);
    const now = Date.UTC(2026, 6, 23, 12);
    await spent(appId, null, "2026-07", 10_000);
    await spent(appId, "u1", "2026-07", 100);
    expect(await limiter.checkAndIncrement({
      now, rpm: null, rpd: null, monthlyBudgetMicrousd: 500, spend: { appId, userKey: "u1" },
    })).toEqual({ allowed: true });
  });
});

/**
 * Request counting.
 *
 * Two fixed windows rather than the row-per-request sliding window this object
 * used to keep, and both in one row: a window that has rolled is overwritten in
 * place, so storage is a single row however much traffic passes through. The
 * cost is a burst at the boundary, asserted below as intended rather than left
 * to be discovered.
 */
describe("UserLimiter request windows", () => {
  const unlimited = {
    rpm: null,
    rpd: null,
    monthlyBudgetMicrousd: null,
    spend: { appId: "windows", userKey: null },
  };

  it("admits up to the per-minute limit and refuses the next", async () => {
    const limiter = env.USER_LIMITER.getByName("windows:rpm");
    const now = Date.UTC(2026, 0, 15, 10, 30, 0);

    expect((await limiter.checkAndIncrement({ ...unlimited, now, rpm: 2 })).allowed).toBe(true);
    expect((await limiter.checkAndIncrement({ ...unlimited, now, rpm: 2 })).allowed).toBe(true);

    const refused = await limiter.checkAndIncrement({ ...unlimited, now, rpm: 2 });
    expect(refused).toMatchObject({ allowed: false, reason: "rate" });
    // Points at the end of the minute it is counting, never further.
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) {
      expect(refused.retryAfterSeconds).toBeGreaterThan(0);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it("starts a fresh count when the minute rolls over", async () => {
    const limiter = env.USER_LIMITER.getByName("windows:rollover");
    const now = Date.UTC(2026, 0, 15, 10, 30, 0);

    expect((await limiter.checkAndIncrement({ ...unlimited, now, rpm: 1 })).allowed).toBe(true);
    expect((await limiter.checkAndIncrement({ ...unlimited, now, rpm: 1 })).allowed).toBe(false);
    expect((await limiter.checkAndIncrement({ ...unlimited, now: now + 60_000, rpm: 1 })).allowed)
      .toBe(true);
  });

  /**
   * The trade-off the fixed windows buy. A caller who spends the whole minute
   * allowance at the end of one window and again at the start of the next sends
   * twice the nominal rate across those two seconds. Accepted for abuse control
   * at these magnitudes, and asserted so a change to it is deliberate.
   */
  it("allows a double burst across a minute boundary", async () => {
    const limiter = env.USER_LIMITER.getByName("windows:burst");
    const endOfMinute = Date.UTC(2026, 0, 15, 10, 30, 59, 500);

    expect((await limiter.checkAndIncrement({ ...unlimited, now: endOfMinute, rpm: 2 })).allowed).toBe(true);
    expect((await limiter.checkAndIncrement({ ...unlimited, now: endOfMinute, rpm: 2 })).allowed).toBe(true);
    const nextMinute = endOfMinute + 1_000;
    expect((await limiter.checkAndIncrement({ ...unlimited, now: nextMinute, rpm: 2 })).allowed).toBe(true);
    expect((await limiter.checkAndIncrement({ ...unlimited, now: nextMinute, rpm: 2 })).allowed).toBe(true);
  });

  /**
   * A request can reach the windows with a clock behind the one already
   * counted — it awaited its spend read while a later request went through, or
   * its isolate is a moment behind. It is counted into the newer window, never
   * allowed to reset it to its own.
   */
  it("never moves a window backwards for a request whose clock trails it", async () => {
    const limiter = env.USER_LIMITER.getByName("windows:monotonic");
    const later = Date.UTC(2026, 0, 15, 10, 31, 0);
    const earlier = later - 1_000;

    expect((await limiter.checkAndIncrement({ ...unlimited, now: later, rpm: 1 })).allowed).toBe(true);
    expect((await limiter.checkAndIncrement({ ...unlimited, now: earlier, rpm: 1 })).allowed).toBe(false);
    expect((await limiter.checkAndIncrement({ ...unlimited, now: later, rpm: 1 })).allowed).toBe(false);
  });

  it("refuses on the daily limit and points at the next UTC midnight", async () => {
    const limiter = env.USER_LIMITER.getByName("windows:rpd");
    const now = Date.UTC(2026, 0, 15, 23, 0, 0);

    expect((await limiter.checkAndIncrement({ ...unlimited, now, rpd: 1 })).allowed).toBe(true);
    const refused = await limiter.checkAndIncrement({ ...unlimited, now, rpd: 1 });

    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.retryAfterSeconds).toBe(3600);
    // A later minute does not reopen a day.
    expect((await limiter.checkAndIncrement({ ...unlimited, now: now + 60_000, rpd: 1 })).allowed)
      .toBe(false);
    expect((await limiter.checkAndIncrement({ ...unlimited, now: now + 3_600_000, rpd: 1 })).allowed)
      .toBe(true);
  });

  /**
   * A request the day limit refuses must not quietly spend a minute token, or a
   * caller would be charged twice over for one rejection and the per-minute
   * window would drain while nothing was being served.
   */
  it("spends no minute token on a request the day limit refuses", async () => {
    const limiter = env.USER_LIMITER.getByName("windows:no-double-spend");
    const now = Date.UTC(2026, 0, 15, 10, 30, 0);

    expect((await limiter.checkAndIncrement({ ...unlimited, now, rpm: 5, rpd: 1 })).allowed).toBe(true);
    expect((await limiter.checkAndIncrement({ ...unlimited, now, rpm: 5, rpd: 1 })).allowed).toBe(false);

    // Tomorrow: four of the five per-minute tokens are still there, so the
    // refused attempt above took none of them.
    const tomorrow = now + 86_400_000;
    for (let request = 0; request < 4; request += 1) {
      expect((await limiter.checkAndIncrement({ ...unlimited, now: tomorrow, rpm: 5, rpd: 10 })).allowed)
        .toBe(true);
    }
  });

  it("refuses on a budget the settled spend has reached, before counting anything", async () => {
    const limiter = env.USER_LIMITER.getByName("windows:budget");
    const now = Date.now();
    await spent("windows-budget", null, new Date(now).toISOString().slice(0, 7), 500);

    expect(await limiter.checkAndIncrement({
      now, rpm: 10, rpd: 10, monthlyBudgetMicrousd: 500, spend: { appId: "windows-budget", userKey: null },
    })).toMatchObject({ allowed: false, reason: "budget" });
    // Nothing was counted: the budget is decided before the windows are touched.
    expect((await limiter.getStatus(now)).requestsToday).toBe(0);
  });

  it("keeps exactly one row however much traffic passes through", async () => {
    const limiter = env.USER_LIMITER.getByName("windows:bounded");
    const start = Date.UTC(2026, 0, 15, 10, 0, 0);

    // Twenty distinct minutes across two distinct days.
    for (let step = 0; step < 20; step += 1) {
      await limiter.checkAndIncrement({ ...unlimited, now: start + step * 3_600_000 });
    }

    // Both counters share a row, so an admitted request writes once rather
    // than once per window.
    await runInDurableObject(limiter, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM request_windows")
          .one().count,
      ).toBe(1);
    });
  });

  it("falls back to real time rather than counting into a NaN window", async () => {
    const limiter = env.USER_LIMITER.getByName("windows:bad-clock");

    expect((await limiter.checkAndIncrement({ ...unlimited, now: Number.NaN, rpm: 1 })).allowed)
      .toBe(true);
    expect((await limiter.getStatus(Date.now())).requestsToday).toBe(1);
  });
});

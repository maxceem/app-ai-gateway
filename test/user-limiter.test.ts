import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { UserLimiter } from "../src/do/UserLimiter";

/**
 * The projection behind an application's own limits: a moderation switch, a
 * versioned monthly spend snapshot, and fixed request windows.
 */
describe("UserLimiter", () => {
  it("accepts only a newer monthly revision", async () => {
    const limiter = env.USER_LIMITER.getByName("user-limiter:versions");
    const now = Date.UTC(2026, 6, 23, 12);

    expect(await limiter.setMonthlyCost("2026-07", 2, 70)).toBe(true);
    expect(await limiter.setMonthlyCost("2026-07", 2, 999)).toBe(false);
    expect(await limiter.setMonthlyCost("2026-07", 1, 5)).toBe(false);
    expect((await limiter.getStatus(now)).monthlyCostMicrousd).toBe(70);
    expect(await limiter.setMonthlyCost("2026-07", 3, 75)).toBe(true);
    expect((await limiter.getStatus(now)).monthlyCostMicrousd).toBe(75);
  });

  it("validates projection snapshots before writing them", async () => {
    const limiter = env.USER_LIMITER.getByName("user-limiter:validation");
    await runInDurableObject(limiter, (instance) => {
      const userLimiter = instance as UserLimiter;
      expect(() => userLimiter.setMonthlyCost("2026-13", 1, 1)).toThrow(/valid YYYY-MM/u);
      expect(() => userLimiter.setMonthlyCost("2026-07", 0, 1)).toThrow(/revision/u);
      expect(() => userLimiter.setMonthlyCost("2026-07", 1, -1)).toThrow(/microusd/u);
    });
  });

  it("keeps no event ledger or standing cleanup alarm", async () => {
    const limiter = env.USER_LIMITER.getByName("user-limiter:no-ledger");
    await limiter.setMonthlyCost("2026-07", 1, 1);

    await runInDurableObject(limiter, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'applied_events'",
          )
          .one().count,
      ).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("arms no alarm for a limiter that has never settled a cost", async () => {
    const limiter = env.USER_LIMITER.getByName("user-limiter:never-settled");
    await limiter.checkAndIncrement({
      now: Date.now(),
      rpm: 10,
      rpd: 10,
      monthlyBudgetMicrousd: null,
    });
    await limiter.getStatus(Date.now());

    await runInDurableObject(limiter, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("tracks the block flag and the month's spend independently", async () => {
    const limiter = env.USER_LIMITER.getByName("user-limiter:status");
    const now = Date.UTC(2026, 6, 23, 12);
    await limiter.setMonthlyCost("2026-07", 1, 42);
    expect(await limiter.getStatus(now)).toEqual({ blocked: false, requestsToday: 0, monthlyCostMicrousd: 42 });
    expect(await limiter.isBlocked()).toBe(false);

    await limiter.setBlocked(true);
    expect(await limiter.isBlocked()).toBe(true);
    expect(await limiter.getStatus(now)).toEqual({ blocked: true, requestsToday: 0, monthlyCostMicrousd: 42 });

    // Spend is per UTC month, so a later month reads back clean.
    expect((await limiter.getStatus(Date.UTC(2026, 7, 1))).monthlyCostMicrousd).toBe(0);
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
  const unlimited = { rpm: null, rpd: null, monthlyBudgetMicrousd: null };

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
    await limiter.setMonthlyCost(new Date(now).toISOString().slice(0, 7), 1, 500);

    expect(await limiter.checkAndIncrement({ now, rpm: 10, rpd: 10, monthlyBudgetMicrousd: 500 }))
      .toMatchObject({ allowed: false, reason: "budget" });
    // Nothing was counted: the budget is decided before the windows are touched.
    expect((await limiter.getStatus(now)).requestsToday).toBe(0);
  });

  it("refuses a blocked user before any limit is consulted", async () => {
    const limiter = env.USER_LIMITER.getByName("windows:blocked");
    await limiter.setBlocked(true);

    expect(await limiter.checkAndIncrement({ ...unlimited, now: Date.now() }))
      .toMatchObject({ allowed: false, reason: "blocked" });
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

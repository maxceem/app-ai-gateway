import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * The object behind an application's own limits: a moderation switch, a month's
 * settled spend whose ledger has to stay exactly-once under recording retries,
 * and the request windows the rate limits are counted against.
 */
describe("UserLimiter", () => {
  it("applies a settled event once however many times it is replayed", async () => {
    const limiter = env.USER_LIMITER.getByName("user-limiter:ledger");
    const now = Date.now();
    const eventId = crypto.randomUUID();

    expect(await limiter.addCost(eventId, now, 70)).toBe(70);
    expect(await limiter.addCost(eventId, now, 70)).toBe(70);
    expect(await limiter.addCost(crypto.randomUUID(), now, 5)).toBe(75);
  });

  it("prunes the dedup ledger past the retry horizon and reschedules itself", async () => {
    const limiter = env.USER_LIMITER.getByName("user-limiter:prune");
    const now = Date.now();
    const stale = crypto.randomUUID();
    await limiter.addCost(stale, now, 70);
    await limiter.addCost(crypto.randomUUID(), now, 5);

    // Age one entry past the week the ledger keeps. Once it is gone the ledger
    // no longer claims to have seen that event; that is the retention
    // trade-off, and it only matters far past any recording retry.
    await runInDurableObject(limiter, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE applied_events SET applied_at = ? WHERE event_id = ?",
        Date.now() - 8 * 86_400_000,
        stale,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(limiter)).toBe(true);

    await runInDurableObject(limiter, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM applied_events")
          .one().count,
      ).toBe(1);
      // Entries survive, so there is still something to come back for.
      const nextAlarm = await state.storage.getAlarm();
      expect(nextAlarm).not.toBeNull();
      expect(nextAlarm!).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    });

    // Spend itself is history and is never pruned with the ledger.
    expect((await limiter.getStatus(now)).monthlyCostMicrousd).toBe(75);
  });

  /**
   * A standing alarm costs a request and a write every day for as long as the
   * object exists, and there is one object per end user. So the prune stops
   * rearming itself the moment the ledger it prunes is empty; an app's dormant
   * users then cost nothing at all until they come back.
   */
  it("stops rescheduling cleanup once the ledger is empty", async () => {
    const limiter = env.USER_LIMITER.getByName("user-limiter:empty-alarm");
    const stale = crypto.randomUUID();
    await limiter.addCost(stale, Date.now(), 70);

    await runInDurableObject(limiter, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE applied_events SET applied_at = ? WHERE event_id = ?",
        Date.now() - 8 * 86_400_000,
        stale,
      );
    });
    expect(await runDurableObjectAlarm(limiter)).toBe(true);

    await runInDurableObject(limiter, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM applied_events")
          .one().count,
      ).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
    });

    // Settling again arms it once more, so the ledger is never left unpruned.
    await limiter.addCost(crypto.randomUUID(), Date.now(), 5);
    await runInDurableObject(limiter, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  /**
   * The settling attempt commits its ledger row before it arms the prune, so a
   * `setAlarm` that fails leaves the row stored with nothing scheduled to
   * remove it. The recording retry then replays an event that is already there
   * and stores nothing — so arming has to happen on that path too, or the row
   * outlives every chance to prune it.
   */
  it("arms the prune even when the settling attempt is a replay", async () => {
    const limiter = env.USER_LIMITER.getByName("user-limiter:replay-arms");
    const eventId = crypto.randomUUID();
    await limiter.addCost(eventId, Date.now(), 70);

    // Exactly the state a failed `setAlarm` leaves behind.
    await runInDurableObject(limiter, async (instance, state) => {
      await state.storage.deleteAlarm();
      (instance as unknown as { prunePending?: boolean }).prunePending = false;
    });

    // The replay settles nothing, and still leaves a prune scheduled.
    expect(await limiter.addCost(eventId, Date.now(), 70)).toBe(70);
    await runInDurableObject(limiter, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  /**
   * A failing prune must not be able to stop this object pruning for good. The
   * platform retries the handler a few times and then drops the alarm, so if
   * the handler left "an alarm is pending" set on the way out, every later
   * settlement would decline to arm a replacement.
   */
  it("rearms after a prune that failed outright", async () => {
    const limiter = env.USER_LIMITER.getByName("user-limiter:failed-prune");
    await limiter.addCost(crypto.randomUUID(), Date.now(), 70);

    await runInDurableObject(limiter, async (instance, state) => {
      await state.storage.deleteAlarm();
      // Take the ledger out from under the prune, so the handler fails the way
      // a storage error would — after it has already committed to there being
      // nothing scheduled.
      state.storage.sql.exec("DROP TABLE applied_events");
      await expect(instance.alarm!()).rejects.toThrow();
      state.storage.sql.exec(
        "CREATE TABLE applied_events (event_id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) WITHOUT ROWID",
      );
      // Named explicitly, because this is the mechanism: the handler cleared
      // the flag on its way in, so nothing is left claiming a prune is pending.
      expect((instance as unknown as { prunePending?: boolean }).prunePending).toBe(false);
      expect(await state.storage.getAlarm()).toBeNull();
    });

    // The next settlement arms a fresh prune rather than trusting a stale flag.
    await limiter.addCost(crypto.randomUUID(), Date.now(), 5);
    await runInDurableObject(limiter, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  /**
   * The shape the write saving rests on. Every secondary index here is another
   * row written on every request that settles a cost, which is the whole reason
   * the ledger carries none and the prune scans instead.
   */
  it("keeps the dedup ledger free of everything but its primary key", async () => {
    const limiter = env.USER_LIMITER.getByName("user-limiter:ledger-shape");
    await limiter.addCost(crypto.randomUUID(), Date.now(), 1);

    await runInDurableObject(limiter, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ sql: string }>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'applied_events'",
          )
          .one().sql,
      ).toContain("WITHOUT ROWID");
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND tbl_name = 'applied_events'",
          )
          .one().count,
      ).toBe(0);
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
    await limiter.addCost(crypto.randomUUID(), now, 42);
    expect(await limiter.getStatus(now)).toEqual({ blocked: false, requestsToday: 0, monthlyCostMicrousd: 42 });
    expect(await limiter.isBlocked()).toBe(false);

    await limiter.setBlocked(true);
    expect(await limiter.isBlocked()).toBe(true);
    expect(await limiter.getStatus(now)).toEqual({ blocked: true, requestsToday: 0, monthlyCostMicrousd: 42 });

    // Spend is per UTC month, so a later month reads back clean.
    expect((await limiter.getStatus(Date.UTC(2026, 7, 1))).monthlyCostMicrousd).toBe(0);
  });

  it("replaces a month's spend when repricing reconciles it", async () => {
    const limiter = env.USER_LIMITER.getByName("user-limiter:reconcile");
    const now = Date.UTC(2026, 6, 23, 12);
    await limiter.addCost(crypto.randomUUID(), now, 184);
    await limiter.reconcileMonth("2026-07", 37);
    expect((await limiter.getStatus(now)).monthlyCostMicrousd).toBe(37);
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
    await limiter.addCost(crypto.randomUUID(), now, 500);

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

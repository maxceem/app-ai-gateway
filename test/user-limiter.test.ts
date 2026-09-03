import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * What is left of the per-user object once the gateway's only quota moved to
 * `OrgQuota`: a moderation switch, and a month's settled spend whose ledger has
 * to stay exactly-once under recording retries and has to be pruned afterwards.
 *
 * None of this is quota enforcement, and all of it kept its old behaviour, so
 * it keeps its old coverage.
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
      // Pruning is a standing job, so the alarm always sets the next one.
      const nextAlarm = await state.storage.getAlarm();
      expect(nextAlarm).not.toBeNull();
      expect(nextAlarm!).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    });

    // Spend itself is history and is never pruned with the ledger.
    expect((await limiter.getStatus(now)).monthlyCostMicrousd).toBe(75);
  });

  it("reschedules cleanup even when there is nothing to prune", async () => {
    const limiter = env.USER_LIMITER.getByName("user-limiter:empty-alarm");
    await limiter.getStatus(Date.now());
    await runInDurableObject(limiter, async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(limiter)).toBe(true);
    await runInDurableObject(limiter, async (_instance, state) => {
      const nextAlarm = await state.storage.getAlarm();
      expect(nextAlarm).not.toBeNull();
      expect(nextAlarm!).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    });
  });

  it("tracks the block flag and the month's spend independently", async () => {
    const limiter = env.USER_LIMITER.getByName("user-limiter:status");
    const now = Date.UTC(2026, 6, 23, 12);
    await limiter.addCost(crypto.randomUUID(), now, 42);
    expect(await limiter.getStatus(now)).toEqual({ blocked: false, monthlyCostMicrousd: 42 });
    expect(await limiter.isBlocked()).toBe(false);

    await limiter.setBlocked(true);
    expect(await limiter.isBlocked()).toBe(true);
    expect(await limiter.getStatus(now)).toEqual({ blocked: true, monthlyCostMicrousd: 42 });

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

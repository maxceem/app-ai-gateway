import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { nextUtcMonthStart, utcMonthKey } from "../src/do/OrgQuota";

const JULY = Date.UTC(2026, 6, 23, 12, 0, 0);
const AUGUST = Date.UTC(2026, 7, 1, 0, 0, 0);
const DECEMBER = Date.UTC(2026, 11, 31, 23, 59, 59);

describe("OrgQuota", () => {
  it("keys months and reset instants in UTC, rolling the year over", () => {
    expect(utcMonthKey(JULY)).toBe("2026-07");
    expect(new Date(nextUtcMonthStart(JULY)).toISOString()).toBe("2026-08-01T00:00:00.000Z");
    // The first instant of a month already belongs to it, so its reset is the
    // month after — never the same instant it was asked at.
    expect(utcMonthKey(AUGUST)).toBe("2026-08");
    expect(new Date(nextUtcMonthStart(AUGUST)).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(new Date(nextUtcMonthStart(DECEMBER)).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("admits exactly the allowance and then refuses with the reset instant", async () => {
    const quota = env.ORG_QUOTA.getByName("quota:sequential");
    expect(await quota.admit({ now: JULY, limit: 2 })).toEqual({
      allowed: true,
      limit: 2,
      used: 1,
      resetAt: "2026-08-01T00:00:00.000Z",
    });
    expect(await quota.admit({ now: JULY, limit: 2 })).toMatchObject({ allowed: true, used: 2 });

    const refused = await quota.admit({ now: JULY, limit: 2 });
    expect(refused).toEqual({
      allowed: false,
      limit: 2,
      used: 2,
      resetAt: "2026-08-01T00:00:00.000Z",
      retryAfterSeconds: Math.ceil((Date.UTC(2026, 7, 1) - JULY) / 1000),
    });
  });

  /**
   * The property that makes this the only coordination point: a burst that all
   * arrives before any of it has been counted must still not overshoot. The
   * conditional upsert is what forbids it, so N concurrent claims against an
   * allowance of K admit exactly K.
   */
  it("never lets concurrent admissions exceed the allowance", async () => {
    const quota = env.ORG_QUOTA.getByName("quota:concurrent");
    const results = await Promise.all(
      Array.from({ length: 50 }, () => quota.admit({ now: JULY, limit: 20 })),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(20);
    // Every admitted claim got a distinct count, so none was handed out twice.
    const counts = results.filter((result) => result.allowed).map((result) => result.used).sort((a, b) => a - b);
    expect(counts).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect((await quota.usage(JULY)).used).toBe(20);
    for (const refusal of results.filter((result) => !result.allowed)) {
      expect(refusal).toMatchObject({ limit: 20, used: 20 });
    }
  });

  it("starts a fresh allowance in a new UTC month and drops the old count", async () => {
    const quota = env.ORG_QUOTA.getByName("quota:rollover");
    expect(await quota.admit({ now: JULY, limit: 1 })).toMatchObject({ allowed: true, used: 1 });
    expect(await quota.admit({ now: JULY, limit: 1 })).toMatchObject({ allowed: false });

    // One millisecond later in UTC terms, and the allowance is whole again.
    expect(await quota.admit({ now: AUGUST, limit: 1 })).toEqual({
      allowed: true,
      limit: 1,
      used: 1,
      resetAt: "2026-09-01T00:00:00.000Z",
    });
    expect(await quota.usage(JULY)).toMatchObject({ month: "2026-07", used: 0 });

    // The superseded month is not kept around: storage stays one row per object.
    await runInDurableObject(quota, (_instance, state) => {
      const months = state.storage.sql
        .exec<{ month: string }>("SELECT month FROM monthly_requests")
        .toArray()
        .map((row) => row.month);
      expect(months).toEqual(["2026-08"]);
    });
  });

  it("refuses everything on a zero or nonsensical allowance without recording it", async () => {
    const quota = env.ORG_QUOTA.getByName("quota:zero");
    for (const limit of [0, -5, Number.NaN]) {
      expect(await quota.admit({ now: JULY, limit })).toMatchObject({ allowed: false, used: 0 });
    }
    expect((await quota.usage(JULY)).used).toBe(0);
  });

  it("floors a fractional allowance rather than rounding it up", async () => {
    const quota = env.ORG_QUOTA.getByName("quota:fractional");
    expect(await quota.admit({ now: JULY, limit: 1.9 })).toMatchObject({ allowed: true, limit: 1 });
    expect(await quota.admit({ now: JULY, limit: 1.9 })).toMatchObject({ allowed: false, limit: 1 });
  });

  it("reports usage without spending any of it", async () => {
    const quota = env.ORG_QUOTA.getByName("quota:usage");
    expect(await quota.usage(JULY)).toEqual({
      month: "2026-07",
      used: 0,
      resetAt: "2026-08-01T00:00:00.000Z",
    });
    await quota.admit({ now: JULY, limit: 5 });
    expect(await quota.usage(JULY)).toMatchObject({ used: 1 });
    expect(await quota.usage(JULY)).toMatchObject({ used: 1 });
  });
});

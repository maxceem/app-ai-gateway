import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

const JULY = Date.UTC(2026, 6, 23, 12);
const PERIOD = { periodId: "2026-07", periodEnd: "2026-08-01T00:00:00.000Z" };

afterEach(() => vi.useRealTimers());

describe("OrgQuota", () => {
  it("admits exactly the allowance and says when it resets", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(JULY);
    const quota = env.ORG_QUOTA.getByName("quota:sequential");
    expect(await quota.admit({ ...PERIOD, limit: 2 })).toMatchObject({ allowed: true, used: 1 });
    expect(await quota.admit({ ...PERIOD, limit: 2 })).toMatchObject({ allowed: true, used: 2 });
    expect(await quota.admit({ ...PERIOD, limit: 2 })).toEqual({
      allowed: false,
      used: 2,
      limit: 2,
      retryAfterSeconds: Math.ceil((Date.parse(PERIOD.periodEnd) - JULY) / 1_000),
    });
  });

  it("never lets concurrent admissions exceed the allowance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(JULY);
    const quota = env.ORG_QUOTA.getByName("quota:concurrent");
    const results = await Promise.all(
      Array.from({ length: 25 }, () => quota.admit({ ...PERIOD, limit: 10 })),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(10);
    expect(await quota.usage(PERIOD.periodId)).toBe(10);
  });

  it("applies whatever limit arrives, over the count already spent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(JULY);
    const quota = env.ORG_QUOTA.getByName("quota:plan-change");
    expect(await quota.admit({ ...PERIOD, limit: 1 })).toMatchObject({ allowed: true, used: 1 });
    expect(await quota.admit({ ...PERIOD, limit: 1 })).toMatchObject({ allowed: false });
    // An upgrade lifts the ceiling; a downgrade below what was spent refuses.
    expect(await quota.admit({ ...PERIOD, limit: 5 })).toMatchObject({ allowed: true, used: 2 });
    expect(await quota.admit({ ...PERIOD, limit: 2 })).toMatchObject({ allowed: false, used: 2 });
  });

  it("counts each period on its own", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(JULY);
    const quota = env.ORG_QUOTA.getByName("quota:periods");
    expect(await quota.admit({ ...PERIOD, limit: 5 })).toMatchObject({ used: 1 });
    expect(await quota.usage("2026-07")).toBe(1);
    expect(await quota.usage("2026-08")).toBe(0);
  });

  it("counts a request that crosses midnight toward the month it was resolved in", async () => {
    vi.useFakeTimers();
    // The period was resolved in July; the admission lands a moment into August.
    vi.setSystemTime(Date.parse("2026-08-01T00:00:00.050Z"));
    const quota = env.ORG_QUOTA.getByName("quota:midnight");
    expect(await quota.admit({ ...PERIOD, limit: 100 })).toMatchObject({ allowed: true, used: 1 });
    expect(await quota.usage("2026-07")).toBe(1);
  });

  it("refuses everything under a zero or malformed limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(JULY);
    const quota = env.ORG_QUOTA.getByName("quota:zero");
    expect(await quota.admit({ ...PERIOD, limit: 0 })).toMatchObject({ allowed: false, used: 0 });
    expect(await quota.admit({ ...PERIOD, limit: Number.NaN })).toMatchObject({ allowed: false });
  });
});

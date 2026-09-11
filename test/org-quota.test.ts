import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

const JULY = Date.UTC(2026, 6, 23, 12);

function period(overrides: Partial<{
  limit: number;
  scheduleId: string;
  scheduleRevision: number;
  periodId: string;
  periodStart: string;
  periodEnd: string;
  resetAt: string;
}> = {}) {
  const periodStart = overrides.periodStart ?? "2026-07-15T00:00:00.000Z";
  const periodEnd = overrides.periodEnd ?? "2026-08-15T00:00:00.000Z";
  return {
    limit: 10,
    scheduleId: "paid:generation-a",
    scheduleRevision: Date.UTC(2026, 6, 15),
    periodId: `period:${periodStart}`,
    periodStart,
    periodEnd,
    resetAt: periodEnd,
    ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe("OrgQuota", () => {
  it("admits exactly the allowance and reports the anniversary boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(JULY);
    const quota = env.ORG_QUOTA.getByName("quota:sequential");
    const input = period({ limit: 2 });
    expect(await quota.admit(input)).toMatchObject({ allowed: true, used: 1 });
    expect(await quota.admit(input)).toMatchObject({ allowed: true, used: 2 });
    expect(await quota.admit(input)).toMatchObject({
      allowed: false,
      used: 2,
      retryAfterSeconds: Math.ceil((Date.parse(input.periodEnd) - JULY) / 1_000),
    });
  });

  it("never lets concurrent admissions exceed the allowance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(JULY);
    const quota = env.ORG_QUOTA.getByName("quota:concurrent");
    const results = await Promise.all(
      Array.from({ length: 50 }, () => quota.admit(period({ limit: 20 }))),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(20);
    const counts = results
      .filter((result) => result.allowed && "used" in result)
      .map((result) => "used" in result ? result.used : 0)
      .sort((a, b) => a - b);
    expect(counts).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it("keeps Free history across paid and Free transitions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(JULY);
    const quota = env.ORG_QUOTA.getByName("quota:history");
    const free = period({ scheduleId: "free:created", scheduleRevision: 1 });
    expect(await quota.admit(free)).toMatchObject({ allowed: true, used: 1 });
    expect(await quota.admit(period({
      scheduleId: "paid:generation",
      scheduleRevision: 2,
    }))).toMatchObject({ allowed: true, used: 1 });
    expect(await quota.admit(period({
      scheduleId: "free:created",
      scheduleRevision: 3,
    }))).toMatchObject({ allowed: true, used: 2 });
  });

  it("preserves usage on upgrades and rejects a stale larger limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(JULY);
    const quota = env.ORG_QUOTA.getByName("quota:upgrade");
    expect(await quota.admit(period({ scheduleRevision: 10, limit: 5 })))
      .toMatchObject({ used: 1 });
    expect(await quota.admit(period({ scheduleRevision: 11, limit: 5 })))
      .toMatchObject({ used: 2 });
    expect(await quota.admit(period({ scheduleRevision: 12, limit: 2 })))
      .toMatchObject({ allowed: false, used: 2 });
    expect(await quota.admit(period({ scheduleRevision: 10, limit: 100 })))
      .toEqual({ allowed: false, superseded: true });
  });

  it("does not let a delayed old period reopen after the next period starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 16));
    const quota = env.ORG_QUOTA.getByName("quota:late-period");
    const next = period({
      periodStart: "2026-08-15T00:00:00.000Z",
      periodEnd: "2026-09-15T00:00:00.000Z",
      resetAt: "2026-09-15T00:00:00.000Z",
    });
    expect(await quota.admit(next)).toMatchObject({ allowed: true, used: 1 });
    expect(await quota.admit(period())).toEqual({ allowed: false, superseded: true });
  });

  it("validates periods before adopting their revision", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(JULY);
    const quota = env.ORG_QUOTA.getByName("quota:invalid");
    expect(await quota.admit(period({
      scheduleRevision: 100,
      periodEnd: "not-a-date",
      resetAt: "not-a-date",
    }))).toEqual({ allowed: false, superseded: true });
    expect(await quota.admit(period({ scheduleRevision: 1 })))
      .toMatchObject({ allowed: true, used: 1 });
  });
});


it("uses its own clock to reject both future and expired periods", async () => {
  vi.useFakeTimers();
  const quota = env.ORG_QUOTA.getByName("quota:clock-boundaries");
  const input = period();
  vi.setSystemTime(Date.parse(input.periodStart) - 1);
  expect(await quota.admit(input)).toEqual({ allowed: false, superseded: true });
  vi.setSystemTime(Date.parse(input.periodStart));
  expect(await quota.admit(input)).toMatchObject({ allowed: true, used: 1 });
  vi.setSystemTime(Date.parse(input.periodEnd));
  expect(await quota.admit(input)).toEqual({ allowed: false, superseded: true });
});

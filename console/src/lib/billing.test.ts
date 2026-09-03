import { describe, expect, it } from "vitest";
import {
  billingNotice,
  canResume,
  isBillingBlocked,
  priceFor,
  quotaMeter,
  quotaNotice,
  subscriptionTimeline,
} from "./billing";
import type { BillingAccess, BillingPlan } from "./types";

const RESETS = "2026-10-01T00:00:00.000Z";

describe("billingNotice", () => {
  it("stays silent for a self-hosted deployment", () => {
    expect(billingNotice({ status: "active", selfHosted: true })).toBeNull();
    // Even a nominally inactive status must not surface billing when self-hosted.
    expect(billingNotice({ status: "inactive", reason: "past_due", selfHosted: true })).toBeNull();
  });

  it("stays silent for an active subscription", () => {
    expect(billingNotice({ status: "active" })).toBeNull();
  });

  it("stays silent when billing status is unknown", () => {
    expect(billingNotice(undefined)).toBeNull();
    expect(billingNotice(null)).toBeNull();
  });

  it("warns during a trial and offers plans", () => {
    const notice = billingNotice({ status: "trialing", trialEndsAt: "2026-09-01T00:00:00.000Z" });
    expect(notice?.tone).toBe("warning");
    expect(notice?.actionable).toBe(true);
    expect(notice?.description).toMatch(/2026/);
  });

  it("escalates an inactive subscription with reason-specific copy", () => {
    const notice = billingNotice({ status: "inactive", reason: "past_due" });
    expect(notice?.tone).toBe("destructive");
    expect(notice?.title).toMatch(/past due/i);
    expect(notice?.actionable).toBe(true);
  });

  it("does not offer plans for failures a plan change cannot fix", () => {
    expect(billingNotice({ status: "inactive", reason: "billing_unavailable" })?.actionable).toBe(false);
    expect(billingNotice({ status: "inactive", reason: "service_inactive" })?.actionable).toBe(false);
  });

  it("falls back to the missing-subscription copy for an unknown reason", () => {
    const notice = billingNotice({ status: "inactive" } as BillingAccess);
    expect(notice?.title).toMatch(/no active subscription/i);
  });
});

describe("isBillingBlocked", () => {
  it("blocks only a non-self-hosted inactive organization", () => {
    expect(isBillingBlocked({ status: "inactive", reason: "canceled" })).toBe(true);
    expect(isBillingBlocked({ status: "inactive", selfHosted: true })).toBe(false);
    expect(isBillingBlocked({ status: "trialing", trialEndsAt: "x" })).toBe(false);
    expect(isBillingBlocked(undefined)).toBe(false);
  });
});

describe("subscriptionTimeline", () => {
  it("prefers the end date of a canceled subscription over its renewal", () => {
    const timeline = subscriptionTimeline({
      status: "active",
      renewsAt: "2026-10-01T00:00:00.000Z",
      endsAt: "2026-09-15T00:00:00.000Z",
    });
    expect(timeline?.label).toBe("Access ends");
  });

  it("reports the renewal date of a healthy subscription", () => {
    expect(subscriptionTimeline({ status: "active", renewsAt: "2026-10-01T00:00:00.000Z" })?.label)
      .toBe("Renews");
  });

  it("reports the trial end during a trial", () => {
    expect(
      subscriptionTimeline({ status: "trialing", trialEndsAt: "2026-10-01T00:00:00.000Z" })?.label,
    ).toBe("Trial ends");
  });

  it("returns nothing when no date is known or parseable", () => {
    expect(subscriptionTimeline({ status: "active" })).toBeNull();
    expect(subscriptionTimeline({ status: "active", renewsAt: "not-a-date" })).toBeNull();
  });
});

describe("canResume", () => {
  it("offers resume for a cancelled subscription still inside its period", () => {
    expect(canResume({ status: "active", endsAt: "2026-09-15T00:00:00.000Z" })).toBe(true);
    expect(canResume({ status: "inactive", subscriptionStatus: "cancelled" })).toBe(true);
    expect(canResume({ status: "active", renewsAt: "2026-09-15T00:00:00.000Z" })).toBe(false);
  });
});

describe("priceFor", () => {
  const plan: BillingPlan = {
    planKey: "pro",
    name: "Pro",
    description: "",
    features: [],
    trialDays: 0,
    prices: [
      { billingPeriod: "month", priceAmountCents: 2000, priceCurrency: "USD" },
      { billingPeriod: "year", priceAmountCents: 20000, priceCurrency: "USD" },
    ],
  };

  it("selects the price for the requested period", () => {
    expect(priceFor(plan, "year")?.priceAmountCents).toBe(20000);
    expect(priceFor({ ...plan, prices: [] }, "month")).toBeUndefined();
  });
});

describe("quotaMeter", () => {
  it("reads nothing where there is no allowance to report", () => {
    expect(quotaMeter(null)).toBeNull();
    expect(quotaMeter(undefined)).toBeNull();
  });

  it("measures the month against the plan's ceiling", () => {
    const meter = quotaMeter({ month: "2026-09", used: 2_500, limit: 10_000, resetAt: RESETS });
    expect(meter?.ratio).toBe(0.25);
    expect(meter?.tone).toBe("normal");
    expect(meter?.label).toBe("2,500 of 10,000 requests");
    expect(meter?.caption).toMatch(/^Resets /);
  });

  it("warns from four fifths and escalates once the allowance is gone", () => {
    expect(quotaMeter({ month: "2026-09", used: 7_999, limit: 10_000, resetAt: RESETS })?.tone)
      .toBe("normal");
    expect(quotaMeter({ month: "2026-09", used: 8_000, limit: 10_000, resetAt: RESETS })?.tone)
      .toBe("warning");
    expect(quotaMeter({ month: "2026-09", used: 10_000, limit: 10_000, resetAt: RESETS })?.tone)
      .toBe("destructive");
  });

  it("caps the reading at a full bar when the month ran past the allowance", () => {
    // A plan lowered mid-month leaves used above limit; the bar cannot overflow.
    const meter = quotaMeter({ month: "2026-09", used: 12_000, limit: 10_000, resetAt: RESETS });
    expect(meter?.ratio).toBe(1);
    expect(meter?.tone).toBe("destructive");
  });

  it("reads an allowance of zero as spent rather than as no reading at all", () => {
    const meter = quotaMeter({ month: "2026-09", used: 0, limit: 0, resetAt: RESETS });
    expect(meter?.ratio).toBe(1);
    expect(meter?.tone).toBe("destructive");
  });

  it("reports a plain count for a plan with no ceiling", () => {
    const meter = quotaMeter({ month: "2026-09", used: 1_234, resetAt: RESETS });
    expect(meter?.limit).toBeNull();
    expect(meter?.ratio).toBeNull();
    expect(meter?.tone).toBe("normal");
    expect(meter?.label).toBe("1,234 requests this month");
  });
});

describe("quotaNotice", () => {
  it("stays silent while the allowance is comfortable, or absent", () => {
    expect(quotaNotice({ month: "2026-09", used: 10, limit: 10_000, resetAt: RESETS })).toBeNull();
    expect(quotaNotice({ month: "2026-09", used: 10_000_000, resetAt: RESETS })).toBeNull();
    expect(quotaNotice(null)).toBeNull();
  });

  it("warns before the allowance runs out and says where the month stands", () => {
    const notice = quotaNotice({ month: "2026-09", used: 9_000, limit: 10_000, resetAt: RESETS });
    expect(notice?.tone).toBe("warning");
    expect(notice?.description).toContain("9,000 of 10,000 requests");
    expect(notice?.actionable).toBe(true);
  });

  it("escalates once requests are being refused", () => {
    const notice = quotaNotice({ month: "2026-09", used: 10_000, limit: 10_000, resetAt: RESETS });
    expect(notice?.tone).toBe("destructive");
    expect(notice?.title).toMatch(/spent/i);
    expect(notice?.description).toMatch(/refused/i);
  });
});

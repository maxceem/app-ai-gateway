import { describe, expect, it } from "vitest";
import {
  billingNotice,
  canCancel,
  canResume,
  formatBillingDateTime,
  priceFor,
  quotaMeter,
  quotaNotice,
  subscriptionTimeline,
} from "./billing";
import type {
  BillingAccess,
  BillingPlan,
  BillingSubscriptionStatus,
  EntitledPlan,
  OrganizationQuota,
  SubscriptionState,
} from "./types";

const RESETS = "2026-10-08T03:15:00.000Z";
const STARTS = "2026-09-08T03:15:00.000Z";

const quota = (overrides: Partial<OrganizationQuota> = {}): OrganizationQuota => ({
  periodId: `free:${STARTS}`,
  periodStart: STARTS,
  periodEnd: RESETS,
  used: 2_500,
  limit: 10_000,
  resetAt: RESETS,
  ...overrides,
});

const subscription = (overrides: Partial<SubscriptionState> = {}): SubscriptionState => ({
  subscriptionId: "sub-console",
  status: "active",
  planKey: "pro",
  planName: "Pro",
  billingPeriod: "month",
  renewsAt: null,
  endsAt: null,
  trialEndsAt: null,
  source: "lemon_squeezy",
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
  billingAnchorDay: 1,
  billingAnchorAt: "2025-01-01T00:00:00.000Z",
  billingScheduleUpdatedAt: "2025-01-01T00:00:00.000Z",
  ...overrides,
});

const paidPlan: EntitledPlan = { planKey: "pro", planName: "Pro", isDefault: false };
const freePlan: EntitledPlan = {
  planKey: "free",
  planName: "Free",
  limits: { maxRequestsPerMonth: 1000 },
  isDefault: true,
};

const billed = (
  plan: EntitledPlan | null,
  sub: SubscriptionState | null = null,
): BillingAccess => ({ state: "billed", plan, subscription: sub });

describe("billingNotice", () => {
  it("stays silent for a self-hosted deployment", () => {
    expect(billingNotice({ state: "self_hosted" })).toBeNull();
  });

  it("stays silent when billing status is unknown", () => {
    expect(billingNotice(undefined)).toBeNull();
    expect(billingNotice(null)).toBeNull();
  });

  it("stays silent for a healthy paid subscription", () => {
    expect(billingNotice(billed(paidPlan, subscription()))).toBeNull();
  });

  /**
   * The quota meter already states the free allowance in full. A banner on a
   * working organization that never subscribed would be permanent nagging, not
   * information.
   */
  it("stays silent for a fresh organization on the default plan", () => {
    expect(billingNotice(billed(freePlan))).toBeNull();
  });

  it("warns that traffic moved to the default plan when a subscription ends", () => {
    const notice = billingNotice(billed(freePlan, subscription({ status: "expired" })));
    // Traffic still flows, so this is a change of allowance, not an outage.
    expect(notice?.tone).toBe("warning");
    expect(notice?.title).toMatch(/subscription has ended/i);
    expect(notice?.description).toMatch(/Free plan \(1,000 requests\/month\)/);
    expect(notice?.actionable).toBe(true);
  });

  it("warns about a past-due payment that has not yet cost the plan", () => {
    const notice = billingNotice(billed(paidPlan, subscription({ status: "past_due" })));
    expect(notice?.tone).toBe("warning");
    expect(notice?.title).toMatch(/past due/i);
    expect(notice?.actionable).toBe(true);
  });

  it("escalates when no plan resolves at all", () => {
    const notice = billingNotice(billed(null));
    expect(notice?.tone).toBe("destructive");
    expect(notice?.title).toMatch(/no active plan/i);
    expect(notice?.actionable).toBe(true);
  });

  it("does not offer plans for an unreachable billing service", () => {
    const notice = billingNotice({ state: "unavailable" });
    expect(notice?.tone).toBe("destructive");
    expect(notice?.actionable).toBe(false);
  });
});

describe("subscriptionTimeline", () => {
  it("prefers the end date of a canceled subscription over its renewal", () => {
    const timeline = subscriptionTimeline(subscription({
      renewsAt: "2026-10-01T00:00:00.000Z",
      endsAt: "2026-09-15T00:00:00.000Z",
    }));
    expect(timeline?.label).toBe("Access ends");
  });

  it("reports the renewal date of a healthy subscription", () => {
    expect(subscriptionTimeline(subscription({ renewsAt: "2026-10-01T00:00:00.000Z" }))?.label)
      .toBe("Renews");
  });

  it("reports the trial end during a trial", () => {
    expect(
      subscriptionTimeline(subscription({
        status: "on_trial",
        trialEndsAt: "2026-10-01T00:00:00.000Z",
      }))?.label,
    ).toBe("Trial ends");
  });

  it("returns nothing when no date is known or parseable", () => {
    expect(subscriptionTimeline(subscription())).toBeNull();
    expect(subscriptionTimeline(subscription({ renewsAt: "not-a-date" }))).toBeNull();
  });
});

describe("canCancel / canResume", () => {
  it.each<BillingSubscriptionStatus>(["on_trial", "active", "paused", "past_due"])(
    "offers cancel for a %s subscription",
    (status) => {
      expect(canCancel(subscription({ status }))).toBe(true);
      expect(canResume(subscription({ status }))).toBe(false);
    },
  );

  it("offers resume, and not cancel, for a cancelled subscription", () => {
    expect(canResume(subscription({ status: "cancelled" }))).toBe(true);
    expect(canCancel(subscription({ status: "cancelled" }))).toBe(false);
  });

  it("offers neither once the subscription is gone for good", () => {
    for (const status of ["expired", "unpaid"] as const) {
      expect(canCancel(subscription({ status }))).toBe(false);
      expect(canResume(subscription({ status }))).toBe(false);
    }
    expect(canCancel(null)).toBe(false);
    expect(canResume(null)).toBe(false);
  });

  it("never offers to cancel a manual grant, which is not LemonSqueezy's to cancel", () => {
    expect(canCancel(subscription({ source: "manual" }))).toBe(false);
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

  it("measures the current plan period against its ceiling", () => {
    const meter = quotaMeter(quota());
    expect(meter?.ratio).toBe(0.25);
    expect(meter?.tone).toBe("normal");
    expect(meter?.label).toBe("2,500 of 10,000 requests");
    expect(meter?.caption).toMatch(/^Resets /);
    expect(meter?.period).not.toBe("Period dates unavailable");
  });

  it("warns from four fifths and escalates once the allowance is gone", () => {
    expect(quotaMeter(quota({ used: 7_999 }))?.tone)
      .toBe("normal");
    expect(quotaMeter(quota({ used: 8_000 }))?.tone)
      .toBe("warning");
    expect(quotaMeter(quota({ used: 10_000 }))?.tone)
      .toBe("destructive");
  });

  it("caps the reading at a full bar when the period ran past the allowance", () => {
    // A plan lowered during a period leaves used above limit; the bar cannot overflow.
    const meter = quotaMeter(quota({ used: 12_000 }));
    expect(meter?.ratio).toBe(1);
    expect(meter?.tone).toBe("destructive");
  });

  it("reads an allowance of zero as spent rather than as no reading at all", () => {
    const meter = quotaMeter(quota({ used: 0, limit: 0 }));
    expect(meter?.ratio).toBe(1);
    expect(meter?.tone).toBe("destructive");
  });

  it("reports a plain count for a plan with no ceiling", () => {
    const { limit: _limit, ...quotaWithoutLimit } = quota({ used: 1_234 });
    const meter = quotaMeter(quotaWithoutLimit);
    expect(meter?.limit).toBeNull();
    expect(meter?.ratio).toBeNull();
    expect(meter?.tone).toBe("normal");
    expect(meter?.label).toBe("1,234 requests this period");
  });

  it("shows exact period and reset instants in the viewer's time zone", () => {
    const meter = quotaMeter(quota());
    expect(meter?.period).toContain(formatBillingDateTime(STARTS));
    expect(meter?.period).toContain(formatBillingDateTime(RESETS));
    expect(meter?.caption).toBe(`Resets ${formatBillingDateTime(RESETS)}`);
  });

  it("does not invent a calendar-month reset when a timestamp is invalid", () => {
    expect(quotaMeter(quota({ resetAt: "invalid" }))?.caption).toBe("Reset time unavailable");
  });
});

describe("quotaNotice", () => {
  it("stays silent while the allowance is comfortable, or absent", () => {
    expect(quotaNotice(quota({ used: 10 }))).toBeNull();
    const { limit: _limit, ...quotaWithoutLimit } = quota({ used: 10_000_000 });
    expect(quotaNotice(quotaWithoutLimit)).toBeNull();
    expect(quotaNotice(null)).toBeNull();
  });

  it("warns before the allowance runs out and says where the period stands", () => {
    const notice = quotaNotice(quota({ used: 9_000 }));
    expect(notice?.tone).toBe("warning");
    expect(notice?.description).toContain("9,000 of 10,000 requests");
    expect(notice?.actionable).toBe(true);
  });

  it("escalates once requests are being refused", () => {
    const notice = quotaNotice(quota({ used: 10_000 }));
    expect(notice?.tone).toBe("destructive");
    expect(notice?.title).toMatch(/spent/i);
    expect(notice?.description).toMatch(/refused/i);
  });
});

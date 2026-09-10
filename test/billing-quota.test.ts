import type { BillingAccess, BillingRuntime, SubscriptionState } from "../src/billing/contract";
import { clearBillingAccessCache, invalidateBillingAccess } from "../src/billing/gateway";
import {
  anniversaryPeriod,
  clearOrganizationQuotaAnchorCache,
  resolveBillingQuota,
} from "../src/billing/quota";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

function subscription(overrides: Partial<SubscriptionState> = {}): SubscriptionState {
  return {
    subscriptionId: "sub-anniversary",
    status: "active",
    planKey: "pro",
    planName: "Pro",
    billingPeriod: "month",
    renewsAt: null,
    endsAt: null,
    trialEndsAt: null,
    source: "lemon_squeezy",
    createdAt: "2026-01-31T12:34:56.789Z",
    updatedAt: "2026-01-31T12:34:56.789Z",
    billingAnchorDay: 31,
    billingAnchorAt: "2026-01-31T12:34:56.789Z",
    billingScheduleUpdatedAt: "2026-01-31T12:34:56.789Z",
    ...overrides,
  };
}

function hosted(access: BillingAccess): Env {
  const billing = {
    getTenantAccess: async () => access,
    listPlans: async () => ({ plans: [] }),
    createCheckout: async () => ({ url: "https://checkout.example.test" }),
    changePlan: async () => ({ ok: true as const }),
    resumeSubscription: async () => ({ ok: true as const }),
    cancelSubscription: async () => ({ ok: true as const }),
    startTrial: async () => access,
    handleLemonWebhook: async () => ({ ok: true as const, duplicate: false, stale: false }),
  } satisfies BillingRuntime;
  return new Proxy(env, {
    get: (target, property, receiver) =>
      property === "BILLING" ? billing : Reflect.get(target, property, receiver),
  }) as Env;
}

async function seedOrganization(id: string, createdAt: string): Promise<void> {
  const userId = `${id}-owner`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO console_user(
        id, name, email, email_verified, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?)`,
    ).bind(userId, userId, `${id}@example.test`, Date.parse(createdAt), Date.parse(createdAt)),
    env.DB.prepare(
      `INSERT OR IGNORE INTO console_organization(
        id, name, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(id, id, userId, createdAt, createdAt),
  ]);
}

afterEach(() => {
  vi.useRealTimers();
  clearBillingAccessCache();
  clearOrganizationQuotaAnchorCache();
});

describe("billing quota anniversary periods", () => {
  it("clamps short months from the original day without drift", () => {
    const anchor = Date.parse("2025-01-31T12:34:56.789Z");
    expect(anniversaryPeriod(anchor, 31, Date.parse("2025-02-15T00:00:00.000Z")))
      .toEqual({
        start: anchor,
        end: Date.parse("2025-02-28T12:34:56.789Z"),
      });
    expect(anniversaryPeriod(anchor, 31, Date.parse("2025-03-15T00:00:00.000Z")))
      .toEqual({
        start: Date.parse("2025-02-28T12:34:56.789Z"),
        end: Date.parse("2025-03-31T12:34:56.789Z"),
      });
  });

  it("uses the exact first anchor before switching to the provider anchor day", () => {
    const anchor = Date.parse("2026-08-09T08:00:00.000Z");
    expect(anniversaryPeriod(anchor, 20, Date.parse("2026-08-10T00:00:00.000Z")))
      .toEqual({
        start: anchor,
        end: Date.parse("2026-08-20T08:00:00.000Z"),
      });
    expect(anniversaryPeriod(anchor, 20, Date.parse("2026-08-21T00:00:00.000Z")))
      .toEqual({
        start: Date.parse("2026-08-20T08:00:00.000Z"),
        end: Date.parse("2026-09-20T08:00:00.000Z"),
      });
  });

  it("uses the organization creation instant for Free", async () => {
    const organizationId = "quota-free-anchor";
    const createdAt = "2026-01-31T05:06:07.008Z";
    await seedOrganization(organizationId, createdAt);
    const access: BillingAccess = {
      plan: {
        planKey: "free",
        planName: "Free",
        limits: { maxRequestsPerMonth: 1_000 },
        isDefault: true,
      },
      subscription: null,
    };
    const resolved = await resolveBillingQuota(
      hosted(access),
      organizationId,
      undefined,
      Date.parse("2026-02-15T00:00:00.000Z"),
    );
    expect(resolved.period).toMatchObject({
      periodStart: createdAt,
      periodEnd: "2026-02-28T05:06:07.008Z",
      resetAt: "2026-02-28T05:06:07.008Z",
    });
  });

  it("gives annual subscriptions monthly allowance periods", async () => {
    const organizationId = "quota-annual";
    await seedOrganization(organizationId, "2025-01-01T00:00:00.000Z");
    const access: BillingAccess = {
      plan: {
        planKey: "pro",
        planName: "Pro",
        limits: { maxRequestsPerMonth: 10_000 },
        isDefault: false,
      },
      subscription: subscription({ billingPeriod: "year" }),
    };
    const resolved = await resolveBillingQuota(
      hosted(access),
      organizationId,
      undefined,
      Date.parse("2026-03-15T00:00:00.000Z"),
    );
    expect(resolved.period).toMatchObject({
      periodStart: "2026-02-28T12:34:56.789Z",
      periodEnd: "2026-03-31T12:34:56.789Z",
    });
  });

  it("lets a resume after expiry replace Free with the paid schedule", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-03-15T00:00:00.000Z");
    const organizationId = "quota-expired-resume";
    await seedOrganization(organizationId, "2026-01-10T00:00:00.000Z");
    const access: BillingAccess = {
      plan: { planKey: "free", planName: "Free", limits: {}, isDefault: true },
      subscription: subscription({
        status: "cancelled",
        endsAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-02-20T00:00:00.000Z",
      }),
    };
    const billingEnv = hosted(access);
    const free = await resolveBillingQuota(billingEnv, organizationId);
    expect(free.period.scheduleId).toMatch(/^free:/u);
    expect(free.period.scheduleRevision).toBe(Date.parse("2026-03-01T00:00:00.000Z"));
    expect(await env.ORG_QUOTA.getByName(organizationId).admit({
      limit: 10,
      ...free.period,
    })).toMatchObject({ allowed: true, used: 1 });

    access.plan = { planKey: "pro", planName: "Pro", limits: {}, isDefault: false };
    access.subscription = subscription({
      updatedAt: "2026-03-10T00:00:00.000Z",
    });
    invalidateBillingAccess(organizationId);
    const paid = await resolveBillingQuota(billingEnv, organizationId);
    expect(paid.period.scheduleId).toMatch(/^paid:/u);
    expect(paid.period.scheduleRevision).toBe(Date.parse("2026-03-10T00:00:00.000Z"));
    expect(await env.ORG_QUOTA.getByName(organizationId).admit({
      limit: 10,
      ...paid.period,
    })).toMatchObject({ allowed: true, used: 1 });
  });
});


describe("billing schedule validation", () => {
  const paid = (value: SubscriptionState | null): BillingAccess => ({
    plan: { planKey: "pro", planName: "Pro", limits: {}, isDefault: false },
    subscription: value,
  });

  it.each([
    ["billingAnchorAt", undefined], ["billingAnchorAt", 123],
    ["billingScheduleUpdatedAt", undefined], ["updatedAt", {}],
    ["createdAt", "invalid"], ["billingAnchorDay", undefined], ["billingAnchorDay", 32],
  ])("rejects malformed %s with billing_unavailable", async (field, value) => {
    const payload = subscription({ [field]: value } as Partial<SubscriptionState>);
    await expect(resolveBillingQuota(hosted(paid(payload)), `invalid-${field}`))
      .rejects.toMatchObject({ status: 502, code: "billing_unavailable" });
  });

  it("uses the anchor date for manual grants with a null anchor day", async () => {
    await expect(resolveBillingQuota(hosted(paid(subscription({ billingAnchorDay: null }))),
      "manual-null-day", undefined, Date.parse("2026-03-15T00:00:00.000Z")))
      .resolves.toMatchObject({ period: { periodEnd: "2026-03-31T12:34:56.789Z" } });
  });

  it("rejects a paid plan without a subscription", async () => {
    await expect(resolveBillingQuota(hosted(paid(null)), "missing-subscription"))
      .rejects.toMatchObject({ status: 502, code: "billing_unavailable" });
  });

  it("requires a Free subscription revision instead of silently losing it", async () => {
    const id = "free-missing-revision";
    await seedOrganization(id, "2025-01-01T00:00:00.000Z");
    const access = paid(subscription({ updatedAt: undefined } as unknown as Partial<SubscriptionState>));
    access.plan!.isDefault = true;
    await expect(resolveBillingQuota(hosted(access), id))
      .rejects.toMatchObject({ status: 502, code: "billing_unavailable" });
  });

  it("uses the observation clock after billing I/O and needs no paid organization lookup", async () => {
    vi.useFakeTimers();
    const anchor = Date.parse("2026-08-01T00:00:00.000Z");
    vi.setSystemTime(anchor - 10);
    const access = paid(subscription({ billingAnchorAt: new Date(anchor).toISOString(), billingAnchorDay: 1 }));
    const billingEnv = hosted(access);
    vi.spyOn(billingEnv.BILLING!, "getTenantAccess").mockImplementation(async () => {
      vi.setSystemTime(anchor + 10);
      return access;
    });
    await expect(resolveBillingQuota(billingEnv, "no-d1-organization"))
      .resolves.toMatchObject({ period: { periodStart: new Date(anchor).toISOString() } });
  });

  it.each([[500, 503], [60_001, 502]])("handles a future anchor %i ms away", async (ahead, status) => {
    const now = Date.parse("2026-08-01T00:00:00.000Z");
    const access = paid(subscription({ billingAnchorAt: new Date(now + ahead).toISOString() }));
    await expect(resolveBillingQuota(hosted(access), "future-anchor", undefined, now))
      .rejects.toMatchObject({ status, code: "billing_unavailable", ...(status === 503 ? { headers: { "Retry-After": "1" } } : {}) });
    expect(() => anniversaryPeriod(now + ahead, 1, now)).toThrow("future");
  });
});

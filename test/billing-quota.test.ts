import type { BillingAccess, BillingRuntime, SubscriptionState } from "../src/billing/contract";
import { invalidateBillingAccess } from "../src/billing/gateway";
import { anniversaryPeriod, resolveBillingQuota } from "../src/billing/quota";
import { invalidateAccountLifecycle } from "../src/core/account-lifecycle";
import { clearIsolateCaches } from "./helpers";
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
      `INSERT OR IGNORE INTO mgmt_user(
        id, name, email, email_verified, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?)`,
    ).bind(userId, userId, `${id}@example.test`, Date.parse(createdAt), Date.parse(createdAt)),
    env.DB.prepare(
      `INSERT OR IGNORE INTO mgmt_organization(
        id, name, created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(id, id, userId, createdAt, createdAt),
  ]);
}

afterEach(() => {
  vi.useRealTimers();
  clearIsolateCaches();
});

describe("billing quota anniversary periods", () => {
  it("clamps short months from the original day without drift", () => {
    const anchor = Date.parse("2025-01-31T12:34:56.789Z");
    expect(anniversaryPeriod(anchor, 31, Date.parse("2025-02-15T00:00:00.000Z"))).toEqual({
      start: anchor,
      end: Date.parse("2025-02-28T12:34:56.789Z"),
    });
    expect(anniversaryPeriod(anchor, 31, Date.parse("2025-03-15T00:00:00.000Z"))).toEqual({
      start: Date.parse("2025-02-28T12:34:56.789Z"),
      end: Date.parse("2025-03-31T12:34:56.789Z"),
    });
  });

  it("uses the exact first anchor before switching to the provider anchor day", () => {
    const anchor = Date.parse("2026-08-09T08:00:00.000Z");
    expect(anniversaryPeriod(anchor, 20, Date.parse("2026-08-10T00:00:00.000Z"))).toEqual({
      start: anchor,
      end: Date.parse("2026-08-20T08:00:00.000Z"),
    });
    expect(anniversaryPeriod(anchor, 20, Date.parse("2026-08-21T00:00:00.000Z"))).toEqual({
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
    expect(
      await env.ORG_QUOTA.getByName(organizationId).admit({
        limit: 10,
        ...free.period,
      }),
    ).toMatchObject({ allowed: true, used: 1 });

    access.plan = { planKey: "pro", planName: "Pro", limits: {}, isDefault: false };
    access.subscription = subscription({
      updatedAt: "2026-03-10T00:00:00.000Z",
    });
    invalidateBillingAccess(organizationId);
    const paid = await resolveBillingQuota(billingEnv, organizationId);
    expect(paid.period.scheduleId).toMatch(/^paid:/u);
    expect(paid.period.scheduleRevision).toBe(Date.parse("2026-03-10T00:00:00.000Z"));
    expect(
      await env.ORG_QUOTA.getByName(organizationId).admit({
        limit: 10,
        ...paid.period,
      }),
    ).toMatchObject({ allowed: true, used: 1 });
  });
});

describe("billing schedule validation", () => {
  const paid = (value: SubscriptionState | null): BillingAccess => ({
    plan: { planKey: "pro", planName: "Pro", limits: {}, isDefault: false },
    subscription: value,
  });

  it.each([
    ["billingAnchorAt", undefined],
    ["billingAnchorAt", 123],
    ["billingScheduleUpdatedAt", undefined],
    ["updatedAt", {}],
    ["createdAt", "invalid"],
    ["billingAnchorDay", undefined],
    ["billingAnchorDay", 32],
  ])("rejects malformed %s with billing_unavailable", async (field, value) => {
    const payload = subscription({ [field]: value } as Partial<SubscriptionState>);
    await expect(
      resolveBillingQuota(hosted(paid(payload)), `invalid-${field}`),
    ).rejects.toMatchObject({ status: 502, code: "billing_unavailable" });
  });

  it("uses the anchor date for manual grants with a null anchor day", async () => {
    await expect(
      resolveBillingQuota(
        hosted(paid(subscription({ billingAnchorDay: null }))),
        "manual-null-day",
        undefined,
        Date.parse("2026-03-15T00:00:00.000Z"),
      ),
    ).resolves.toMatchObject({ period: { periodEnd: "2026-03-31T12:34:56.789Z" } });
  });

  it("rejects a paid plan without a subscription", async () => {
    await expect(
      resolveBillingQuota(hosted(paid(null)), "missing-subscription"),
    ).rejects.toMatchObject({ status: 502, code: "billing_unavailable" });
  });

  it("requires a Free subscription revision instead of silently losing it", async () => {
    const id = "free-missing-revision";
    await seedOrganization(id, "2025-01-01T00:00:00.000Z");
    const access = paid(
      subscription({ updatedAt: undefined } as unknown as Partial<SubscriptionState>),
    );
    access.plan!.isDefault = true;
    await expect(resolveBillingQuota(hosted(access), id)).rejects.toMatchObject({
      status: 502,
      code: "billing_unavailable",
    });
  });

  it("uses the observation clock after billing I/O and needs no paid organization lookup", async () => {
    vi.useFakeTimers();
    const anchor = Date.parse("2026-08-01T00:00:00.000Z");
    vi.setSystemTime(anchor - 10);
    const access = paid(
      subscription({ billingAnchorAt: new Date(anchor).toISOString(), billingAnchorDay: 1 }),
    );
    const billingEnv = hosted(access);
    vi.spyOn(billingEnv.BILLING!, "getTenantAccess").mockImplementation(async () => {
      vi.setSystemTime(anchor + 10);
      return access;
    });
    await expect(resolveBillingQuota(billingEnv, "no-d1-organization")).resolves.toMatchObject({
      period: { periodStart: new Date(anchor).toISOString() },
    });
  });

  it.each([
    [500, 503],
    [60_001, 502],
  ])("handles a future anchor %i ms away", async (ahead, status) => {
    const now = Date.parse("2026-08-01T00:00:00.000Z");
    const access = paid(subscription({ billingAnchorAt: new Date(now + ahead).toISOString() }));
    await expect(
      resolveBillingQuota(hosted(access), "future-anchor", undefined, now),
    ).rejects.toMatchObject({
      status,
      code: "billing_unavailable",
      ...(status === 503 ? { headers: { "Retry-After": "1" } } : {}),
    });
    expect(() => anniversaryPeriod(now + ahead, 1, now)).toThrow("future");
  });
});

/** The claim route drops the cached lifecycle row; a direct write has to do the same. */
async function claimOrganization(id: string, joinedAt = new Date().toISOString()) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO mgmt_organization_user(id,organization_id,user_id,role,status,joined_at)
       VALUES (?,?,?,'owner','active',?)`,
    ).bind(`${id}-human-owner`, id, `${id}-owner`, joinedAt),
    env.DB.prepare("UPDATE mgmt_organization SET expires_at=NULL WHERE id=?").bind(id),
  ]);
  invalidateAccountLifecycle(id);
}

/** What a cloud bootstrap leaves behind: a recovery deadline and no human owner. */
async function seedCliAccount(id: string, origin: string, claimed = false) {
  await seedOrganization(id, origin);
  await env.DB.prepare("UPDATE mgmt_organization SET expires_at=? WHERE id=?")
    .bind(claimed ? null : new Date(Date.parse(origin) + 90 * 86400000).toISOString(), id)
    .run();
  invalidateAccountLifecycle(id);
  if (claimed) await claimOrganization(id, origin);
}

const freeAccess = (limit: number | null = 1000): BillingAccess => ({
  plan: { planKey: "free", planName: "Free", isDefault: true, limits: limit === null ? {} : { maxRequestsPerMonth: limit } },
  subscription: null,
});

describe("initial free access schedule", () => {
  it("holds one period that never renews while nobody has claimed the account", async () => {
    vi.useFakeTimers();
    const origin = "2026-01-31T12:34:56.789Z";
    const end = "2026-03-02T12:34:56.789Z";
    vi.setSystemTime(new Date("2026-02-28T12:34:56.789Z"));
    await seedCliAccount("unclaimed", origin);
    const runtime = hosted(freeAccess(5000));
    const cache = new Map();
    const first = await resolveBillingQuota(runtime, "unclaimed", cache);
    expect(first.limit).toBe(5000);
    expect(first.access).toMatchObject({ subscription: null, plan: { planKey: "free" } });
    expect(first.period).toMatchObject({ periodStart: origin, periodEnd: end });
    expect(first.period.scheduleId).toMatch(/^free:/);
    const quota = env.ORG_QUOTA.getByName("onboarding-unclaimed");
    expect(await quota.admit({ ...first.period, limit: 1 })).toMatchObject({ allowed: true, used: 1 });
    // Past the end the window stays exactly where it was: an account nobody has
    // claimed never draws a second allowance, and its counter stays readable.
    vi.setSystemTime(new Date("2026-03-20T12:34:56.789Z"));
    const expired = await resolveBillingQuota(runtime, "unclaimed", cache);
    expect(expired.period).toEqual(first.period);
    expect(await quota.admit({ ...expired.period, limit: 1 })).toEqual({ allowed: false, superseded: true });
    expect(await quota.pastUsage(expired.period)).toMatchObject({ used: 1 });
  });

  it("moves a claimed account onto the ordinary renewing free schedule", async () => {
    vi.useFakeTimers();
    const origin = "2026-01-31T12:34:56.789Z";
    vi.setSystemTime(new Date("2026-02-15T12:34:56.789Z"));
    await seedCliAccount("claimed", origin);
    const runtime = hosted(freeAccess(5000));
    const cache = new Map();
    const before = await resolveBillingQuota(runtime, "claimed", cache);
    expect(before.period).toMatchObject({ periodStart: origin, periodEnd: "2026-03-02T12:34:56.789Z" });
    await claimOrganization("claimed");
    const after = await resolveBillingQuota(runtime, "claimed", cache);
    expect(after.limit).toBe(5000);
    expect(after.period.scheduleId).toMatch(/^free:/);
    // Anchored on the account's own creation day, like any other free account.
    expect(after.period).toMatchObject({ periodStart: origin, periodEnd: "2026-02-28T12:34:56.789Z" });
    vi.setSystemTime(new Date("2026-02-28T12:34:56.789Z"));
    const renewed = await resolveBillingQuota(runtime, "claimed", cache);
    expect(renewed.period).toMatchObject({
      scheduleId: after.period.scheduleId,
      periodStart: "2026-02-28T12:34:56.789Z",
      periodEnd: "2026-03-31T12:34:56.789Z",
    });
  });

  it("keeps one counter across a claim, so the trial cannot be replayed as a fresh month", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-15T00:00:00Z"));
    const id = "claimed-mid-period";
    await seedCliAccount(id, "2026-02-01T00:00:00.000Z");
    const runtime = hosted(freeAccess(5000));
    const quota = env.ORG_QUOTA.getByName(id);
    const before = await resolveBillingQuota(runtime, id);
    expect(await quota.admit({ ...before.period, limit: before.limit! }))
      .toMatchObject({ allowed: true, used: 1 });
    await claimOrganization(id);
    const after = await resolveBillingQuota(runtime, id);
    // Same schedule, same period: what the trial spent is still spent.
    expect(after.period.scheduleId).toBe(before.period.scheduleId);
    expect(await quota.admit({ ...after.period, limit: after.limit! }))
      .toMatchObject({ allowed: true, used: 2 });
  });

  it.each([500, null])("uses the same configured free allowance %s before and after claim", async (limit) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-15T00:00:00Z"));
    const id = `configured-free-${limit}`;
    await seedCliAccount(id, "2026-02-01T00:00:00.000Z");
    const runtime = hosted(freeAccess(limit));
    const before = await resolveBillingQuota(runtime, id);
    expect(before.limit).toBe(limit ?? undefined);
    await claimOrganization(id);
    const after = await resolveBillingQuota(runtime, id);
    expect(after.limit).toBe(limit ?? undefined);
    const quota = env.ORG_QUOTA.getByName(id);
    if (after.limit !== undefined) {
      expect(await quota.admit({ ...after.period, limit: after.limit })).toMatchObject({ allowed: true });
    }
    expect(await quota.usage(after.period)).toMatchObject({ used: after.limit === undefined ? 0 : 1 });
  });

  it("does not manufacture access when billing has no entitlement or malformed limits", async () => {
    await seedCliAccount("disabled-trial", new Date(Date.now() - 1000).toISOString());
    await expect(resolveBillingQuota(hosted({ plan: null, subscription: null }), "disabled-trial"))
      .rejects.toMatchObject({ code: "billing_payment_required" });
    invalidateBillingAccess("disabled-trial");
    const access = freeAccess();
    access.plan!.limits = { maxRequestsPerMonth: -1 };
    await expect(resolveBillingQuota(hosted(access), "disabled-trial"))
      .rejects.toMatchObject({ code: "billing_unavailable" });
  });
});

it.each([
  ["manual", "active"], ["lemon_squeezy", "active"], ["lemon_squeezy", "on_trial"],
] as const)("keeps %s %s subscriptions on their paid schedule despite initial free access metadata", async (source, status) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-02-15T00:00:00Z"));
  const id = `override-${source}-${status}`;
  await seedCliAccount(id, "2026-01-31T00:00:00.000Z");
  const access: BillingAccess = {
    plan: { planKey: "pro", planName: "Pro", isDefault: false, limits: { maxRequestsPerMonth: 9000 } },
    subscription: subscription({ subscriptionId: source === "manual" ? null : "paid", source, status,
      trialEndsAt: status === "on_trial" ? "2026-03-01T00:00:00.000Z" : null,
      billingAnchorAt: "2026-02-01T00:00:00.000Z", createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z", billingAnchorDay: 1 }),
  };
  const result = await resolveBillingQuota(hosted(access), id);
  expect(result.limit).toBe(9000);
  expect(result.period.scheduleId).toMatch(/^paid:/);
  expect(result.period.periodStart).toBe("2026-02-01T00:00:00.000Z");
  access.subscription = { ...access.subscription!, status: "expired" };
  access.plan = freeAccess().plan;
  invalidateBillingAccess(id);
  const fallback = await resolveBillingQuota(hosted(access), id);
  expect(fallback.period.scheduleId).toMatch(/^free:/);
  expect(fallback.period.periodStart).toBe("2026-01-31T00:00:00.000Z");
  expect(fallback.limit).toBe(1000);
});

it("can adopt an earlier manual grant after a claim read through cached default access", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-02-15T00:00:00Z"));
  const id = "claim-with-earlier-grant";
  await seedCliAccount(id, "2026-01-31T00:00:00.000Z");
  const access = freeAccess();
  const runtime = hosted(access);
  await resolveBillingQuota(runtime, id);
  await claimOrganization(id);
  const cachedDefault = await resolveBillingQuota(runtime, id);
  const quota = env.ORG_QUOTA.getByName(id);
  expect(await quota.admit({ ...cachedDefault.period, limit: 1000 })).toMatchObject({ allowed: true, used: 1 });
  access.plan = { planKey: "manual-pro", planName: "Pro", isDefault: false, limits: { maxRequestsPerMonth: 9000 } };
  access.subscription = subscription({ source: "manual", subscriptionId: null,
    createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z",
    billingAnchorAt: "2026-02-01T00:00:00.000Z", billingScheduleUpdatedAt: "2026-02-01T00:00:00.000Z",
    billingAnchorDay: 1, endsAt: "2026-02-20T00:00:00.000Z" });
  invalidateBillingAccess(id);
  const paid = await resolveBillingQuota(runtime, id);
  expect(await quota.admit({ ...paid.period, limit: paid.limit! })).toMatchObject({ allowed: true, used: 1 });
  vi.setSystemTime(new Date("2026-02-20T00:00:00Z"));
  access.plan = freeAccess().plan;
  access.subscription.status = "expired";
  invalidateBillingAccess(id);
  const fallback = await resolveBillingQuota(runtime, id);
  expect(fallback.period.scheduleRevision).toBe(Date.now());
  expect(await quota.admit({ ...fallback.period, limit: fallback.limit! })).toMatchObject({ allowed: true, used: 2 });
});

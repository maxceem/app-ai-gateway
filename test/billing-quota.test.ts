import type { BillingAccess, BillingRuntime, SubscriptionState } from "../src/billing/contract";
import { invalidateBillingAccess } from "../src/billing/gateway";
import { allowancePeriod, resolveBillingQuota } from "../src/billing/quota";
import { invalidateAccountLifecycle } from "../src/core/account-lifecycle";
import { clearIsolateCaches } from "./helpers";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDeployment } from "../src/policy/deployment";

/** Resolves a quota the way a request does: with the deployment its environment describes. */
const quotaFor = (
  quotaEnv: Env,
  ...rest: Parameters<typeof resolveBillingQuota> extends [unknown, unknown, ...infer Rest] ? Rest : never
) => resolveBillingQuota(resolveDeployment(quotaEnv), quotaEnv, ...rest);

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

const freeAccess = (limit: number | null = 1000): BillingAccess => ({
  plan: { planKey: "free", planName: "Free", isDefault: true, limits: limit === null ? {} : { maxRequestsPerMonth: limit } },
  subscription: null,
});

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

describe("allowance periods", () => {
  it("renews a free plan on the day the account was created", async () => {
    const organizationId = "quota-free-anniversary";
    await seedOrganization(organizationId, "2026-01-31T05:06:07.008Z");
    const resolved = await quotaFor(
      hosted(freeAccess(1_000)),
      organizationId,
      undefined,
      Date.parse("2026-02-15T00:00:00.000Z"),
    );
    expect(resolved.limit).toBe(1_000);
    // January 31st renews on the last day of February, then on March 31st.
    expect(resolved.period).toEqual({
      periodId: "free:2026-01-31T05:06:07.008Z:2026-01-31T05:06:07.008Z",
      periodStart: "2026-01-31T05:06:07.008Z",
      periodEnd: "2026-02-28T05:06:07.008Z",
      resetAt: "2026-02-28T05:06:07.008Z",
    });
    const march = await quotaFor(
      hosted(freeAccess(1_000)),
      organizationId,
      undefined,
      Date.parse("2026-03-15T00:00:00.000Z"),
    );
    expect(march.period).toMatchObject({
      periodStart: "2026-02-28T05:06:07.008Z",
      periodEnd: "2026-03-31T05:06:07.008Z",
    });
  });

  it("renews a paid plan on its subscription's billing anchor", async () => {
    const organizationId = "quota-paid-anniversary";
    await seedOrganization(organizationId, "2025-06-10T00:00:00.000Z");
    const resolved = await quotaFor(
      hosted({
        plan: { planKey: "pro", planName: "Pro", isDefault: false, limits: { maxRequestsPerMonth: 9_000 } },
        subscription: subscription(),
      }),
      organizationId,
      undefined,
      Date.parse("2026-04-30T13:00:00.000Z"),
    );
    expect(resolved.limit).toBe(9_000);
    // The anchor day survives February and April: the 31st clamps to the 30th
    // here and comes back in May. Provider ids never reach the period id.
    expect(resolved.period).toEqual({
      periodId: "paid:2026-01-31T12:34:56.789Z:2026-04-30T12:34:56.789Z",
      periodStart: "2026-04-30T12:34:56.789Z",
      periodEnd: "2026-05-31T12:34:56.789Z",
      resetAt: "2026-05-31T12:34:56.789Z",
    });
  });

  it("starts a fresh allowance when a subscription begins, and resumes the free one when it ends", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-15T00:00:00Z"));
    const id = "quota-upgrade";
    await seedOrganization(id, "2026-01-01T00:00:00.000Z");
    const access = freeAccess(1);
    const runtime = hosted(access);
    const quota = env.ORG_QUOTA.getByName(id);
    const free = await quotaFor(runtime, id);
    expect(await quota.admit({ ...free.period, limit: free.limit! })).toMatchObject({ allowed: true, used: 1 });
    expect(await quota.admit({ ...free.period, limit: free.limit! })).toMatchObject({ allowed: false, used: 1 });

    access.plan = { planKey: "pro", planName: "Pro", isDefault: false, limits: { maxRequestsPerMonth: 9_000 } };
    access.subscription = subscription({
      createdAt: "2026-02-14T09:00:00.000Z",
      billingAnchorAt: "2026-02-14T09:00:00.000Z",
      billingAnchorDay: 14,
    });
    invalidateBillingAccess(id);
    const paid = await quotaFor(runtime, id);
    // The subscription's own period, counted from its anchor, from zero.
    expect(paid.period).toMatchObject({
      periodStart: "2026-02-14T09:00:00.000Z",
      periodEnd: "2026-03-14T09:00:00.000Z",
    });
    expect(await quota.admit({ ...paid.period, limit: paid.limit! })).toMatchObject({ allowed: true, used: 1 });

    // Back on the free plan within the same free period, what it spent is
    // still spent: cancelling does not hand out a second free allowance.
    access.plan = freeAccess(1).plan;
    invalidateBillingAccess(id);
    const again = await quotaFor(runtime, id);
    expect(again.period.periodId).toBe(free.period.periodId);
    expect(await quota.admit({ ...again.period, limit: again.limit! })).toMatchObject({ allowed: false, used: 1 });
  });

  it("refuses a schedule that has not started, and asks for a retry on clock skew", async () => {
    const id = "quota-future-anchor";
    await seedOrganization(id, "2026-01-01T00:00:00.000Z");
    const paid = (anchor: string) => hosted({
      plan: { planKey: "pro", planName: "Pro", isDefault: false, limits: { maxRequestsPerMonth: 9_000 } },
      subscription: subscription({ billingAnchorAt: anchor, billingAnchorDay: null }),
    });
    const now = Date.parse("2026-03-01T00:00:00.000Z");
    await expect(quotaFor(paid("2026-03-01T00:00:30.000Z"), id, undefined, now))
      .rejects.toMatchObject({ status: 503, code: "billing_unavailable" });
    invalidateBillingAccess(id);
    await expect(quotaFor(paid("2026-04-01T00:00:00.000Z"), id, undefined, now))
      .rejects.toMatchObject({ status: 502, code: "billing_unavailable" });
  });

  it("does not manufacture access when billing has no entitlement or malformed limits", async () => {
    await seedCliAccount("disabled-trial", new Date(Date.now() - 1000).toISOString());
    await expect(quotaFor(hosted({ plan: null, subscription: null }), "disabled-trial"))
      .rejects.toMatchObject({ code: "billing_payment_required" });
    invalidateBillingAccess("disabled-trial");
    const access = freeAccess();
    access.plan!.limits = { maxRequestsPerMonth: -1 };
    await expect(quotaFor(hosted(access), "disabled-trial"))
      .rejects.toMatchObject({ code: "billing_unavailable" });
  });
});

describe("the anniversary arithmetic", () => {
  const schedule = { origin: "free:x", anchorAt: Date.parse("2026-01-31T00:00:00.000Z"), anchorDay: 31 };

  it("renews at the anchor instant exactly, never a millisecond early", () => {
    expect(allowancePeriod(schedule, Date.parse("2026-02-27T23:59:59.999Z")).periodStart)
      .toBe("2026-01-31T00:00:00.000Z");
    expect(allowancePeriod(schedule, Date.parse("2026-02-28T00:00:00.000Z")).periodStart)
      .toBe("2026-02-28T00:00:00.000Z");
  });

  it("opens the first period on the anchor when the renewal day comes later that month", () => {
    // A trial that started on the 9th and bills on the 20th: its first period
    // runs to the 20th, and the paid period after it is a counter of its own.
    const trial = { origin: "paid:x", anchorAt: Date.parse("2026-08-09T08:30:00.789Z"), anchorDay: 20 };
    const first = allowancePeriod(trial, Date.parse("2026-08-10T00:00:00.000Z"));
    expect(first).toMatchObject({
      periodStart: "2026-08-09T08:30:00.789Z",
      periodEnd: "2026-08-20T08:30:00.789Z",
    });
    const paid = allowancePeriod(trial, Date.parse("2026-08-20T08:30:00.789Z"));
    expect(paid).toMatchObject({
      periodStart: "2026-08-20T08:30:00.789Z",
      periodEnd: "2026-09-20T08:30:00.789Z",
    });
    expect(paid.periodId).not.toBe(first.periodId);
  });

  it("opens the first period on the anchor when the renewal day came earlier that month", () => {
    const late = { origin: "paid:x", anchorAt: Date.parse("2026-08-25T00:00:00.000Z"), anchorDay: 5 };
    expect(allowancePeriod(late, Date.parse("2026-08-30T00:00:00.000Z"))).toMatchObject({
      periodStart: "2026-08-25T00:00:00.000Z",
      periodEnd: "2026-09-05T00:00:00.000Z",
    });
  });

  it("clamps to a short month without drifting, and crosses a year", () => {
    expect(allowancePeriod(schedule, Date.parse("2028-02-29T12:00:00.000Z"))).toMatchObject({
      periodStart: "2028-02-29T00:00:00.000Z",
      periodEnd: "2028-03-31T00:00:00.000Z",
    });
    expect(allowancePeriod(schedule, Date.parse("2027-01-15T00:00:00.000Z"))).toMatchObject({
      periodStart: "2026-12-31T00:00:00.000Z",
      periodEnd: "2027-01-31T00:00:00.000Z",
    });
  });
});

describe("unclaimed accounts", () => {
  it("hold the month they were created in until the free window closes, and never renew", async () => {
    vi.useFakeTimers();
    const origin = "2026-01-31T12:34:56.789Z";
    const end = "2026-03-02T12:34:56.789Z";
    vi.setSystemTime(new Date("2026-02-28T12:34:56.789Z"));
    await seedCliAccount("unclaimed", origin);
    const runtime = hosted(freeAccess(5000));
    const first = await quotaFor(runtime, "unclaimed");
    expect(first.limit).toBe(5000);
    // The first renewal has already passed, but the account still spends its
    // first allowance: nobody draws a second one without a human owner.
    expect(first.period).toMatchObject({ periodStart: origin, periodEnd: end, resetAt: end });
    const quota = env.ORG_QUOTA.getByName("unclaimed");
    expect(await quota.admit({ ...first.period, limit: 1 })).toMatchObject({ allowed: true, used: 1 });
    // Past the window the period is still the same one — never a renewed one —
    // and its count stays readable. Serving nothing more is the account gate's job.
    vi.setSystemTime(new Date("2026-03-20T12:34:56.789Z"));
    const expired = await quotaFor(runtime, "unclaimed");
    expect(expired.period).toEqual(first.period);
    expect(await quota.admit({ ...expired.period, limit: 1 })).toMatchObject({ allowed: false, used: 1 });
    expect(await quota.usage(expired.period.periodId)).toBe(1);
  });

  it("keep their count across a claim in the first period, then renew on the creation day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-15T00:00:00Z"));
    const id = "claimed-mid-month";
    await seedCliAccount(id, "2026-02-01T00:00:00.000Z");
    const runtime = hosted(freeAccess(5000));
    const quota = env.ORG_QUOTA.getByName(id);
    const before = await quotaFor(runtime, id);
    expect(await quota.admit({ ...before.period, limit: before.limit! })).toMatchObject({ allowed: true, used: 1 });
    await claimOrganization(id);
    const after = await quotaFor(runtime, id);
    // The same key, so what the free window spent is still spent.
    expect(after.period.periodId).toBe(before.period.periodId);
    expect(after.period.periodEnd).toBe("2026-03-01T00:00:00.000Z");
    expect(await quota.admit({ ...after.period, limit: after.limit! })).toMatchObject({ allowed: true, used: 2 });
    vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
    expect((await quotaFor(runtime, id)).period.periodStart).toBe("2026-03-01T00:00:00.000Z");
  });

  it("move onto the renewed period when claimed after the first renewal, inside the free window", async () => {
    vi.useFakeTimers();
    const origin = "2026-01-31T12:34:56.789Z";
    vi.setSystemTime(new Date("2026-02-28T20:00:00.000Z"));
    const id = "claimed-after-renewal";
    await seedCliAccount(id, origin);
    const runtime = hosted(freeAccess(5000));
    const before = await quotaFor(runtime, id);
    expect(before.period.periodStart).toBe(origin);
    await claimOrganization(id);
    const after = await quotaFor(runtime, id);
    expect(after.period).toMatchObject({
      periodStart: "2026-02-28T12:34:56.789Z",
      periodEnd: "2026-03-31T12:34:56.789Z",
    });
    expect(after.period.periodId).not.toBe(before.period.periodId);
  });

  it.each([500, null])("use the same configured free allowance %s before and after claim", async (limit) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-15T00:00:00Z"));
    const id = `configured-free-${limit}`;
    await seedCliAccount(id, "2026-02-01T00:00:00.000Z");
    const runtime = hosted(freeAccess(limit));
    expect((await quotaFor(runtime, id)).limit).toBe(limit ?? undefined);
    await claimOrganization(id);
    expect((await quotaFor(runtime, id)).limit).toBe(limit ?? undefined);
  });
});

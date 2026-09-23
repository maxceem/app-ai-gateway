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
  it("counts every account over the UTC calendar month", async () => {
    const organizationId = "quota-calendar";
    await seedOrganization(organizationId, "2026-01-31T05:06:07.008Z");
    const resolved = await quotaFor(
      hosted(freeAccess(1_000)),
      organizationId,
      undefined,
      Date.parse("2026-02-15T00:00:00.000Z"),
    );
    expect(resolved.limit).toBe(1_000);
    expect(resolved.period).toEqual({
      periodId: "2026-02",
      periodStart: "2026-02-01T00:00:00.000Z",
      periodEnd: "2026-03-01T00:00:00.000Z",
      resetAt: "2026-03-01T00:00:00.000Z",
    });
  });

  it("keeps the month's count across a plan change and swaps only the limit", async () => {
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
    access.subscription = subscription();
    invalidateBillingAccess(id);
    const paid = await quotaFor(runtime, id);
    // Same month, same counter: an upgrade lifts the ceiling over what was spent.
    expect(paid.period.periodId).toBe(free.period.periodId);
    expect(await quota.admit({ ...paid.period, limit: paid.limit! })).toMatchObject({ allowed: true, used: 2 });
  });

  it("renews on the first of the month", () => {
    expect(allowancePeriod(Date.parse("2026-12-31T23:59:59.999Z"), null).periodId).toBe("2026-12");
    expect(allowancePeriod(Date.parse("2027-01-01T00:00:00.000Z"), null)).toMatchObject({
      periodId: "2027-01",
      periodEnd: "2027-02-01T00:00:00.000Z",
    });
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
    // February is already under way, but the account still spends January's
    // allowance: nobody draws a second one without a human owner.
    expect(first.period).toMatchObject({ periodId: "2026-01", periodEnd: end, resetAt: end });
    const quota = env.ORG_QUOTA.getByName("unclaimed");
    expect(await quota.admit({ ...first.period, limit: 1 })).toMatchObject({ allowed: true, used: 1 });
    // Past the window the period is still the same one — never March's — and
    // its count stays readable. Serving nothing more is the account gate's job.
    vi.setSystemTime(new Date("2026-03-20T12:34:56.789Z"));
    const expired = await quotaFor(runtime, "unclaimed");
    expect(expired.period).toEqual(first.period);
    expect(await quota.admit({ ...expired.period, limit: 1 })).toMatchObject({ allowed: false, used: 1 });
    expect(await quota.usage(expired.period.periodId)).toBe(1);
  });

  it("keep their count across a claim in the same month, then renew with the calendar", async () => {
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
    expect((await quotaFor(runtime, id)).period.periodId).toBe("2026-03");
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

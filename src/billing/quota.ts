import { accountLifecycle } from "../core/account-lifecycle";
import type { Deployment } from "../policy/deployment";
import { accountInstant, accountUnclaimed, unclaimedAccessDeadline } from "../policy/accounts";
import { GatewayError } from "../core/errors";
import type { OrganizationQuotaStatus } from "../contracts/billing";
import {
  billingPlanLimits,
  getBillingAccess,
  type BillingRequestCache,
  type GatewayBillingAccess,
} from "./gateway";

/**
 * One allowance period: a month measured from the plan's own anchor.
 *
 * A paid plan renews on its subscription's billing anchor, and the default
 * free plan on the day the account was created, so every account's allowance
 * resets on the date its plan does. `periodId` names the schedule and the
 * period's start, which is all the counter is keyed by.
 */
export interface AllowancePeriod {
  periodId: string;
  periodStart: string;
  periodEnd: string;
  resetAt: string;
}

/**
 * What the organization's plan allowance is right now.
 *
 * `unmetered` means nothing is counted, not that traffic is admissible: a
 * self-hosted deployment and a plan with no monthly limit answer it, but so do
 * billing being unavailable and no plan resolving. A caller that admits traffic
 * must still call `requireActiveBilling(quota.access)`. `metered` is a limit
 * and the period it is counted over.
 */
export type BillingQuota =
  | { kind: "unmetered"; access: GatewayBillingAccess }
  | { kind: "metered"; access: GatewayBillingAccess; limit: number; period: AllowancePeriod };

/** Where a plan's months are counted from. */
export interface AllowanceSchedule {
  /** Which plan the months belong to: the account's free one, or a subscription. */
  kind: "free" | "paid";
  /** Public and stable for the schedule's life; provider ids never enter it. */
  origin: string;
  anchorAt: number;
  /** The day of the month the schedule renews on, kept when a short month clamps it. */
  anchorDay: number;
}

function invalidSchedule(field: string): GatewayError {
  return new GatewayError(502, "billing_unavailable", `Invalid ${field} from billing data`);
}

function instant(value: string, field: string): number {
  const at = accountInstant(value);
  if (at === null) throw invalidSchedule(field);
  return at;
}

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * The anchor moved `offset` months on, always from the original anchor, so a
 * schedule that starts on the 31st renews on the 28th in February and on the
 * 31st again in March rather than drifting to the 28th for good.
 */
export function monthlyAnniversary(schedule: AllowanceSchedule, offset: number): number {
  const anchor = new Date(schedule.anchorAt);
  const absoluteMonth = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + offset;
  const year = Math.floor(absoluteMonth / 12);
  const month = absoluteMonth - year * 12;
  return Date.UTC(
    year,
    month,
    Math.min(schedule.anchorDay, daysInUtcMonth(year, month)),
    anchor.getUTCHours(),
    anchor.getUTCMinutes(),
    anchor.getUTCSeconds(),
    anchor.getUTCMilliseconds(),
  );
}

/**
 * The period `now` falls in. An account nobody has claimed holds its first
 * period until its free window closes, however far past the first renewal that
 * runs, so it cannot draw a second allowance without a human owner. Claiming
 * it within that period keeps the same key, and so the same count.
 */
export function allowancePeriod(
  schedule: AllowanceSchedule,
  now: number,
  unclaimedDeadline: number | null = null,
): AllowancePeriod {
  let start: number;
  let end: number;
  if (unclaimedDeadline !== null) {
    start = schedule.anchorAt;
    end = unclaimedDeadline;
  } else {
    const anchor = new Date(schedule.anchorAt);
    const at = new Date(now);
    let offset = (at.getUTCFullYear() - anchor.getUTCFullYear()) * 12
      + at.getUTCMonth() - anchor.getUTCMonth();
    // The month difference overshoots when `now` is earlier in its month than
    // the anchor day — including in the anchor's own month, when the renewal
    // day falls after the anchor instant, as a trial that bills on a later day
    // does. Step back until the period starts by `now`; the clamp below then
    // opens the first period on the anchor itself.
    while (monthlyAnniversary(schedule, offset) > now) offset -= 1;
    start = Math.max(monthlyAnniversary(schedule, offset), schedule.anchorAt);
    end = monthlyAnniversary(schedule, offset + 1);
  }
  const periodStart = new Date(start).toISOString();
  const periodEnd = new Date(end).toISOString();
  return { periodId: `${schedule.origin}:${periodStart}`, periodStart, periodEnd, resetAt: periodEnd };
}

/**
 * The schedule a plan is counted on. The default plan's is the account's own,
 * anchored where it was created; any other plan's is its subscription's, as the
 * billing service reports it.
 */
function allowanceSchedule(
  access: GatewayBillingAccess & { state: "billed" },
  accountCreatedAt: string,
): AllowanceSchedule {
  if (access.plan?.isDefault !== false) {
    const anchorAt = instant(accountCreatedAt, "organization creation time");
    const createdAt = new Date(anchorAt).toISOString();
    return {
      kind: "free",
      origin: `free:${createdAt}`,
      anchorAt,
      anchorDay: new Date(anchorAt).getUTCDate(),
    };
  }
  const subscription = access.subscription;
  if (!subscription) throw invalidSchedule("paid subscription schedule");
  const anchorAt = instant(subscription.billingAnchorAt, "billing anchor");
  const anchorDay = subscription.billingAnchorDay ?? new Date(anchorAt).getUTCDate();
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
    throw invalidSchedule("billing anchor day");
  }
  const generation = new Date(instant(subscription.createdAt, "subscription creation time")).toISOString();
  return { kind: "paid", origin: `paid:${generation}`, anchorAt, anchorDay };
}

/**
 * The one resolver used by dispatch enforcement, billing status and the CLI:
 * the plan's monthly request limit and the period it is counted over.
 *
 * A self-hosted deployment is answered before anything is read, so admission
 * there pays nothing for it.
 */
export async function billingQuota(
  deployment: Deployment,
  env: Env,
  organizationId: string,
  cache?: BillingRequestCache,
  now: number = Date.now(),
): Promise<BillingQuota> {
  const access = await getBillingAccess(deployment, organizationId, cache);
  if (access.state !== "billed" || access.plan === null) return { kind: "unmetered", access };
  const limit = billingPlanLimits(access).maxRequestsPerMonth;
  if (limit === undefined) return { kind: "unmetered", access };
  // Ownership and the free-access clock are gateway D1's, not billing's. It is
  // the same lifecycle read the account gate on the request already made, so
  // it costs a warm isolate nothing.
  const account = await accountLifecycle(env, organizationId);
  const schedule = allowanceSchedule(access, account.createdAt);
  if (schedule.anchorAt > now) {
    // A brief lead is clock skew between this Worker and billing, and is worth
    // a retry; a distant one is a schedule that has not started, and admitting
    // against it would count toward a period that does not exist yet.
    if (schedule.anchorAt - now <= 60_000) {
      throw new GatewayError(503, "billing_unavailable", "Billing schedule has not started yet", {
        "Retry-After": String(Math.max(1, Math.ceil((schedule.anchorAt - now) / 1_000))),
      });
    }
    throw invalidSchedule("future billing anchor");
  }
  let unclaimedDeadline: number | null = null;
  if (accountUnclaimed(account) && schedule.kind === "free") {
    unclaimedDeadline = unclaimedAccessDeadline(account.createdAt);
    if (unclaimedDeadline === null) throw invalidSchedule("organization creation time");
  }
  return { kind: "metered", access, limit, period: allowancePeriod(schedule, now, unclaimedDeadline) };
}

/**
 * The live count against a metered quota, read out of the organization's quota
 * object — the only place it lives, because only the dispatch path writes it.
 * Null for an unmetered quota, which counts nothing.
 */
export async function quotaUsage(
  env: Env,
  organizationId: string,
  quota: BillingQuota,
): Promise<OrganizationQuotaStatus | null> {
  if (quota.kind === "unmetered") return null;
  const used = await env.ORG_QUOTA.getByName(organizationId).usage(quota.period.periodId);
  return { ...quota.period, used, limit: quota.limit };
}

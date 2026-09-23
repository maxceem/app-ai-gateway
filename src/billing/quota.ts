import { accountLifecycle } from "../core/account-lifecycle";
import type { Deployment } from "../policy/deployment";
import { accountInstant, accountUnclaimed, unclaimedAccessDeadline } from "../policy/accounts";
import { nextUtcMonthStart } from "../core/time";
import { GatewayError } from "../core/errors";
import {
  billingPlanLimits,
  getBillingAccess,
  requireActiveBilling,
  type BillingRequestCache,
  type GatewayBillingAccess,
} from "./gateway";

/**
 * One allowance period: a UTC calendar month, named by its `YYYY-MM`.
 *
 * The allowance follows the calendar rather than each tenant's billing
 * anniversary, which is what lets the counter be keyed by the month alone: a
 * plan change within the month keeps the count and swaps the limit, and no
 * schedule has to be adopted, versioned or superseded to get there.
 */
export interface AllowancePeriod {
  periodId: string;
  periodStart: string;
  periodEnd: string;
  resetAt: string;
}

export interface ResolvedBillingQuota {
  access: GatewayBillingAccess;
  limit: number | undefined;
  period: AllowancePeriod;
}

export type BillingQuotaResolution =
  | ResolvedBillingQuota
  | { access: GatewayBillingAccess; limit?: never; period?: never };

function monthStart(at: number): number {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/**
 * The period `now` falls in. An account nobody has claimed holds the month it
 * was created in until its free window closes, however far into the next
 * month that runs, so it cannot draw a second allowance without a human
 * owner. Claiming it within that month keeps the same key, and so the same
 * count; after that it renews with the calendar like everyone else.
 */
export function allowancePeriod(now: number, unclaimed: { createdAt: number; deadline: number } | null): AllowancePeriod {
  const start = monthStart(unclaimed?.createdAt ?? now);
  const end = unclaimed ? unclaimed.deadline : nextUtcMonthStart(now);
  const periodEnd = new Date(end).toISOString();
  return {
    periodId: new Date(start).toISOString().slice(0, 7),
    periodStart: new Date(start).toISOString(),
    periodEnd,
    resetAt: periodEnd,
  };
}

/**
 * The one resolver used by both dispatch enforcement and billing status: the
 * plan's monthly request limit and the period it is counted over.
 */
export async function getBillingQuotaResolution(
  deployment: Deployment,
  env: Env,
  organizationId: string,
  cache?: BillingRequestCache,
  now?: number,
): Promise<BillingQuotaResolution> {
  const access = await getBillingAccess(deployment, organizationId, cache);
  if (access.state !== "billed" || access.plan === null) return { access };
  // Ownership and the free-access clock are gateway D1's, not billing's. It is
  // the same lifecycle read the account gate on the request already made, so
  // it costs a warm isolate nothing.
  const account = await accountLifecycle(env, organizationId);
  let unclaimed: { createdAt: number; deadline: number } | null = null;
  if (accountUnclaimed(account)) {
    const createdAt = accountInstant(account.createdAt);
    const deadline = unclaimedAccessDeadline(account.createdAt);
    if (createdAt === null || deadline === null) {
      throw new GatewayError(502, "billing_unavailable", "Invalid organization creation time");
    }
    unclaimed = { createdAt, deadline };
  }
  return {
    access,
    limit: billingPlanLimits(access).maxRequestsPerMonth,
    period: allowancePeriod(now ?? Date.now(), unclaimed),
  };
}

export async function resolveBillingQuota(
  deployment: Deployment,
  env: Env,
  organizationId: string,
  cache?: BillingRequestCache,
  now?: number,
): Promise<ResolvedBillingQuota> {
  const resolved = await getBillingQuotaResolution(deployment, env, organizationId, cache, now);
  if (!resolved.period) {
    requireActiveBilling(resolved.access);
    throw new Error("Billing quota periods only exist for hosted plans");
  }
  return resolved;
}

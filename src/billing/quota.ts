import { accountLifecycle } from "../core/account-lifecycle";
import type { Deployment } from "../policy/deployment";
import { accountInstant, accountUnclaimed, unclaimedAccessDeadline } from "../policy/accounts";
import { GatewayError } from "../core/errors";
import type { OrganizationQuotaStatus } from "../contracts/billing";
import {
  allowancePeriod,
  freeAllowanceSchedule,
  paidAllowanceSchedule,
  type AllowancePeriod,
  type AllowanceSchedule,
} from "./allowance-period";
import {
  billingPlanLimits,
  getBillingAccess,
  type BillingRequestCache,
  type GatewayBillingAccess,
} from "./gateway";

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

function invalidSchedule(field: string): GatewayError {
  return new GatewayError(502, "billing_unavailable", `Invalid ${field} from billing data`);
}

function instant(value: string, field: string): number {
  const at = accountInstant(value);
  if (at === null) throw invalidSchedule(field);
  return at;
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
    return freeAllowanceSchedule(instant(accountCreatedAt, "organization creation time"));
  }
  const subscription = access.subscription;
  if (!subscription) throw invalidSchedule("paid subscription schedule");
  const anchorAt = instant(subscription.billingAnchorAt, "billing anchor");
  const anchorDay = subscription.billingAnchorDay ?? new Date(anchorAt).getUTCDate();
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
    throw invalidSchedule("billing anchor day");
  }
  return paidAllowanceSchedule(
    anchorAt,
    anchorDay,
    instant(subscription.createdAt, "subscription creation time"),
  );
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

import { accountLifecycle } from "../core/account-lifecycle";
import type { Deployment } from "../policy/deployment";
import { accountUnclaimed, unclaimedAccessDeadline } from "../policy/accounts";
import { GatewayError } from "../core/errors";
import {
  billingPlanLimits,
  getBillingAccess,
  requireActiveBilling,
  type BillingRequestCache,
  type GatewayBillingAccess,
} from "./gateway";

export interface BillingQuotaPeriod {
  /** Internal schedule identity. Provider ids never enter the public API. */
  scheduleId: string;
  /** Monotonic transition instant used to reject superseded cache entries. */
  scheduleRevision: number;
  periodId: string;
  periodStart: string;
  periodEnd: string;
  resetAt: string;
}

export interface ResolvedBillingQuota {
  access: GatewayBillingAccess;
  limit: number | undefined;
  period: BillingQuotaPeriod;
}

export type BillingQuotaResolution =
  | ResolvedBillingQuota
  | { access: GatewayBillingAccess; limit?: never; period?: never };

function invalidSchedule(field: string): GatewayError {
  return new GatewayError(502, "billing_unavailable", `Invalid ${field} from billing data`);
}

function normalizedInstant(value: unknown, field: string): number {
  if (typeof value !== "string" || value.trim() === "") throw invalidSchedule(field);
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const at = Date.parse(normalized);
  if (!Number.isFinite(at)) throw invalidSchedule(field);
  return at;
}

function optionalInstant(value: unknown, field: string): number | null {
  return value === null ? null : normalizedInstant(value, field);
}

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * Adds months from the original anchor. This makes Jan 31 become Feb 28 and
 * then Mar 31, instead of allowing February's clamp to drift the schedule.
 */
export function monthlyAnniversary(anchorAt: number, anchorDay: number, offset: number): number {
  const anchor = new Date(anchorAt);
  const absoluteMonth = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + offset;
  const year = Math.floor(absoluteMonth / 12);
  const month = absoluteMonth - year * 12;
  return Date.UTC(
    year,
    month,
    Math.min(anchorDay, daysInUtcMonth(year, month)),
    anchor.getUTCHours(),
    anchor.getUTCMinutes(),
    anchor.getUTCSeconds(),
    anchor.getUTCMilliseconds(),
  );
}

export function anniversaryPeriod(
  anchorAt: number,
  anchorDay: number,
  now: number,
): { start: number; end: number } {
  if (now < anchorAt) throw new Error("Billing schedule begins in the future");
  const anchor = new Date(anchorAt);
  const at = new Date(now);
  let offset = (at.getUTCFullYear() - anchor.getUTCFullYear()) * 12
    + at.getUTCMonth() - anchor.getUTCMonth();
  let start = monthlyAnniversary(anchorAt, anchorDay, offset);
  while (start > now) {
    offset -= 1;
    start = monthlyAnniversary(anchorAt, anchorDay, offset);
  }
  let end = monthlyAnniversary(anchorAt, anchorDay, offset + 1);
  while (end <= now) {
    offset += 1;
    start = end;
    end = monthlyAnniversary(anchorAt, anchorDay, offset + 1);
  }
  return { start: Math.max(start, anchorAt), end };
}

function latest(...values: Array<number | null>): number {
  return Math.max(...values.filter((value): value is number => value !== null));
}

/**
 * The one resolver used by both dispatch enforcement and billing status.
 * Default plans always return to the organization's original Free schedule.
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

  let scheduleId: string;
  let revision: number;
  let anchorAt: number;
  let anchorDay: number;
  let kind: "free" | "paid";
  let publicScheduleOrigin: string;
  /**
   * Set while nobody has claimed the account. The trial is not a schedule of its
   * own: it is the free schedule's first period with an early end, so the same
   * `scheduleId` and revision survive the claim and the quota object keeps its
   * counter instead of refusing the switch as a superseded schedule.
   */
  let trialEnd: number | null = null;

  if (access.plan.isDefault) {
    // Billing only chooses the entitlement. Gateway D1 owns ownership and the
    // free-access clock, and one lifecycle row answers both: the account's
    // creation instant is the free schedule's anchor, and whether a human owns
    // it is what decides the trial. It is the same read the account gate on the
    // request already made, so it costs a warm isolate nothing.
    const account = await accountLifecycle(env, organizationId);
    now ??= Date.now();
    kind = "free";
    anchorAt = normalizedInstant(account.createdAt, "organization creation time");
    // D1 may hold the instant in either shape; the schedule is identified by the
    // normalized one, so a rewritten row cannot rename an existing schedule.
    const createdAt = new Date(anchorAt).toISOString();
    anchorDay = new Date(anchorAt).getUTCDate();
    scheduleId = `free:${organizationId}:${createdAt}`;
    publicScheduleOrigin = createdAt;
    const subscription = access.subscription;
    const endsAt = subscription ? optionalInstant(subscription.endsAt, "subscription end time") : null;
    const trialEndsAt = subscription ? optionalInstant(subscription.trialEndsAt, "trial end time") : null;
    revision = latest(
      anchorAt,
      subscription ? normalizedInstant(subscription.updatedAt, "subscription update time") : null,
      endsAt !== null && endsAt <= now ? endsAt : null,
      subscription?.status === "on_trial"
        && trialEndsAt !== null
        && trialEndsAt <= now
        ? trialEndsAt
        : null,
    );
    // One allowance that never renews, so an account nobody has claimed cannot
    // draw a second month. Claiming it resumes the ordinary monthly renewals.
    // Measured from the schedule's own anchor, so the window can never close
    // before the period it belongs to opens.
    if (accountUnclaimed(account)) {
      // normalizedInstant above already validated this same stored value.
      const deadline = unclaimedAccessDeadline(account.createdAt);
      if (deadline === null) throw invalidSchedule("organization creation time");
      trialEnd = deadline;
    }
  } else {
    now ??= Date.now();
    const subscription = access.subscription;
    if (!subscription) throw invalidSchedule("paid subscription schedule");
    kind = "paid";
    anchorAt = normalizedInstant(subscription.billingAnchorAt, "billing anchor");
    const day = subscription.billingAnchorDay === null
      ? new Date(anchorAt).getUTCDate()
      : subscription.billingAnchorDay;
    if (typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 31) {
      throw invalidSchedule("billing anchor day");
    }
    anchorDay = day;
    scheduleId =
      `paid:${subscription.subscriptionId ?? "manual"}:${subscription.createdAt}:${subscription.billingAnchorAt}`;
    publicScheduleOrigin = subscription.createdAt;
    revision = latest(
      normalizedInstant(subscription.createdAt, "subscription creation time"),
      normalizedInstant(subscription.updatedAt, "subscription update time"),
      normalizedInstant(subscription.billingScheduleUpdatedAt, "billing schedule update time"),
    );
  }

  if (anchorAt > now) {
    // Allow a brief retry for cross-service clock skew without admitting before
    // the actual anchor. A distant future anchor is an invalid active schedule.
    if (anchorAt - now <= 60_000) {
      throw new GatewayError(503, "billing_unavailable", "Billing schedule has not started yet", {
        "Retry-After": String(Math.max(1, Math.ceil((anchorAt - now) / 1_000))),
      });
    }
    throw invalidSchedule("future billing anchor");
  }
  const { start, end } = anniversaryPeriod(anchorAt, anchorDay, now);
  // An unclaimed account stays on the first period however long the trial runs:
  // it opens on the anchor and closes when the trial does, never renewing.
  const periodStart = new Date(trialEnd === null ? start : anchorAt).toISOString();
  const periodEnd = new Date(trialEnd ?? end).toISOString();
  return {
    access,
    limit: billingPlanLimits(access).maxRequestsPerMonth,
    period: {
      scheduleId,
      scheduleRevision: revision,
      periodId: `${kind}:${publicScheduleOrigin}:${periodStart}`,
      periodStart,
      periodEnd,
      resetAt: periodEnd,
    },
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

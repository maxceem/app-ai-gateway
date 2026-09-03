import { formatNumber } from "./format";
import type {
  BillingAccess,
  BillingPlan,
  BillingPrice,
  OrganizationQuota,
} from "./types";

/**
 * Billing presentation rules. Kept free of React so the console can test the
 * upsell/banner decisions directly — they are the part most likely to regress.
 */

export interface BillingNotice {
  tone: "warning" | "destructive";
  title: string;
  description: string;
  /** Whether the notice should offer a route to the plans page. */
  actionable: boolean;
}

const INACTIVE_COPY: Record<string, { title: string; description: string }> = {
  trial_expired: {
    title: "Your trial has ended",
    description: "Choose a plan to keep serving gateway traffic.",
  },
  past_due: {
    title: "Payment past due",
    description: "Update your payment method to restore gateway traffic.",
  },
  canceled: {
    title: "Subscription canceled",
    description: "Resubscribe to keep serving gateway traffic.",
  },
  missing_subscription: {
    title: "No active subscription",
    description: "Choose a plan to start serving gateway traffic.",
  },
  service_inactive: {
    title: "Billing is not active for this service",
    description: "Contact support to re-enable billing for this deployment.",
  },
  billing_unavailable: {
    title: "Billing service unavailable",
    description: "Gateway traffic may be interrupted. This usually resolves on its own.",
  },
};

/**
 * The banner to show above the console, or `null` when nothing is wrong.
 * A self-hosted deployment never produces one.
 */
export function billingNotice(access: BillingAccess | undefined | null): BillingNotice | null {
  if (!access || access.selfHosted) return null;
  if (access.status === "active") return null;

  if (access.status === "trialing") {
    const ends = formatBillingDate(access.trialEndsAt);
    return {
      tone: "warning",
      title: "Trial in progress",
      description: ends ? `Your trial ends on ${ends}.` : "Your trial is active.",
      actionable: true,
    };
  }

  const copy = INACTIVE_COPY[access.reason ?? "missing_subscription"]
    ?? INACTIVE_COPY.missing_subscription!;
  return {
    tone: "destructive",
    title: copy.title,
    description: copy.description,
    // A service-level outage or deactivation is not something a plan change fixes.
    actionable: access.reason !== "billing_unavailable" && access.reason !== "service_inactive",
  };
}

/** The share of the allowance at which the operator is warned it is running out. */
export const QUOTA_WARNING_RATIO = 0.8;

/** Where the month stands against the plan's allowance, ready to render. */
export interface QuotaMeter {
  used: number;
  /** `null` when the plan sets no ceiling. */
  limit: number | null;
  /** Share of the allowance spent, capped at 1. `null` when unlimited. */
  ratio: number | null;
  tone: "normal" | "warning" | "destructive";
  /** "8,420 of 10,000 requests", or the bare count when unlimited. */
  label: string;
  caption: string;
}

/**
 * Reads the month's request count into something displayable, or `null` when
 * there is no allowance to report — a self-hosted deployment, or a status
 * response from before this field existed.
 */
export function quotaMeter(quota: OrganizationQuota | undefined | null): QuotaMeter | null {
  if (!quota) return null;
  const resets = formatBillingDate(quota.resetAt);
  const caption = resets ? `Resets ${resets}` : "Resets at the start of next month";
  if (quota.limit === undefined || quota.limit === null) {
    return {
      used: quota.used,
      limit: null,
      ratio: null,
      tone: "normal",
      label: `${formatNumber(quota.used)} requests this month`,
      caption,
    };
  }
  // An allowance of zero admits nothing, and dividing by it would leave the
  // meter with no reading at all, so it reads as fully spent — which it is.
  const ratio = quota.limit > 0 ? Math.min(quota.used / quota.limit, 1) : 1;
  return {
    used: quota.used,
    limit: quota.limit,
    ratio,
    tone: ratio >= 1 ? "destructive" : ratio >= QUOTA_WARNING_RATIO ? "warning" : "normal",
    label: `${formatNumber(quota.used)} of ${formatNumber(quota.limit)} requests`,
    caption,
  };
}

/**
 * The banner for an allowance that is nearly or entirely spent.
 *
 * Worth interrupting the operator for wherever they are: unlike a lapsed card,
 * a spent allowance is usually a client behaving unexpectedly, and the whole
 * value of saying so is saying it before every request starts being refused.
 */
export function quotaNotice(quota: OrganizationQuota | undefined | null): BillingNotice | null {
  const meter = quotaMeter(quota);
  if (!meter || meter.ratio === null || meter.tone === "normal") return null;
  return meter.ratio >= 1
    ? {
        tone: "destructive",
        title: "Monthly request allowance spent",
        description: `Gateway requests are being refused until the allowance resets. ${meter.caption}.`,
        actionable: true,
      }
    : {
        tone: "warning",
        title: "Monthly request allowance almost spent",
        description: `${meter.label} used this month. ${meter.caption}.`,
        actionable: true,
      };
}

/** True when the organization may not currently serve gateway traffic. */
export function isBillingBlocked(access: BillingAccess | undefined | null): boolean {
  return Boolean(access && !access.selfHosted && access.status === "inactive");
}

export function formatBillingDate(value: string | undefined | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatPrice(price: BillingPrice): string {
  const amount = (price.priceAmountCents / 100).toLocaleString(undefined, {
    style: "currency",
    currency: price.priceCurrency || "USD",
    minimumFractionDigits: price.priceAmountCents % 100 === 0 ? 0 : 2,
  });
  return `${amount}/${price.billingPeriod === "year" ? "yr" : "mo"}`;
}

export function priceFor(plan: BillingPlan, period: "month" | "year"): BillingPrice | undefined {
  return plan.prices.find((price) => price.billingPeriod === period);
}

/**
 * The subscription's next meaningful date. A canceled-but-running subscription
 * reports when access ends; an active one reports when it renews.
 */
export function subscriptionTimeline(access: BillingAccess): {
  label: string;
  value: string;
} | null {
  if (access.endsAt) {
    const formatted = formatBillingDate(access.endsAt);
    if (formatted) return { label: "Access ends", value: formatted };
  }
  if (access.status === "trialing" && access.trialEndsAt) {
    const formatted = formatBillingDate(access.trialEndsAt);
    if (formatted) return { label: "Trial ends", value: formatted };
  }
  if (access.renewsAt) {
    const formatted = formatBillingDate(access.renewsAt);
    if (formatted) return { label: "Renews", value: formatted };
  }
  return null;
}

/** A canceled subscription still inside its paid period can be resumed. */
export function canResume(access: BillingAccess): boolean {
  return Boolean(access.endsAt) || access.subscriptionStatus === "cancelled";
}

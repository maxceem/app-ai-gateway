import { formatNumber } from "./format";
import type {
  BillingAccess,
  BillingPlan,
  BillingPrice,
  EntitledPlan,
  OrganizationQuota,
  SubscriptionState,
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

/** The plan the organization holds, or `null` where there is none to show. */
export function entitledPlan(
  access: BillingAccess | undefined | null,
): EntitledPlan | null {
  return access?.state === "billed" ? access.plan : null;
}

/** The subscription to act on, or `null` where there is none. */
export function subscriptionOf(
  access: BillingAccess | undefined | null,
): SubscriptionState | null {
  return access?.state === "billed" ? access.subscription : null;
}

/**
 * "the Free plan (1,000 requests/month)", from whatever the plan actually says.
 *
 * The allowance is read the same way the gateway reads it — a whole number, or
 * a JSON string holding one — and anything else is simply left unstated rather
 * than rendered as a number the plan does not grant.
 */
function describePlan(plan: EntitledPlan): string {
  const limits = plan.limits;
  const allowance =
    typeof limits === "object" && limits !== null && !Array.isArray(limits)
      ? (limits as Record<string, unknown>).maxRequestsPerMonth
      : undefined;
  const count =
    typeof allowance === "number"
      ? allowance
      : typeof allowance === "string" && allowance.trim().length > 0
        ? Number(allowance)
        : Number.NaN;
  return Number.isSafeInteger(count) && count >= 0
    ? `the ${plan.planName} plan (${formatNumber(count)} requests/month)`
    : `the ${plan.planName} plan`;
}

/**
 * The banner to show above the console, or `null` when nothing is wrong.
 *
 * A self-hosted deployment never produces one, and neither does a healthy
 * organization — including one sitting on the free default plan, whose limit
 * the quota meter already states in full. Only two things are worth
 * interrupting for: traffic that has quietly changed allowance, and traffic
 * that is about to stop.
 */
export function billingNotice(access: BillingAccess | undefined | null): BillingNotice | null {
  if (!access || access.state === "self_hosted") return null;

  if (access.state === "unavailable") {
    return {
      tone: "destructive",
      title: "Billing service unavailable",
      description: "Gateway traffic may be interrupted. This usually resolves on its own.",
      // Nothing a plan change can fix.
      actionable: false,
    };
  }

  if (access.plan === null) {
    return {
      tone: "destructive",
      title: "No active plan",
      description: "Gateway traffic is being refused. Choose a plan to start serving it again.",
      actionable: true,
    };
  }

  // A subscription that no longer entitles anything: traffic still flows, on
  // the default plan, so this is a change of allowance rather than an outage.
  if (access.subscription && access.plan.isDefault) {
    return {
      tone: "warning",
      title: "Your subscription has ended",
      description: `You’re on ${describePlan(access.plan)}. Resubscribe to restore your previous allowance.`,
      actionable: true,
    };
  }

  if (access.subscription?.status === "past_due") {
    return {
      tone: "warning",
      title: "Payment past due",
      description: "Update your payment method to keep this plan.",
      actionable: true,
    };
  }

  return null;
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
 * reports when it ends; an active one reports when it renews.
 */
export function subscriptionTimeline(subscription: SubscriptionState): {
  label: string;
  value: string;
} | null {
  if (subscription.endsAt) {
    const formatted = formatBillingDate(subscription.endsAt);
    if (formatted) return { label: "Access ends", value: formatted };
  }
  if (subscription.status === "on_trial" && subscription.trialEndsAt) {
    const formatted = formatBillingDate(subscription.trialEndsAt);
    if (formatted) return { label: "Trial ends", value: formatted };
  }
  if (subscription.renewsAt) {
    const formatted = formatBillingDate(subscription.renewsAt);
    if (formatted) return { label: "Renews", value: formatted };
  }
  return null;
}

/**
 * LemonSqueezy statuses cf-billing can still cancel. Deliberately keyed off the
 * *subscription*, never off the entitled plan: an organization can hold a
 * cancellable subscription while sitting on the free default plan, and one on a
 * paid plan may have nothing to cancel.
 */
const CANCELLABLE = new Set(["on_trial", "active", "paused", "past_due"]);

/** Whether the subscription can be canceled at period end. */
export function canCancel(subscription: SubscriptionState | null): boolean {
  return Boolean(
    subscription
      // Manual grants are not LemonSqueezy's to cancel.
      && subscription.source === "lemon_squeezy"
      && CANCELLABLE.has(subscription.status),
  );
}

/** A canceled subscription can be un-canceled, whether or not it still entitles. */
export function canResume(subscription: SubscriptionState | null): boolean {
  return subscription?.status === "cancelled";
}

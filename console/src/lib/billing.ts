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
 * The monthly request allowance a plan grants, or `null` where it states none.
 *
 * Read the same way the gateway reads it — a whole number, or a JSON string
 * holding one — so anything else is left unstated rather than reported as a
 * number the plan does not actually grant. Exported because the allowance is
 * quoted away from the quota meter too: a first-run screen has to name it
 * before the organization has spent a single request, and so has no period to
 * read it from.
 */
export function planRequestAllowance(
  plan: EntitledPlan | null | undefined,
): number | null {
  const limits = plan?.limits;
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
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/** "the Free plan (1,000 requests/month)", from whatever the plan actually says. */
function describePlan(plan: EntitledPlan): string {
  const count = planRequestAllowance(plan);
  return count === null
    ? `the ${plan.planName} plan`
    : `the ${plan.planName} plan (${formatNumber(count)} requests/month)`;
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

/**
 * The share of the allowance at which it counts as running out.
 *
 * One number for the whole idea: it colours the meter, raises the banner, and
 * is what puts a paid plan's upgrade back in the sidebar. An operator who is
 * told the allowance is nearly gone and an operator who is offered more of it
 * are in the same situation, so they are judged by the same line.
 */
export const QUOTA_WARNING_RATIO = 0.8;

/** Where the current plan period stands against its allowance, ready to render. */
export interface QuotaMeter {
  used: number;
  /** `null` when the plan sets no ceiling. */
  limit: number | null;
  /** Share of the allowance spent, capped at 1. `null` when unlimited. */
  ratio: number | null;
  tone: "normal" | "warning" | "destructive";
  /** "8,420 of 10,000 requests", or the bare count when unlimited. */
  label: string;
  /** "Resets Oct 8, 2026, 11:15 AM GMT+8". Only the notices state it. */
  caption: string;
}

/**
 * Reads the current period's request count into something displayable, or
 * `null` when there is no allowance to report — a self-hosted deployment, or
 * a status response from before this field existed.
 */
export function quotaMeter(quota: OrganizationQuota | undefined | null): QuotaMeter | null {
  if (!quota) return null;
  const resets = formatBillingDateTime(quota.resetAt);
  const caption = resets ? `Resets ${resets}` : "Reset time unavailable";
  if (quota.limit === undefined || quota.limit === null) {
    return {
      used: quota.used,
      limit: null,
      ratio: null,
      tone: "normal",
      label: `${formatNumber(quota.used)} requests this period`,
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
        description: `${meter.label} used in the current period. ${meter.caption}.`,
        actionable: true,
      };
}

export function formatBillingDate(value: string | undefined | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** An exact instant in the viewer's local time, including the local time-zone name. */
export function formatBillingDateTime(value: string | undefined | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
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
 * LemonSqueezy statuses the billing service can still cancel. Deliberately keyed off the
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

/**
 * Where a plan sits against the others: its monthly price in cents.
 *
 * The catalog carries no explicit order, and the console needs one to say
 * "upgrade" or "downgrade" rather than a bare "subscribe". Price is what the
 * operator is actually comparing, and the default plan — which has no price row
 * at all, because it is not purchasable — ranks below every paid one at zero.
 */
export function planRank(plan: BillingPlan): number {
  return priceFor(plan, "month")?.priceAmountCents ?? 0;
}

/** What a plan card's single button does, ready to render. */
export interface PlanAction {
  /**
   * `current` is the plan already held. `checkout` buys a first subscription,
   * `change` moves a live one between paid plans, and `cancel` is the only way
   * back to the free default plan — the billing service has no price to change
   * to, so leaving a paid plan *is* cancelling it.
   */
  intent: "current" | "checkout" | "change" | "cancel";
  label: string;
  /** A downgrade should not compete with the upgrade beside it. */
  variant: "default" | "outline";
  /** Set when the action cannot be taken, and why. */
  reason?: string;
}

const MANUALLY_MANAGED =
  "This plan was granted manually. Ask support to change it.";

/**
 * The button for one plan card, decided against the plan currently held.
 *
 * Every route through here is one the billing contract already serves: no
 * subscription means a checkout, a live one means a plan change, and the free
 * plan means a cancellation. A manual grant is refused by the billing service
 * on all three, so it is disabled here rather than left to fail on click.
 */
export function planAction(
  plan: BillingPlan,
  plans: BillingPlan[],
  access: BillingAccess | undefined | null,
): PlanAction {
  const current = entitledPlan(access);
  if (current && plan.planKey === current.planKey) {
    return { intent: "current", label: "Current plan", variant: "outline" };
  }

  const held = plans.find((entry) => entry.planKey === current?.planKey);
  const upgrade = planRank(plan) > (held ? planRank(held) : 0);
  const free = plan.prices.length === 0;
  const variant = upgrade ? "default" : "outline";
  // Named, not "this plan": the button is read on its own, and the plan it
  // moves you to is the one thing it has to say.
  const label = `${upgrade ? "Upgrade" : "Downgrade"} to ${plan.name}`;

  const subscription = subscriptionOf(access);
  if (subscription && subscription.source === "manual" && CANCELLABLE.has(subscription.status)) {
    return { intent: free ? "cancel" : "change", label, variant, reason: MANUALLY_MANAGED };
  }

  if (free) {
    return canCancel(subscription)
      ? { intent: "cancel", label, variant }
      : {
          intent: "cancel",
          label,
          variant,
          reason: "There is no paid subscription to leave.",
        };
  }

  return { intent: canCancel(subscription) ? "change" : "checkout", label, variant };
}

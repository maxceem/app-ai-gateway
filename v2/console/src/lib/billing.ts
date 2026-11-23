import type {
  BillingAccess,
  BillingPlan,
  BillingPrice,
  EntitledPlan,
  PlanAllowance,
  PlanLimits,
  SubscriptionActions,
  SubscriptionState,
} from "./types";

/**
 * Billing presentation rules (v1's, ported). Free of React so the banner and
 * upgrade decisions, the part most likely to regress, are tested directly.
 * Only a hosted deployment has billing: a self-hosted one never shows any of it.
 */

export interface BillingNotice {
  tone: "warning" | "destructive";
  title: string;
  description: string;
  /** Whether the notice offers the way to the plans page. */
  actionable: boolean;
}

const numbers = new Intl.NumberFormat("en-US");

/** The plan the account holds, or `null` where there is none to show. */
export function entitledPlan(access: BillingAccess | undefined | null): EntitledPlan | null {
  return access?.state === "billed" ? access.plan : null;
}

/** The subscription to act on, or `null` where there is none. */
export function subscriptionOf(access: BillingAccess | undefined | null): SubscriptionState | null {
  return access?.state === "billed" ? access.subscription : null;
}

/** "the Free plan (1,000 requests/month)", from the limits the gateway enforces. */
function describePlan(plan: EntitledPlan, limits: PlanLimits | undefined): string {
  const count = limits?.maxRequestsPerMonth;
  return count === undefined ? `the ${plan.planName} plan` : `the ${plan.planName} plan (${numbers.format(count)} requests/month)`;
}

/**
 * The banner to show above the console, or `null` when nothing is wrong. A
 * healthy account, including one on the free default plan, gets none: only a
 * change of allowance, or traffic that is about to stop, is worth interrupting.
 */
export function billingNotice(access: BillingAccess | undefined | null, limits?: PlanLimits): BillingNotice | null {
  if (!access || access.state === "self_hosted") return null;
  if (access.state === "unavailable") {
    return {
      tone: "destructive",
      title: "Billing service unavailable",
      description: "Your apps keep being served. This usually resolves on its own.",
      actionable: false,
    };
  }
  if (access.plan === null) {
    return {
      tone: "destructive",
      title: "No active plan",
      description: "Your apps' requests are being refused. Choose a plan to start serving them again.",
      actionable: true,
    };
  }
  // A subscription that no longer entitles anything: traffic still flows on the default plan.
  if (access.subscription?.subscriptionId && access.plan.isDefault) {
    return {
      tone: "warning",
      title: "Your subscription has ended",
      description: `You’re on ${describePlan(access.plan, limits)}. Subscribe again to get your previous allowance back.`,
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
 * The share of the allowance at which it counts as running out. One number
 * colours the meter, raises the banner, and offers the upgrade again.
 */
export const QUOTA_WARNING_RATIO = 0.8;

/** Where the current plan period stands against its allowance, ready to render. */
export interface QuotaMeter {
  used: number;
  limit: number;
  /** Share of the allowance spent, at most 1. */
  ratio: number;
  tone: "normal" | "warning" | "destructive";
  /** "8,420 of 10,000 requests". */
  label: string;
  /** "Resets Dec 1, 2026, 8:00 AM GMT+8". */
  caption: string;
}

/** The current period's request count, ready to show; `null` where nothing is counted. */
export function quotaMeter(allowance: PlanAllowance | undefined | null): QuotaMeter | null {
  if (!allowance) return null;
  const resets = formatBillingDateTime(allowance.resetAt);
  // An allowance of zero admits nothing, so it reads as fully spent, which it is.
  const ratio = allowance.limit > 0 ? Math.min(allowance.used / allowance.limit, 1) : 1;
  return {
    used: allowance.used,
    limit: allowance.limit,
    ratio,
    tone: ratio >= 1 ? "destructive" : ratio >= QUOTA_WARNING_RATIO ? "warning" : "normal",
    label: `${numbers.format(allowance.used)} of ${numbers.format(allowance.limit)} requests`,
    caption: resets ? `Resets ${resets}` : "Reset time unavailable",
  };
}

/** The banner for an allowance nearly or entirely spent: worth saying before requests start being refused. */
export function quotaNotice(allowance: PlanAllowance | undefined | null): BillingNotice | null {
  const meter = quotaMeter(allowance);
  if (!meter || meter.tone === "normal") return null;
  return meter.ratio >= 1
    ? {
        tone: "destructive",
        title: "Monthly request allowance spent",
        description: `Your apps' requests are being refused until the allowance resets. ${meter.caption}.`,
        actionable: true,
      }
    : {
        tone: "warning",
        title: "Monthly request allowance almost spent",
        description: `${meter.label} used in this period. ${meter.caption}.`,
        actionable: true,
      };
}

export function formatBillingDate(value: string | undefined | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** An exact instant in the viewer's local time, with the time-zone name. */
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

/** The subscription's next date: when a cancelled one ends, a trial ends, or an active one renews. */
export function subscriptionTimeline(subscription: SubscriptionState): { label: string; value: string } | null {
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
 * Where a plan sits against the others: its monthly price. The catalog has no
 * order of its own, and the free default plan, which has no price, ranks lowest.
 */
export function planRank(plan: BillingPlan): number {
  return priceFor(plan, "month")?.priceAmountCents ?? 0;
}

/** What a plan card's one button does. */
export interface PlanAction {
  /**
   * `current` is the plan already held. `checkout` buys a first subscription,
   * `change` moves a live one between paid plans, and `cancel` is the only way
   * back to the free plan: there is no price to change to.
   */
  intent: "current" | "checkout" | "change" | "cancel";
  label: string;
  variant: "default" | "outline";
  /** Set when the action cannot be taken, and why. */
  reason?: string;
}

const MANUALLY_MANAGED = "This plan was granted by hand. Ask support to change it.";

/** The button for one plan card, decided against the plan currently held (v1's rules). */
export function planAction(
  plan: BillingPlan,
  plans: BillingPlan[],
  access: BillingAccess | undefined | null,
  actions: SubscriptionActions | undefined,
): PlanAction {
  const current = entitledPlan(access);
  if (current && plan.planKey === current.planKey) {
    return { intent: "current", label: "Current plan", variant: "outline" };
  }
  const held = plans.find((entry) => entry.planKey === current?.planKey);
  const upgrade = planRank(plan) > (held ? planRank(held) : 0);
  const free = plan.prices.length === 0;
  const variant = upgrade ? "default" : "outline";
  const label = `${upgrade ? "Upgrade" : "Downgrade"} to ${plan.name}`;
  if (actions?.manual) return { intent: free ? "cancel" : "change", label, variant, reason: MANUALLY_MANAGED };
  if (free) {
    return actions?.cancel
      ? { intent: "cancel", label, variant }
      : { intent: "cancel", label, variant, reason: "There is no paid subscription to leave." };
  }
  return { intent: actions?.cancel ? "change" : "checkout", label, variant };
}

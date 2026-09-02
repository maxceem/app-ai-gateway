import type { BillingAccess, BillingPlan, BillingPrice } from "./types";

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

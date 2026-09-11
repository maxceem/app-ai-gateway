/**
 * The billing contract this gateway is written against.
 *
 * The gateway never depends on a billing implementation. It declares the shape
 * of the optional `BILLING` service binding here, and any Worker that satisfies
 * this interface can be bound to it. The open-source deployment binds nothing
 * at all — see `src/billing/gateway.ts`, where a missing binding means
 * "self-hosted, no plan limits" rather than an error.
 *
 * Keep this file free of implementation. It is a wire contract: changing a
 * field here is a breaking change for whatever Worker is bound on the other
 * side.
 */

/** Subscription statuses, as spelled by the billing provider. */
export const billingSubscriptionStatuses = [
  "on_trial",
  "active",
  "paused",
  "past_due",
  "unpaid",
  "cancelled",
  "expired",
] as const;

export type BillingSubscriptionStatus = (typeof billingSubscriptionStatuses)[number];

export const billingSources = ["lemon_squeezy", "manual"] as const;
export type BillingSource = (typeof billingSources)[number];

export const billingPeriods = ["month", "year"] as const;
export type BillingPeriod = (typeof billingPeriods)[number];

/**
 * The plan an organization is entitled to right now.
 *
 * `limits` is opaque to the billing side and interpreted only here — see
 * `billingPlanLimits`, which reads `maxRequestsPerMonth` out of it.
 */
export interface EntitledPlan {
  planKey: string;
  planName: string;
  limits: unknown;
  /** True when it came from the service's default plan rather than a subscription. */
  isDefault: boolean;
}

/**
 * What the organization is paying for, reported as stored.
 *
 * Deliberately separate from {@link EntitledPlan}: a subscription that no
 * longer entitles anything still has to be describable, because "your plan
 * ended" is a sentence only this object can support.
 */
export interface SubscriptionState {
  subscriptionId: string | null;
  status: BillingSubscriptionStatus;
  planKey: string;
  planName: string;
  /** Null for trials and manual grants, which carry no price. */
  billingPeriod: BillingPeriod | null;
  renewsAt: string | null;
  endsAt: string | null;
  trialEndsAt: string | null;
  source: BillingSource;
  /** This subscription generation */
  createdAt: string;
  updatedAt: string;
  /** Original provider day, retained when short months clamp the exact anchor. */
  billingAnchorDay: number | null;
  /** Exact normalized UTC origin of the monthly allowance schedule. */
  billingAnchorAt: string;
  /** When the current allowance schedule took effect. */
  billingScheduleUpdatedAt: string;
}

export interface BillingAccess {
  /** `null` means no entitlement at all, and the gateway refuses the request. */
  plan: EntitledPlan | null;
  /** `null` means the organization has no billing row. */
  subscription: SubscriptionState | null;
}

export interface BillingPlanOfferPrice {
  billingPeriod: BillingPeriod;
  priceAmountCents: number;
  priceCurrency: string;
}

export interface BillingPlanOffer {
  planKey: string;
  name: string;
  description: string;
  features: string[];
  limits?: unknown;
  trialDays: number;
  prices: BillingPlanOfferPrice[];
}

/**
 * The RPC surface the `BILLING` service binding must expose.
 *
 * Every call is scoped by `serviceId` (which product) and `tenantId` (which
 * paying entity inside it). This gateway always passes its own service id and
 * the authenticated organization id — see `BILLING_SERVICE_ID`.
 */
export interface BillingRuntime {
  getTenantAccess(input: { serviceId: string; tenantId: string }): Promise<BillingAccess>;

  listPlans(input: { serviceId: string }): Promise<{ plans: BillingPlanOffer[] }>;

  createCheckout(input: {
    serviceId: string;
    tenantId: string;
    planKey: string;
    billingPeriod: BillingPeriod;
    successUrl?: string | undefined;
    cancelUrl?: string | undefined;
  }): Promise<{ url: string }>;

  changePlan(input: {
    serviceId: string;
    tenantId: string;
    planKey: string;
    billingPeriod: BillingPeriod;
  }): Promise<{ ok: true; requiredActionUrl?: string | undefined }>;

  resumeSubscription(input: {
    serviceId: string;
    tenantId: string;
    planKey: string;
    billingPeriod: BillingPeriod;
  }): Promise<{ ok: true; requiredActionUrl?: string | undefined }>;

  cancelSubscription(input: { serviceId: string; tenantId: string }): Promise<{ ok: true }>;

  startTrial(input: {
    serviceId: string;
    tenantId: string;
    planKey: string;
  }): Promise<BillingAccess>;

  handleLemonWebhook(input: {
    serviceId: string;
    payloadJson: string;
    signature: string | null;
  }): Promise<{ ok: true; duplicate: boolean; stale: boolean }>;
}

const errorNamePrefix = "BillingHttpError";

/**
 * Reads the billing service's stable error code off anything it threw.
 *
 * Workers RPC serialises a thrown error using the standard `Error` fields only,
 * so own-properties like `code` may not survive a service-binding call. The
 * contract is that the code is *also* encoded into `name`
 * (`BillingHttpError:service_not_found`), which does survive. This reads
 * whichever form arrived, and returns `null` for anything else.
 */
export const billingErrorCodeOf = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const code = (error as { code?: unknown }).code;

  if (typeof code === "string" && code.length > 0) {
    return code;
  }

  const name = (error as { name?: unknown }).name;

  if (typeof name === "string" && name.startsWith(`${errorNamePrefix}:`)) {
    return name.slice(errorNamePrefix.length + 1) || null;
  }

  return null;
};

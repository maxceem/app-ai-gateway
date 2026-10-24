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
 * side. Every shape below is the one `src/contracts/billing.ts` declares, so
 * the RPC contract, the documented `/v1/admin/billing` responses and the
 * console all read one definition; what is written here is the RPC surface
 * itself, which has no wire schema because it is not HTTP.
 */
import {
  BillingCancelResponseSchema,
  BillingChangeResponseSchema,
  BillingCheckoutResponseSchema,
  billingPeriods,
  billingSources,
  billingSubscriptionStatuses,
  type BillingAccess,
  type BillingCancelResponse,
  type BillingChangeResponse,
  type BillingCheckoutResponse,
  type BillingPeriod,
  type BillingPlanOffer,
  type BillingPlanOfferPrice,
  type BillingSource,
  type BillingSubscriptionStatus,
  type EntitledPlan,
  type SubscriptionState,
} from "../contracts/billing";

export {
  billingPeriods,
  billingSources,
  billingSubscriptionStatuses,
  BillingCancelResponseSchema,
  BillingChangeResponseSchema,
  BillingCheckoutResponseSchema,
};
export type {
  BillingAccess,
  BillingCancelResponse,
  BillingChangeResponse,
  BillingCheckoutResponse,
  BillingPeriod,
  BillingPlanOffer,
  BillingPlanOfferPrice,
  BillingSource,
  BillingSubscriptionStatus,
  EntitledPlan,
  SubscriptionState,
};

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
  }): Promise<BillingCheckoutResponse>;

  changePlan(input: {
    serviceId: string;
    tenantId: string;
    planKey: string;
    billingPeriod: BillingPeriod;
  }): Promise<BillingChangeResponse>;

  resumeSubscription(input: {
    serviceId: string;
    tenantId: string;
    planKey: string;
    billingPeriod: BillingPeriod;
  }): Promise<BillingChangeResponse>;

  cancelSubscription(input: { serviceId: string; tenantId: string }): Promise<BillingCancelResponse>;

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

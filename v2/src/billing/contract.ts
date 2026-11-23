/**
 * The hosted billing service, as this gateway calls it through the optional
 * `BILLING` service binding (v1's contract, ported).
 *
 * Only the hosted deployment binds it, in its gitignored deployment config.
 * A deployment without it is self-hosted: no plan, no allowance, and every
 * billing operation answers 404.
 *
 * Keep this file free of implementation: it is the wire contract with
 * whatever Worker is bound on the other side, and a changed field breaks it.
 */
import type {
  BillingAccess,
  BillingCancelResponse,
  BillingChangeResponse,
  BillingCheckoutResponse,
  BillingPeriod,
  BillingPlanOffer,
} from "../contracts/billing.ts";

/**
 * The RPC surface the binding exposes. Every call names this product
 * (`serviceId`) and, where it acts on one, the account (`tenantId`).
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
  changePlan(input: { serviceId: string; tenantId: string; planKey: string; billingPeriod: BillingPeriod }): Promise<BillingChangeResponse>;
  resumeSubscription(input: { serviceId: string; tenantId: string; planKey: string; billingPeriod: BillingPeriod }): Promise<BillingChangeResponse>;
  cancelSubscription(input: { serviceId: string; tenantId: string }): Promise<BillingCancelResponse>;
}

/** The binding, if this deployment has one. It is not in the tracked `wrangler.jsonc`, so not in `Env`. */
export function billingBinding(env: Env): BillingRuntime | null {
  const binding = (env as { BILLING?: BillingRuntime }).BILLING;
  return binding === undefined || binding === null ? null : binding;
}

const ERROR_NAME_PREFIX = "BillingHttpError";

/**
 * The billing service's stable error code from anything it threw. Workers RPC
 * keeps only the standard `Error` fields, so the code is also in `name`
 * (`BillingHttpError:service_not_found`); this reads whichever arrived.
 */
export function billingErrorCodeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code.length > 0) return code;
  const name = (error as { name?: unknown }).name;
  if (typeof name === "string" && name.startsWith(`${ERROR_NAME_PREFIX}:`)) {
    return name.slice(ERROR_NAME_PREFIX.length + 1) || null;
  }
  return null;
}

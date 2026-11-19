/**
 * The hosted billing service, as this gateway calls it through the optional
 * `BILLING` service binding (v1's contract, ported).
 *
 * Only the hosted deployment binds it, in its gitignored deployment config.
 * A deployment without it is self-hosted: no plan, no allowance.
 */
import type { BillingAccess } from "../contracts/billing.ts";

/** The read the request path makes. The management side adds the rest of v1's contract with step 2. */
export interface BillingRuntime {
  getTenantAccess(input: { serviceId: string; tenantId: string }): Promise<BillingAccess>;
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

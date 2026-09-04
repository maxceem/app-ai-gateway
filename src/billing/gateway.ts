import {
  billingErrorCodeOf,
  type BillingRuntime,
  type EntitledPlan,
  type SubscriptionState,
} from "cf-billing";
import { GatewayError } from "../core/errors";

/**
 * This product's billing service id in cf-billing.
 *
 * Also the last path segment of its LemonSqueezy delivery URL
 * (`/webhooks/lemon-squeezy/app-ai-gateway`) and part of the encryption context
 * of its stored signing secret, so it is not a free-form label.
 */
export const BILLING_SERVICE_ID = "app-ai-gateway";
export const BILLING_ACCESS_CACHE_TTL_MS = 30_000;

/**
 * The gateway has exactly one enforceable quota, so a plan carries exactly one
 * limit. Absent means unlimited, which is what every self-hosted deployment and
 * every plan that does not mention the key gets.
 */
export interface BillingPlanLimits {
  /** Requests admitted for provider dispatch per calendar month, per organization. */
  maxRequestsPerMonth?: number;
}

/**
 * cf-billing's answer, plus the two states only the gateway can be in.
 *
 * `state` is the discriminant the whole gateway and console read: cf-billing
 * itself has no notion of a deployment without billing, nor of its own
 * unreachability, and both have to be distinguishable from "this organization
 * has no plan" — one is unlimited, one is temporary, one is a paywall.
 */
export type GatewayBillingAccess =
  /** No `BILLING` binding: self-hosted, unlimited, never refused. */
  | { state: "self_hosted" }
  /** The billing RPC failed. The allowance is unknown, so traffic waits. */
  | { state: "unavailable"; billingErrorCode?: string }
  /** cf-billing answered. `plan === null` means no entitlement at all. */
  | {
      state: "billed";
      plan: EntitledPlan | null;
      subscription: SubscriptionState | null;
    };

export type BillingRequestCache = Map<string, Promise<GatewayBillingAccess>>;

export interface BillingVariables {
  billingRequestCache: BillingRequestCache;
}

/** Structural RPC stub shape; avoids coupling the OSS gateway to the worker class. */
export type BillingBinding = BillingRuntime;
export interface BillingEnv {
  BILLING?: BillingBinding;
}

interface BillingAccessCacheEntry {
  expiresAt: number;
  value: Promise<GatewayBillingAccess>;
}

const billingAccessCache = new Map<string, BillingAccessCacheEntry>();

export function invalidateBillingAccess(organizationId: string): void {
  billingAccessCache.delete(organizationId);
}

export function clearBillingAccessCache(): void {
  billingAccessCache.clear();
}

export function billingBinding(env: BillingEnv): BillingBinding | undefined {
  return env.BILLING;
}

async function loadBillingAccess(env: BillingEnv, organizationId: string): Promise<GatewayBillingAccess> {
  const binding = billingBinding(env);
  if (!binding) return { state: "self_hosted" };

  try {
    const access = await binding.getTenantAccess({
      serviceId: BILLING_SERVICE_ID,
      tenantId: organizationId,
    });
    return { state: "billed", plan: access.plan, subscription: access.subscription };
  } catch (error) {
    const code = billingErrorCodeOf(error);
    console.error(JSON.stringify({
      message: "billing access RPC failed",
      serviceId: BILLING_SERVICE_ID,
      organizationId,
      billingErrorCode: code,
    }));
    return {
      state: "unavailable",
      ...(code ? { billingErrorCode: code } : {}),
    };
  }
}

/**
 * Reads billing access through a request-owned cache plus a short isolate TTL
 * cache. Self-hosted environments bypass both maps entirely.
 */
export function getBillingAccess(
  env: BillingEnv,
  organizationId: string,
  cache?: BillingRequestCache,
): Promise<GatewayBillingAccess> {
  if (!billingBinding(env)) return Promise.resolve({ state: "self_hosted" });

  const requestValue = cache?.get(organizationId);
  if (requestValue) return requestValue;

  const now = Date.now();
  const cached = billingAccessCache.get(organizationId);
  if (cached && cached.expiresAt > now) {
    cache?.set(organizationId, cached.value);
    return cached.value;
  }
  if (cached) billingAccessCache.delete(organizationId);

  const pending = loadBillingAccess(env, organizationId);
  billingAccessCache.set(organizationId, {
    expiresAt: now + BILLING_ACCESS_CACHE_TTL_MS,
    value: pending,
  });
  void pending.then((access) => {
    if (access.state !== "unavailable") return;
    const current = billingAccessCache.get(organizationId);
    if (current?.value === pending) billingAccessCache.delete(organizationId);
  });
  cache?.set(organizationId, pending);
  return pending;
}

/**
 * How long a client should wait before asking again after billing could not be
 * read. Shorter than {@link BILLING_ACCESS_CACHE_TTL_MS} on purpose: a failed
 * lookup is evicted from the cache rather than held for the TTL, so a retry
 * after this long reaches the billing service again rather than replaying the
 * same failure.
 */
export const BILLING_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/**
 * Refuses the request unless the organization holds a plan.
 *
 * With a default plan configured in cf-billing, holding no plan at all is rare:
 * an organization that never subscribed, or whose subscription lapsed, is on the
 * free tier rather than locked out. `402` is left for the cases where nothing
 * resolves — the service has no default plan, or it has been deactivated.
 */
export function requireActiveBilling(access: GatewayBillingAccess): GatewayBillingAccess {
  /*
   * Not being able to reach billing is not a statement about this
   * organization's subscription. Refusing is still correct — the allowance is
   * unknown, and admitting traffic on an unknown allowance is how a plan gets
   * overspent — but it has to be refused as our fault and as temporary.
   *
   * The distinction is the whole point: `402` tells a client its customer has
   * to go and pay, which a mobile app surfaces as an upsell and does not
   * retry. During an outage that would tell every paying customer they are
   * unsubscribed. `503` says the same request is worth sending again.
   */
  if (access.state === "unavailable") {
    throw new GatewayError(
      503,
      "billing_unavailable",
      "Billing could not be reached, so the request was not attempted",
      { "Retry-After": String(BILLING_UNAVAILABLE_RETRY_AFTER_SECONDS) },
    );
  }
  if (access.state === "billed" && access.plan === null) {
    throw new GatewayError(
      402,
      "payment_required",
      "No plan is available for this organization",
    );
  }
  return access;
}

/**
 * Reads one plan limit out of a hosted plan's `limits_json`.
 *
 * The value is authored by whoever configured the plan, and JSON has no integer
 * type, so a count may arrive as `10000`, `10000.0`, or `"10000"` and all three
 * mean the same allowance. Anything that is not one of those — a fraction, a
 * negative, a boolean, `null`, an object — is a misconfiguration this gateway
 * cannot resolve into an allowance, and it refuses the request rather than
 * guessing an allowance in either direction.
 */
function requestAllowance(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const numeric = typeof value === "string" && value.trim().length > 0
    ? Number(value)
    : value;
  if (
    typeof numeric !== "number"
    || !Number.isFinite(numeric)
    || !Number.isInteger(numeric)
    || numeric < 0
    || !Number.isSafeInteger(numeric)
  ) {
    throw new GatewayError(
      502,
      "billing_unavailable",
      "Billing plan limit maxRequestsPerMonth is invalid",
    );
  }
  return numeric;
}

export function billingPlanLimits(access: GatewayBillingAccess): BillingPlanLimits {
  if (access.state !== "billed" || access.plan === null) return {};
  const planLimits = access.plan.limits;
  if (planLimits === undefined) return {};
  if (typeof planLimits !== "object" || planLimits === null || Array.isArray(planLimits)) {
    throw new GatewayError(502, "billing_unavailable", "Billing plan limits are invalid");
  }
  const limits = planLimits as Record<string, unknown>;
  const maxRequestsPerMonth = requestAllowance(limits.maxRequestsPerMonth);
  return maxRequestsPerMonth === undefined ? {} : { maxRequestsPerMonth };
}

export function billingRpcError(error: unknown): GatewayError {
  const code = billingErrorCodeOf(error);
  if (code === "service_not_found" || code === "billing_plan_not_found" || code === "billing_plan_price_not_found") {
    return new GatewayError(404, "billing_not_found", "The requested billing resource was not found");
  }
  if (code === "service_inactive" || code === "billing_manually_managed") {
    return new GatewayError(403, "billing_action_forbidden", "This billing action is not available");
  }
  if (code === "billing_subscription_already_active") {
    return new GatewayError(409, "billing_conflict", "A live subscription already exists");
  }
  return new GatewayError(502, "billing_unavailable", "The billing service is unavailable");
}

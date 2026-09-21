import { billingErrorCodeOf, type BillingRuntime } from "./contract";
import type { Deployment } from "../policy/deployment";
import type { GatewayBillingAccess, PlanLimits } from "../contracts/billing";
import { GatewayError } from "../core/errors";
import { log } from "../core/log";
import { ttlCache } from "../core/ttl-cache";

/**
 * This product's id in the billing service.
 *
 * Also the last path segment of its LemonSqueezy delivery URL
 * (`/webhooks/lemon-squeezy/app-ai-gateway`) and part of the encryption context
 * of its stored signing secret, so it is not a free-form label.
 */
export const BILLING_SERVICE_ID = "app-ai-gateway";
export const BILLING_ACCESS_CACHE_TTL_MS = 30_000;

/**
 * How long a successful reading stays usable once billing stops answering.
 *
 * Refusing traffic on an *unknown* allowance is right; refusing it on a plan
 * that was known a minute ago turns a billing-service deploy into an outage for
 * every customer. An hour is long enough to ride out a deploy, a D1 blip or a
 * service-binding hiccup, and short enough that a genuinely cancelled
 * subscription is not served for a working day.
 */
export const BILLING_STALE_MAX_MS = 60 * 60_000;

/**
 * How long a client should wait before asking again after billing could not be
 * read. Also how long a failed — or stale-served — lookup is held in the
 * isolate cache, so a flapping billing service is asked at most once per this
 * interval per organization per isolate, and a recovery is noticed just as
 * quickly.
 */
export const BILLING_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/**
 * What a plan allows, read out of its opaque `limits` JSON — declared as
 * `PlanLimitsSchema` in `src/contracts/billing.ts`, because the billing status
 * endpoint publishes the same object the write path enforces.
 *
 * `maxRequestsPerMonth` is spent on the data plane. The rest are ceilings on
 * stored configuration, enforced by the write that would exceed them; see
 * `src/management/plan-caps.ts`.
 *
 * All of these are the plan allowance an organization is metered against, never
 * the limits an organization sets on its own app's end users — those are
 * `app_*` codes and `src/do/UserLimiter.ts`, and no value here may cap them.
 */
export type { PlanLimits };

const PLAN_LIMIT_KEYS = [
  "maxRequestsPerMonth",
  "maxApps",
  "maxProviders",
  "maxProviderGateways",
  "maxActiveKeysPerApp",
] as const satisfies readonly (keyof PlanLimits)[];

/**
 * The billing service's answer, plus the two states only the gateway can be in
 * — declared as `GatewayBillingAccessSchema` in `src/contracts/billing.ts`,
 * because the console reads this union off the billing status endpoint.
 *
 * A stale reading is served for {@link BILLING_STALE_MAX_MS} after the billing
 * service stops answering. Entitlement decisions are unchanged by it: a stale
 * `plan === null` is still a paywall.
 */
export type { GatewayBillingAccess };

export type BillingRequestCache = Map<string, Promise<GatewayBillingAccess>>;

/**
 * The pending or settled answer per organization. The promise itself is what is
 * stored, so concurrent requests for one organization share a single RPC.
 *
 * Keyed by organization ids that came from D1, so it is not attacker-growable;
 * the bound only stops a long-lived isolate in a large deployment from keeping
 * an entry per organization it ever served.
 */
const billingAccessCache = ttlCache<string, Promise<GatewayBillingAccess>>({
  name: "billing-access",
  ttlMs: BILLING_ACCESS_CACHE_TTL_MS,
  maxEntries: 5_000,
});

/**
 * The last reading the billing service actually gave, per organization, kept
 * beyond the TTL cache so an outage can be answered with it. Its own TTL is the
 * stale window: an entry that is still fresh is one still worth serving.
 */
const lastKnownAccess = ttlCache<string, GatewayBillingAccess & { state: "billed" }>({
  name: "billing-last-known",
  ttlMs: BILLING_STALE_MAX_MS,
  maxEntries: 5_000,
});

export function invalidateBillingAccess(organizationId: string): void {
  billingAccessCache.delete(organizationId);
  lastKnownAccess.delete(organizationId);
}

export function invalidateBillingRequestAccess(
  organizationId: string,
  cache?: BillingRequestCache,
): void {
  billingAccessCache.delete(organizationId);
  lastKnownAccess.delete(organizationId);
  cache?.delete(organizationId);
}

function entitlementEndsAt(access: GatewayBillingAccess): number | null {
  if (access.state !== "billed" || access.plan?.isDefault !== false || !access.subscription) {
    return null;
  }
  const transition = access.subscription.status === "on_trial"
    ? access.subscription.trialEndsAt
    : access.subscription.endsAt;
  if (!transition) return null;
  const at = Date.parse(transition);
  return Number.isFinite(at) ? at : null;
}

async function loadBillingAccess(
  binding: BillingRuntime,
  organizationId: string,
): Promise<GatewayBillingAccess> {
  try {
    const access = await binding.getTenantAccess({
      serviceId: BILLING_SERVICE_ID,
      tenantId: organizationId,
    });
    const value = {
      state: "billed",
      plan: access.plan,
      subscription: access.subscription,
    } satisfies GatewayBillingAccess;
    const now = Date.now();
    const endsAt = entitlementEndsAt(value);
    if (endsAt !== null && endsAt <= now) {
      console.error(JSON.stringify({
        message: "billing returned an expired paid entitlement",
        serviceId: BILLING_SERVICE_ID,
        organizationId,
      }));
      return { state: "unavailable" };
    }
    lastKnownAccess.set(organizationId, value, { storedAt: now });
    return value;
  } catch (error) {
    const code = billingErrorCodeOf(error);
    console.error(JSON.stringify({
      message: "billing access RPC failed",
      serviceId: BILLING_SERVICE_ID,
      organizationId,
      billingErrorCode: code,
    }));
    /*
     * Fail closed on an unknown allowance, not on a known one. An organization
     * this isolate has read before keeps the plan it had; one it has never
     * seen still waits, because admitting it would mean guessing an allowance.
     * Still fresh here means still inside the stale window, which is exactly
     * what that cache's TTL is.
     */
    const known = lastKnownAccess.get(organizationId);
    if (known) {
      const endsAt = entitlementEndsAt(known);
      if (endsAt === null || endsAt > Date.now()) {
        const ageMs = Date.now() - (lastKnownAccess.peek(organizationId)?.storedAt ?? 0);
        log("warn", "billing_access_stale", { organizationId, ageMs, billingErrorCode: code });
        return { ...known, stale: true, ...(code ? { billingErrorCode: code } : {}) };
      }
    }
    return {
      state: "unavailable",
      ...(code ? { billingErrorCode: code } : {}),
    };
  }
}

/**
 * Reads billing access through a request-owned cache plus a short isolate TTL
 * cache. Self-hosted deployments bypass both maps entirely.
 */
export function getBillingAccess(
  deployment: Deployment,
  organizationId: string,
  cache?: BillingRequestCache,
): Promise<GatewayBillingAccess> {
  // The one place `self_hosted` is produced: no billing service, no plan, and
  // no map to consult about one.
  if (!deployment.billing) return Promise.resolve({ state: "self_hosted" });

  const requestValue = cache?.get(organizationId);
  if (requestValue) return requestValue;

  const now = Date.now();
  const cached = billingAccessCache.get(organizationId, now);
  if (cached) {
    cache?.set(organizationId, cached);
    return cached;
  }
  billingAccessCache.delete(organizationId);

  const pending = loadBillingAccess(deployment.billing, organizationId);
  billingAccessCache.set(organizationId, pending, { storedAt: now });
  /*
   * A fresh answer from billing keeps the full TTL. Anything else — unavailable,
   * or the last known reading served stale — is held only for the retry
   * interval: long enough that a failing billing service is asked once per
   * interval per organization instead of once per request, short enough that
   * its recovery is picked up almost immediately.
   *
   * A binding is present here, so `self_hosted` cannot occur.
   */
  void pending.then((access) => {
    // Only this entry's own answer may shorten it: another request may already
    // have replaced it, and that one carries its own window.
    if (billingAccessCache.peek(organizationId)?.value !== pending) return;
    if (access.state === "billed" && !access.stale) {
      const endsAt = entitlementEndsAt(access);
      if (endsAt === null) return;
      billingAccessCache.set(organizationId, pending, {
        storedAt: now,
        ttlMs: Math.min(BILLING_ACCESS_CACHE_TTL_MS, endsAt - now),
      });
      return;
    }
    billingAccessCache.set(organizationId, pending, {
      storedAt: now,
      ttlMs: BILLING_UNAVAILABLE_RETRY_AFTER_SECONDS * 1_000,
    });
  });
  cache?.set(organizationId, pending);
  return pending;
}

/**
 * Refuses the request unless the organization holds a plan.
 *
 * With a default plan configured in the billing service, holding no plan at all is rare:
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
      "billing_payment_required",
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
 * mean the same number. Anything that is not one of those — a fraction, a
 * negative, a boolean, `null`, an object — is a misconfiguration this gateway
 * cannot resolve into a limit, and it refuses the request rather than guessing
 * one in either direction.
 */
function countLimit(value: unknown, key: string): number | undefined {
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
      `Billing plan limit ${key} is invalid`,
    );
  }
  return numeric;
}

export function billingPlanLimits(access: GatewayBillingAccess): PlanLimits {
  if (access.state !== "billed" || access.plan === null) return {};
  const planLimits = access.plan.limits;
  if (planLimits === undefined) return {};
  if (typeof planLimits !== "object" || planLimits === null || Array.isArray(planLimits)) {
    throw new GatewayError(502, "billing_unavailable", "Billing plan limits are invalid");
  }
  const limits = planLimits as Record<string, unknown>;
  const resolved: PlanLimits = {};
  for (const key of PLAN_LIMIT_KEYS) {
    const value = countLimit(limits[key], key);
    if (value !== undefined) resolved[key] = value;
  }
  return resolved;
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

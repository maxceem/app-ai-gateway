/**
 * Reading an account's plan from the billing service, with v1's caches: a
 * short isolate cache, the last known reading kept for an hour to ride out a
 * billing outage, and a deadline for app traffic so a slow billing service
 * never holds a request (`billing_access_slow`).
 *
 * Ported from v1's `src/billing/gateway.ts`, request path only.
 */
import { PlanLimitInputSchema, type GatewayBillingAccess, type PlanLimitKey, type PlanLimits } from "../contracts/billing.ts";
import { errorFacts } from "../core/error-facts.ts";
import { GatewayError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { ttlCache } from "../core/ttl-cache.ts";
import { billingBinding, billingErrorCodeOf, type BillingRuntime } from "./contract.ts";

/** This product's id in the billing service. */
export const BILLING_SERVICE_ID = "app-ai-gateway";

export const BILLING_ACCESS_CACHE_TTL_MS = 30_000;

/** How long the last real reading is served once billing stops answering. */
export const BILLING_STALE_MAX_MS = 60 * 60_000;

/** How long a failed or stale-served lookup is held, so a flapping service is asked once per interval. */
export const BILLING_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** How long app traffic waits for billing. Past it, the request is answered as if billing had failed. */
export const APP_TRAFFIC_BILLING_DEADLINE_MS = 1_000;

/** Keyed by account ids that came from D1, so not attacker-growable. */
const billingAccessCache = ttlCache<string, Promise<GatewayBillingAccess>>({
  name: "billing-access",
  ttlMs: BILLING_ACCESS_CACHE_TTL_MS,
  maxEntries: 5_000,
});

const lastKnownAccess = ttlCache<string, GatewayBillingAccess & { state: "billed" }>({
  name: "billing-last-known",
  ttlMs: BILLING_STALE_MAX_MS,
  maxEntries: 5_000,
});

function entitlementEndsAt(access: GatewayBillingAccess): number | null {
  if (access.state !== "billed" || access.plan?.isDefault !== false || !access.subscription) return null;
  const transition =
    access.subscription.status === "on_trial" ? access.subscription.trialEndsAt : access.subscription.endsAt;
  if (!transition) return null;
  const at = Date.parse(transition);
  return Number.isFinite(at) ? at : null;
}

async function loadBillingAccess(binding: BillingRuntime, accountId: string): Promise<GatewayBillingAccess> {
  try {
    const access = await binding.getTenantAccess({ serviceId: BILLING_SERVICE_ID, tenantId: accountId });
    const value = { state: "billed", plan: access.plan, subscription: access.subscription } satisfies GatewayBillingAccess;
    const now = Date.now();
    const endsAt = entitlementEndsAt(value);
    if (endsAt !== null && endsAt <= now) {
      log("error", "billing_expired_entitlement", { account: accountId });
      return { state: "unavailable" };
    }
    lastKnownAccess.set(accountId, value, { storedAt: now });
    return value;
  } catch (error) {
    const code = billingErrorCodeOf(error);
    log("error", "billing_access_failed", { account: accountId, billingErrorCode: code, error: errorFacts(error) });
    return withoutBilling(accountId, code);
  }
}

/** While billing cannot answer: the last known plan if there is one, otherwise unavailable. */
function withoutBilling(accountId: string, code?: string | null): GatewayBillingAccess {
  const known = lastKnownAccess.get(accountId);
  if (known) {
    const endsAt = entitlementEndsAt(known);
    if (endsAt === null || endsAt > Date.now()) {
      const ageMs = Date.now() - (lastKnownAccess.peek(accountId)?.storedAt ?? 0);
      log("warn", "billing_access_stale", { account: accountId, ageMs, billingErrorCode: code ?? null });
      return { ...known, stale: true, ...(code ? { billingErrorCode: code } : {}) };
    }
  }
  return { state: "unavailable", ...(code ? { billingErrorCode: code } : {}) };
}

/** The account's billing access. Self-hosted (no binding) reads nothing. */
export function getBillingAccess(env: Env, accountId: string): Promise<GatewayBillingAccess> {
  const binding = billingBinding(env);
  if (binding === null) return Promise.resolve({ state: "self_hosted" });
  const now = Date.now();
  const cached = billingAccessCache.get(accountId, now);
  if (cached) return cached;
  billingAccessCache.delete(accountId);
  const pending = loadBillingAccess(binding, accountId);
  billingAccessCache.set(accountId, pending, { storedAt: now });
  // A fresh answer keeps the full TTL, or less if the entitlement ends sooner.
  // Anything else is held only for the retry interval.
  void pending.then((access) => {
    if (billingAccessCache.peek(accountId)?.value !== pending) return;
    if (access.state === "billed" && !access.stale) {
      const endsAt = entitlementEndsAt(access);
      if (endsAt === null) return;
      billingAccessCache.set(accountId, pending, { storedAt: now, ttlMs: Math.min(BILLING_ACCESS_CACHE_TTL_MS, endsAt - now) });
      return;
    }
    billingAccessCache.set(accountId, pending, { storedAt: now, ttlMs: BILLING_UNAVAILABLE_RETRY_AFTER_SECONDS * 1_000 });
  });
  return pending;
}

/**
 * Billing access for app traffic: never waits longer than `deadlineMs`. A late
 * answer is treated as a failed one (the last known plan, or unavailable),
 * logged `billing_access_slow`, and the read keeps running to fill the caches.
 */
export async function getAppTrafficBillingAccess(
  env: Env,
  accountId: string,
  waitUntil: (promise: Promise<unknown>) => void,
  deadlineMs: number = APP_TRAFFIC_BILLING_DEADLINE_MS,
): Promise<GatewayBillingAccess> {
  const pending = getBillingAccess(env, accountId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, deadlineMs));
  });
  try {
    const access = await Promise.race([pending, late]);
    if (access !== null) return access;
  } finally {
    clearTimeout(timer);
  }
  waitUntil(pending);
  log("warn", "billing_access_slow", { account: accountId, deadlineMs });
  return withoutBilling(accountId);
}

/**
 * App traffic and billing: a billing service that cannot be read never refuses
 * an app's request (it is served uncounted). No plan resolving at all is
 * still `402`, as v1.
 */
export function admitAppTraffic(access: GatewayBillingAccess, accountId: string): void {
  if (access.state === "unavailable") {
    log("warn", "billing_unavailable_admitted", {
      account: accountId,
      ...(access.billingErrorCode ? { billingErrorCode: access.billingErrorCode } : {}),
    });
    return;
  }
  if (access.state === "billed" && access.plan === null) {
    throw new GatewayError(402, "billing_payment_required", "No plan is available for this account");
  }
}

/** The plan limits the request path spends. */
const REQUEST_PATH_LIMITS: readonly PlanLimitKey[] = ["maxRequestsPerMonth", "maxSessionMinutesPerMonth"];

/**
 * The plan limits named by `keys`, from a plan's `limits`. Each key is read on
 * its own, so a bad value under one key never spoils another: a broken
 * `maxApps` does not stop the allowance from being counted.
 *
 * A value plan data cannot be read as is a misconfiguration this gateway
 * cannot turn into a limit, so this throws. The request path catches it and
 * serves the request uncounted, logged as `allowance_uncounted`; only
 * settings-side callers refuse with it.
 */
export function billingPlanLimits(access: GatewayBillingAccess, keys: readonly PlanLimitKey[] = REQUEST_PATH_LIMITS): PlanLimits {
  if (access.state !== "billed" || access.plan === null || access.plan.limits === undefined) return {};
  const raw = access.plan.limits;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new GatewayError(502, "billing_unavailable", "Billing plan limits are invalid");
  }
  const limits: PlanLimits = {};
  for (const key of keys) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const parsed = PlanLimitInputSchema.safeParse(value);
    if (!parsed.success || parsed.data === undefined) {
      throw new GatewayError(502, "billing_unavailable", `Billing plan limit ${key} is invalid`);
    }
    limits[key] = parsed.data;
  }
  return limits;
}

/**
 * The plan, for a settings write that a plan can limit. Unlike app traffic, a
 * write never guesses: billing that cannot be read answers 503 (worth
 * retrying), and an account with no plan at all answers 402, as v1.
 */
export function requireActiveBilling(access: GatewayBillingAccess): GatewayBillingAccess {
  if (access.state === "unavailable") {
    throw new GatewayError(503, "billing_unavailable", "Billing could not be reached, so nothing was saved; retry shortly", {
      "Retry-After": String(BILLING_UNAVAILABLE_RETRY_AFTER_SECONDS),
    });
  }
  if (access.state === "billed" && access.plan === null) {
    throw new GatewayError(402, "billing_payment_required", "No plan is available for this account");
  }
  return access;
}

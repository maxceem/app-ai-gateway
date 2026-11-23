/**
 * Reading an account's plan from the billing service, with v1's caches: a
 * short isolate cache, the last known reading kept for an hour to ride out a
 * billing outage, and a deadline for app traffic so a slow billing service
 * never holds a request (`billing_access_slow`).
 *
 * Ported from v1's `src/billing/gateway.ts`, request path only.
 */
import {
  PLAN_FEATURES,
  PlanLimitInputSchema,
  type BillingAccess,
  type GatewayBillingAccess,
  type PlanFeature,
  type PlanFeatureAccess,
  type PlanLimitKey,
  type PlanLimits,
  type SubscriptionActions,
} from "../contracts/billing.ts";
import { withDeadline } from "../core/background.ts";
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

/**
 * After a change the account made itself (a plan change, a resume, a
 * cancel): forgets this isolate's cached reading, so the next read asks the
 * billing service. A read begun before the change is no longer the cached
 * one, so it stores nothing when it finishes (Sol 7b-8). Other isolates catch
 * up within the cache's own 30 s. The last known reading stays: it is what
 * app traffic falls back on while billing cannot answer, and a console action
 * never takes that away.
 */
export function invalidateBillingAccess(accountId: string): void {
  billingAccessCache.delete(accountId);
}

function entitlementEndsAt(access: GatewayBillingAccess): number | null {
  if (access.state !== "billed" || access.plan?.isDefault !== false || !access.subscription) return null;
  const transition =
    access.subscription.status === "on_trial" ? access.subscription.trialEndsAt : access.subscription.endsAt;
  if (!transition) return null;
  const at = Date.parse(transition);
  return Number.isFinite(at) ? at : null;
}

/**
 * The billing service's answer as the gateway's billing access. A paid plan
 * whose subscription or trial has already ended is not served as paid: it
 * answers unavailable and is logged.
 */
function accessFrom(accountId: string, answer: BillingAccess): GatewayBillingAccess {
  const value = { state: "billed", plan: answer.plan, subscription: answer.subscription } satisfies GatewayBillingAccess;
  const endsAt = entitlementEndsAt(value);
  if (endsAt !== null && endsAt <= Date.now()) {
    log("error", "billing_expired_entitlement", { account: accountId });
    return { state: "unavailable" };
  }
  return value;
}

async function loadBillingAccess(binding: BillingRuntime, accountId: string): Promise<GatewayBillingAccess> {
  try {
    return accessFrom(accountId, await binding.getTenantAccess({ serviceId: BILLING_SERVICE_ID, tenantId: accountId }));
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
  // A fresh answer keeps the full TTL, or less if the entitlement ends sooner,
  // and becomes the last known plan. Anything else is held only for the retry
  // interval. A read that is no longer the account's cached one stores
  // nothing at all, neither here nor as the last known plan: a change made
  // since dropped it, or a newer read replaced it (Sol 7b-8).
  void pending.then((access) => {
    if (billingAccessCache.peek(accountId)?.value !== pending) return;
    if (access.state === "billed" && !access.stale) {
      lastKnownAccess.set(accountId, access, { storedAt: now });
      const endsAt = entitlementEndsAt(access);
      if (endsAt === null) return;
      billingAccessCache.set(accountId, pending, { storedAt: now, ttlMs: Math.min(BILLING_ACCESS_CACHE_TTL_MS, endsAt - now) });
      return;
    }
    billingAccessCache.set(accountId, pending, { storedAt: now, ttlMs: BILLING_UNAVAILABLE_RETRY_AFTER_SECONDS * 1_000 });
  });
  return pending;
}

/** How long the console waits for the billing service. */
export const CONSOLE_BILLING_DEADLINE_MS = 1_000;

function consoleBillingUnavailable(): GatewayError {
  return new GatewayError(503, "billing_unavailable", "The billing service could not be read; try again shortly", {
    "Retry-After": String(BILLING_UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

/**
 * The account's plan for the console (the billing page, a write's check):
 * asked of the billing service directly, every time, so a checkout or a change
 * shows at once. It is kept apart from app traffic's plan reading (Sol 7b-8):
 * it never reads, joins or fills app traffic's cache, nor its last known plan,
 * so nothing the console does can put an old plan back for app traffic or
 * take its fallback away.
 *
 * It waits at most `deadlineMs`. A failed or late call answers 503. A late
 * answer is dropped: it reaches no cache, so it can never affect a later read.
 */
export async function readBillingForConsole(
  env: Env,
  accountId: string,
  deadlineMs: number = CONSOLE_BILLING_DEADLINE_MS,
): Promise<GatewayBillingAccess> {
  const binding = billingBinding(env);
  if (binding === null) return { state: "self_hosted" };
  try {
    const answer = await withDeadline(
      binding.getTenantAccess({ serviceId: BILLING_SERVICE_ID, tenantId: accountId }),
      deadlineMs,
      "reading the account's plan",
    );
    return accessFrom(accountId, answer);
  } catch (error) {
    const code = billingErrorCodeOf(error);
    log("warn", "billing_console_read_failed", { account: accountId, billingErrorCode: code, error: errorFacts(error) });
    throw consoleBillingUnavailable();
  }
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
 * retrying), also while only a stale last reading is kept, and an account
 * with no plan at all answers 402, as v1.
 */
export function requireActiveBilling(access: GatewayBillingAccess): GatewayBillingAccess {
  // A stale reading is the last answer kept through an outage, not a reading:
  // a write refuses as for no answer at all, even when that answer was "no plan".
  if (access.state === "unavailable" || (access.state === "billed" && access.stale === true)) {
    throw new GatewayError(503, "billing_unavailable", "Billing could not be reached, so nothing was saved; retry shortly", {
      "Retry-After": String(BILLING_UNAVAILABLE_RETRY_AFTER_SECONDS),
    });
  }
  if (access.state === "billed" && access.plan === null) {
    throw new GatewayError(402, "billing_payment_required", "No plan is available for this account");
  }
  return access;
}

export { PLAN_FEATURES, type PlanFeature };

/** How each plan feature is named and refused, and whether it stays usable while billing cannot be read (v1's policy). */
interface FeaturePolicy {
  /** How the feature is named in a refusal, at the start of a sentence. */
  readonly name: string;
  /** The refusal's code. Its own code only where a client already reads one. */
  readonly code: "billing_feature_not_included" | "support_plan_required";
  /**
   * Whether the feature stays usable while billing cannot be read. Usually
   * not: admitting it would mean guessing the plan. Human support is the
   * exception, because an outage is when a paying customer most needs it.
   */
  readonly whileBillingUnavailable: boolean;
}

const FEATURE_POLICY = {
  conversationStorage: { name: "Conversation history", code: "billing_feature_not_included", whileBillingUnavailable: false },
  humanSupport: { name: "Human support", code: "support_plan_required", whileBillingUnavailable: true },
} as const satisfies Record<PlanFeature, FeaturePolicy>;

/**
 * Whether the account's plan includes `feature` (v1's `planIncludes`).
 * Self-hosted: always. Billing that cannot be read: as the feature's policy
 * says, since an outage says nothing about the plan. A `limits.includes`
 * that is not a list of strings throws `502`: the plan is misconfigured.
 */
export function planIncludes(access: GatewayBillingAccess, feature: PlanFeature): boolean {
  if (access.state === "self_hosted") return true;
  if (access.state === "unavailable") return FEATURE_POLICY[feature].whileBillingUnavailable;
  if (access.plan === null) return false;
  const limits = access.plan.limits;
  if (limits === undefined || limits === null) return true;
  if (typeof limits !== "object" || Array.isArray(limits)) {
    throw new GatewayError(502, "billing_unavailable", "Billing plan limits are invalid");
  }
  const includes = (limits as Record<string, unknown>).includes;
  if (includes === undefined) return true;
  if (!Array.isArray(includes) || !includes.every((entry) => typeof entry === "string")) {
    throw new GatewayError(502, "billing_unavailable", "Billing plan limit includes is invalid");
  }
  return includes.includes(feature);
}

/** Whether the plan includes each feature, as the billing page shows it. A misconfigured list reads as none. */
export function planFeatures(access: GatewayBillingAccess): PlanFeatureAccess {
  return Object.fromEntries(
    PLAN_FEATURES.map((feature) => {
      try {
        return [feature, planIncludes(access, feature)];
      } catch {
        return [feature, false];
      }
    }),
  ) as PlanFeatureAccess;
}

/** Subscription statuses the billing provider can still cancel at the end of the period. */
const CANCELLABLE_STATUSES: ReadonlySet<string> = new Set(["on_trial", "active", "paused", "past_due"]);

/**
 * What a person may do about the subscription from the console (v1's rule).
 * Keyed off the subscription, not the plan: an account on the free default
 * plan can still hold a cancelled subscription to resume. A grant made by
 * hand is the billing operator's to change, so it offers nothing.
 */
export function subscriptionActions(access: GatewayBillingAccess): SubscriptionActions {
  const subscription = access.state === "billed" ? access.subscription : null;
  if (!subscription) return { cancel: false, resume: false, manual: false };
  const selfService = Boolean(subscription.subscriptionId) && subscription.source === "lemon_squeezy";
  return {
    cancel: selfService && CANCELLABLE_STATUSES.has(subscription.status),
    resume: selfService && subscription.status === "cancelled",
    manual: subscription.source === "manual" && CANCELLABLE_STATUSES.has(subscription.status),
  };
}

/** A billing service refusal as this gateway's own error (v1's mapping). Anything unknown is a 502. */
export function billingRpcError(error: unknown): GatewayError {
  const code = billingErrorCodeOf(error);
  if (code === "service_not_found" || code === "billing_plan_not_found" || code === "billing_plan_price_not_found") {
    return new GatewayError(404, "billing_not_found", "The requested plan was not found");
  }
  if (code === "service_inactive" || code === "billing_manually_managed") {
    return new GatewayError(403, "billing_action_forbidden", "This billing action is not available");
  }
  if (code === "billing_subscription_already_active") {
    return new GatewayError(409, "billing_conflict", "A live subscription already exists");
  }
  log("error", "billing_action_failed", { billingErrorCode: code, error: errorFacts(error) });
  return new GatewayError(502, "billing_unavailable", "The billing service is unavailable; try again shortly");
}

/**
 * Refuses the call unless the account's plan includes the feature, and
 * answers with the billing access it read. Billing that cannot be read
 * answers 503 rather than guessing, unless the feature's policy allows it
 * (human support).
 */
export async function requirePlanFeature(env: Env, accountId: string, feature: PlanFeature): Promise<GatewayBillingAccess> {
  const access = await getBillingAccess(env, accountId);
  if (planIncludes(access, feature)) return access;
  requireActiveBilling(access);
  const policy = FEATURE_POLICY[feature];
  throw new GatewayError(403, policy.code, `${policy.name} is not included in this account's plan`, undefined, { data: { feature } });
}

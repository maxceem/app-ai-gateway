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
 * Each account's billing version in this isolate: bumped by every change the
 * account makes through the console here. A plan read records the version it
 * started under and stores its answer only if the version is still the same
 * when it finishes, so a read begun before an upgrade can never put the old
 * plan back once the upgrade is made (Sol 7b-8). It is isolate memory: a
 * change lands on one isolate, and the others catch up within the cache's own
 * 30 s. An entry that ages out reads as 0, which only ever stops a store.
 */
const billingVersions = ttlCache<string, number>({
  name: "billing-version",
  ttlMs: 10 * 60_000,
  maxEntries: 5_000,
});

function billingVersion(accountId: string): number {
  return billingVersions.get(accountId) ?? 0;
}

/**
 * After a change the account made itself (a checkout, a plan change, a
 * cancel): bumps its billing version and forgets this isolate's cached
 * reading, so the next read asks the billing service and none begun before
 * the change can store what it read. The last known reading stays: it is what
 * app traffic falls back on while billing cannot answer, and a console action
 * never takes that away.
 */
export function invalidateBillingAccess(accountId: string): void {
  billingVersions.set(accountId, billingVersion(accountId) + 1);
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

/** When billing gave each reading app traffic holds: how old the plan a refusal rests on is. */
const readAt = new WeakMap<GatewayBillingAccess, number>();

/** How long ago billing gave this reading; a reading it did not give (a fallback) has no age. */
export function billingReadAgeMs(access: GatewayBillingAccess, now: number = Date.now()): number {
  const at = readAt.get(access);
  return at === undefined ? Number.POSITIVE_INFINITY : now - at;
}

async function loadBillingAccess(binding: BillingRuntime, accountId: string): Promise<GatewayBillingAccess> {
  try {
    const access = await binding.getTenantAccess({ serviceId: BILLING_SERVICE_ID, tenantId: accountId });
    const value = { state: "billed", plan: access.plan, subscription: access.subscription } satisfies GatewayBillingAccess;
    const now = Date.now();
    readAt.set(value, now);
    const endsAt = entitlementEndsAt(value);
    if (endsAt !== null && endsAt <= now) {
      log("error", "billing_expired_entitlement", { account: accountId });
      return { state: "unavailable" };
    }
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
  const version = billingVersion(accountId);
  const pending = loadBillingAccess(binding, accountId);
  billingAccessCache.set(accountId, pending, { storedAt: now });
  // A fresh answer keeps the full TTL, or less if the entitlement ends sooner,
  // and becomes the last known plan. Anything else is held only for the retry
  // interval. A read that is no longer the account's current one stores
  // nothing at all, neither here nor as the last known plan: a change made
  // since outdated it, or a newer read replaced it (Sol 7b-8).
  void pending.then((access) => {
    if (billingVersion(accountId) !== version || billingAccessCache.peek(accountId)?.value !== pending) return;
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

/** How old the plan a refusal rests on may be before billing is asked again. */
export const BILLING_RECHECK_AFTER_MS = 5_000;

/**
 * The account's plan, read at most `maxAgeMs` ago: this isolate's reading (or
 * the read in flight) when it is that recent, otherwise a new read that
 * replaces it. App traffic asks for it only before refusing a request on a
 * used-up allowance: the cached plan can be up to 30 s old, and an upgrade
 * paid since must not be refused on (Sol 7b-8). Requests at the same moment
 * share one read, so a busy account at its allowance costs at most one
 * billing read per interval in each isolate. Never rejects.
 */
export function recentBillingAccess(
  env: Env,
  accountId: string,
  maxAgeMs: number = BILLING_RECHECK_AFTER_MS,
): Promise<GatewayBillingAccess> {
  const now = Date.now();
  const entry = billingAccessCache.peek(accountId);
  if (entry !== undefined && entry.expiresAt > now && now - entry.storedAt < maxAgeMs) return entry.value;
  billingAccessCache.delete(accountId);
  return getBillingAccess(env, accountId);
}

/** When a console read of an account last failed or ran late: within the retry interval, none is started. */
const consoleReadFailedAt = ttlCache<string, number>({
  name: "billing-console-failed",
  ttlMs: BILLING_UNAVAILABLE_RETRY_AFTER_SECONDS * 1_000,
  maxEntries: 5_000,
});

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
 * It waits at most `deadlineMs`. A failed or late call answers 503, and no
 * new call is made for that account within the retry interval, so a console
 * left open through an outage adds no load. A late answer is dropped: it
 * reaches no cache, so it can never affect a later read.
 */
export async function readBillingForConsole(
  env: Env,
  accountId: string,
  deadlineMs: number = CONSOLE_BILLING_DEADLINE_MS,
): Promise<GatewayBillingAccess> {
  const binding = billingBinding(env);
  if (binding === null) return { state: "self_hosted" };
  if (consoleReadFailedAt.get(accountId) !== undefined) throw consoleBillingUnavailable();
  try {
    const access = await withDeadline(
      binding.getTenantAccess({ serviceId: BILLING_SERVICE_ID, tenantId: accountId }),
      deadlineMs,
      "reading the account's plan",
    );
    const value = { state: "billed", plan: access.plan, subscription: access.subscription } satisfies GatewayBillingAccess;
    const endsAt = entitlementEndsAt(value);
    if (endsAt !== null && endsAt <= Date.now()) {
      log("error", "billing_expired_entitlement", { account: accountId });
      return { state: "unavailable" };
    }
    return value;
  } catch (error) {
    consoleReadFailedAt.set(accountId, Date.now());
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

/**
 * Whether the account's plan includes `feature` (v1's `planIncludes`).
 * Self-hosted: always. Billing that cannot be read: never, because storing
 * conversations is not something to guess a plan for. A `limits.includes`
 * that is not a list of strings throws `502`: the plan is misconfigured.
 */
export function planIncludes(access: GatewayBillingAccess, feature: PlanFeature): boolean {
  if (access.state === "self_hosted") return true;
  if (access.state === "unavailable" || access.plan === null) return false;
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
 * Turning a feature on needs a plan that includes it. Like any settings write,
 * billing that cannot be read answers 503 rather than guessing.
 */
export async function requirePlanFeature(env: Env, accountId: string, feature: PlanFeature, name: string): Promise<void> {
  const access = requireActiveBilling(await getBillingAccess(env, accountId));
  if (!planIncludes(access, feature)) {
    throw new GatewayError(403, "billing_feature_not_included", `${name} is not included in this account's plan`, undefined, {
      data: { feature },
    });
  }
}

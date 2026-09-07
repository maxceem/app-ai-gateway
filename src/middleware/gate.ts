import type { MiddlewareHandler } from "hono";
import {
  billingBinding,
  billingPlanLimits,
  getBillingAccess,
  requireActiveBilling,
  type BillingVariables,
} from "../billing/gateway";
import { hasAppLevelLimits, hasUserLevelLimits } from "../core/config";
import { GatewayError } from "../core/errors";
import { recordBlockedUsageEvent } from "../core/usage";
import { nextUtcMonthStart } from "../do/OrgQuota";
import type { LimiterCheckResult } from "../do/UserLimiter";
import type { ProxyVariables } from "../routes/proxy";
import type { GatewayVariables } from "./auth";

/**
 * The dispatch boundary.
 *
 * Everything that could still refuse this request has already run: the token was
 * verified, the entitlement checked, the provider row resolved, the path and
 * model validated, the body prepared. The next thing that happens is a call to a
 * provider, so this is the one place where "a request was made" is true, and the
 * only place the organization's monthly allowance is spent.
 *
 * It runs once per incoming gateway request. A named endpoint that falls back
 * across several providers, or an upstream that fails after being dispatched to,
 * has already been counted here and is never counted again.
 *
 * Two independent quotas are spent here, in this order:
 *
 *   1. the app's own limits, which the organization set on its end users, and
 *   2. the organization's plan allowance, which billing sets on the organization.
 *
 * The order is not arbitrary. A request the organization itself refused must
 * not consume the allowance the organization is billed for, so the app's limits
 * are always decided first and the allowance is claimed last.
 */

/**
 * The block flag is read on every proxied request, is almost always `false`,
 * and changes only when an operator acts, so it is cached per isolate rather
 * than fetched from the Durable Object each time. Keys are `app:user` pairs the
 * gateway has already authenticated, but an app with many users still produces
 * many of them, so the map is bounded and evicts insertion-oldest first.
 *
 * The isolate that serves a block clears its own entry
 * ({@link invalidateBlockedCache}); every other isolate converges within the
 * TTL. Token exchange reads `app_user` in D1 and is not affected by this cache.
 */
const blockedCache = new Map<string, { blocked: boolean; expiresAt: number }>();
const BLOCK_CACHE_TTL_MS = 10_000;
const MAX_BLOCK_CACHE_ENTRIES = 50_000;

export function invalidateBlockedCache(appId: string, userId: string): void {
  blockedCache.delete(`${appId}:${userId}`);
}

async function isUserBlocked(env: Env, name: string): Promise<boolean> {
  const cached = blockedCache.get(name);
  if (cached && cached.expiresAt > Date.now()) return cached.blocked;
  const blocked = await env.USER_LIMITER.getByName(name).isBlocked();
  // Re-inserting keeps the map in least-recently-used order.
  blockedCache.delete(name);
  blockedCache.set(name, { blocked, expiresAt: Date.now() + BLOCK_CACHE_TTL_MS });
  if (blockedCache.size > MAX_BLOCK_CACHE_ENTRIES) {
    const oldest = blockedCache.keys().next();
    if (!oldest.done) blockedCache.delete(oldest.value);
  }
  return blocked;
}

async function monthlyRequestAllowance(
  env: Env,
  organizationId: string,
  cache: BillingVariables["billingRequestCache"],
): Promise<number | undefined> {
  // No billing service means self-hosted, which is unlimited and must never
  // depend on a hosted plan lookup that cannot happen.
  if (!billingBinding(env)) return undefined;
  const access = requireActiveBilling(await getBillingAccess(env, organizationId, cache));
  return billingPlanLimits(access).maxRequestsPerMonth;
}

export const quotaGate: MiddlewareHandler<{
  Bindings: Env;
  Variables: GatewayVariables & ProxyVariables & BillingVariables;
}> = async (c, next) => {
  const start = performance.now();
  const app = c.get("appConfig");
  const identity = c.get("identity");

  const blockedEvent = (
    status: "blocked_user" | "blocked_app_rate" | "blocked_app_budget" | "blocked_billing",
    latencyMs: number,
  ) =>
    c.executionCtx.waitUntil(
      recordBlockedUsageEvent({
        env: c.env,
        appId: identity.appId,
        userId: identity.userId,
        authMethod: identity.authMethod,
        apiKeyId: identity.apiKeyId,
        provider: c.get("provider"),
        providerId: c.get("resolvedProvider").id,
        providerSlug: c.get("providerSlug"),
        model: c.get("preparedProxyRequest").model,
        route: `${c.get("providerSlug")}/${c.get("providerPath")}`,
        endpointSlug: c.get("endpointSlug") ?? null,
        appVersion: c.req.header("x-app-version") ?? null,
        status,
        latencyMs: Math.round(latencyMs),
      }),
    );

  const finish = (): number => {
    const durationMs = performance.now() - start;
    c.set("limiterDurationMs", durationMs);
    return durationMs;
  };

  /** Refuses the request the way the app's own limits decided to. */
  const refuseByAppLimits = (
    result: Extract<LimiterCheckResult, { allowed: false }>,
    scope: "user" | "app",
    now: number,
  ): never => {
    const durationMs = finish();
    if (result.reason === "blocked") {
      // The cached flag was up to BLOCK_CACHE_TTL_MS stale and the limiter has
      // since seen the block. Same answer as the cached path, never an app_*
      // code: being blocked is not a limit the organization set.
      blockedEvent("blocked_user", durationMs);
      throw new GatewayError(403, "auth_required", "User is blocked");
    }
    if (result.reason === "budget") {
      // A budget settles from completed requests, so it has no instant of its
      // own to retry after; the month it is measured over is the honest one.
      const retryAfter = Math.max(1, Math.ceil((nextUtcMonthStart(now) - now) / 1000));
      blockedEvent("blocked_app_budget", durationMs);
      throw new GatewayError(
        429,
        "app_budget_exhausted",
        `The application's monthly ${scope} spending budget is exhausted`,
        { "Retry-After": String(retryAfter) },
        { data: { scope } },
      );
    }
    blockedEvent("blocked_app_rate", durationMs);
    throw new GatewayError(
      429,
      "app_rate_limited",
      `The application's ${scope} request rate limit is exceeded`,
      { "Retry-After": String(result.retryAfterSeconds ?? 60) },
      { data: { scope } },
    );
  };

  /*
   * The block flag and the allowance are independent reads, so they are started
   * together rather than one after the other. `allSettled` is what makes that
   * safe: both settle before anything is decided, so the loser of the race is
   * never an unhandled rejection, and the decision order below is fixed
   * regardless of which answered first.
   *
   * Only the allowance *read* overlaps the block check. Claiming it cannot,
   * because it must not happen at all if an app limit refuses first.
   *
   * A self-hosted deployment pays nothing for this: `monthlyRequestAllowance`
   * returns without awaiting anything when there is no billing binding. In a
   * hosted one the entitlement gate has already read billing into the
   * request cache, so this is a cache hit, not a second RPC.
   */
  const [blockedResult, allowanceResult] = await Promise.allSettled([
    isUserBlocked(c.env, `${identity.appId}:${identity.userId}`),
    monthlyRequestAllowance(c.env, app.organizationId, c.get("billingRequestCache")),
  ]);

  if (blockedResult.status === "rejected") throw blockedResult.reason;
  if (blockedResult.value) {
    // First, and unconditionally: the cached flag costs nothing, and answering
    // here is what stops a blocked user from spending an app rate token on
    // every attempt.
    const durationMs = finish();
    blockedEvent("blocked_user", durationMs);
    throw new GatewayError(403, "auth_required", "User is blocked");
  }

  /*
   * The app's own limits. Each scope is consulted only when it is configured,
   * so an app that sets none makes exactly the Durable Object calls it made
   * before the feature existed: the cached block flag, and nothing else.
   *
   * Per-user before per-app, so that one caller over their own limit cannot
   * drain the window every other user shares. The reverse leak is the harmless
   * one: a request the app-wide window refuses has spent one of the caller's
   * own tokens, which costs only the caller already being refused.
   */
  const now = Date.now();
  if (hasUserLevelLimits(app)) {
    const result = await c.env.USER_LIMITER
      .getByName(`${identity.appId}:${identity.userId}`)
      .checkAndIncrement({
        now,
        rpm: app.limits.perUser.requestsPerMinute,
        rpd: app.limits.perUser.requestsPerDay,
        monthlyBudgetMicrousd: app.limits.perUser.monthlyBudgetMicrousd,
      });
    if (!result.allowed) refuseByAppLimits(result, "user", now);
  }
  if (hasAppLevelLimits(app)) {
    const result = await c.env.USER_LIMITER.getByName(identity.appId).checkAndIncrement({
      now,
      rpm: app.limits.perApp.requestsPerMinute,
      rpd: app.limits.perApp.requestsPerDay,
      monthlyBudgetMicrousd: app.limits.perApp.monthlyBudgetMicrousd,
    });
    if (!result.allowed) refuseByAppLimits(result, "app", now);
  }

  // Only now: a blocked user is answered as blocked even while billing is
  // failing, because being blocked is a fact about the user and does not
  // depend on what the organization is allowed to spend.
  if (allowanceResult.status === "rejected") throw allowanceResult.reason;

  const limit = allowanceResult.value;
  if (limit === undefined) {
    // Unlimited: no coordination object is touched at all, so a self-hosted
    // deployment pays nothing for a quota it does not have.
    finish();
    await next();
    return;
  }

  const quota = c.env.ORG_QUOTA.getByName(app.organizationId);
  const admission = await quota.admit({ now: Date.now(), limit });
  const durationMs = finish();
  if (!admission.allowed) {
    blockedEvent("blocked_billing", durationMs);
    throw new GatewayError(
      429,
      "billing_request_quota_exceeded",
      `The organization's monthly request allowance of ${admission.limit} is exhausted until ${admission.resetAt}`,
      { "Retry-After": String(admission.retryAfterSeconds) },
      {
        data: {
          limit: admission.limit,
          used: admission.used,
          resetAt: admission.resetAt,
        },
      },
    );
  }
  await next();
};

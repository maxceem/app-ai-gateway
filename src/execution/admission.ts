import { requireActiveBilling, type BillingRequestCache } from "../billing/gateway";
import { billingQuota } from "../billing/quota";
import {
  budgetScope,
  hasAppLevelLimits,
  hasUserLevelLimits,
  monthlyBudgetMicrousd,
} from "../shared/app-config";
import { GatewayError } from "../core/errors";
import { cachedAppUserBlocked } from "../client-auth/user-status";
import { recordRejectionEvent } from "../diagnostics/rejection-events";
import { nextUtcMonthStart } from "../core/time";
import type { LimiterCheckInput, LimiterCheckResult } from "../do/UserLimiter";
import type { SpendKey } from "../usage/app-usage-accounting";
import type { AppRecord, GatewayIdentity } from "../core/types";
import type { RejectionReason, RejectionScope } from "../shared/rejection-reasons";
import { attemptAttribution, type ExecutionPlan } from "./plan";
import type { Deployment } from "../policy/deployment";

/**
 * The dispatch boundary.
 *
 * Everything that could still refuse this request has already run: the token was
 * verified, the entitlement checked, the provider row resolved, the path and
 * model validated, the body prepared. The next thing that happens is a call to a
 * provider, so this is the one place where "a request was made" is true, and the
 * only place the organization's monthly allowance is spent.
 *
 * It runs once per incoming gateway request. A custom endpoint that falls back
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
 *
 * What this costs. Both quotas live in single Durable Objects — one per
 * install of an App Attest application or per `app:user` pair of a server
 * application, and one per app for the app's own limits, one per
 * organization for the plan allowance — and a request that is subject to all
 * of them calls them one after another, because each is allowed to refuse
 * before the next is spent. Those objects sit wherever they were created, so a
 * request served far from them pays a round trip to each, in series, before it
 * reaches the provider. That is accepted rather than optimised away. The
 * target is many small applications, where the objects are barely contended
 * and the trips are what makes a limit a limit: an exact count, a refusal that
 * takes effect on the next request everywhere, and a `used` figure the console
 * can show as fact. The alternative would be to lease a small batch of
 * admissions from {@link import("../do/OrgQuota").OrgQuota} into each isolate
 * and spend them locally, amortising the trip over the batch — but `used` and
 * the refusal boundary would both become approximate, an overshoot would be
 * charged to somebody's plan, and every admission an evicted isolate still
 * held would be lost. None of that is worth the latency to an organization
 * whose allowance is monthly.
 */

/** What admitting one prepared request needs to know, and where to leave its diagnostics. */
export interface AdmissionInput {
  env: Env;
  deployment: Deployment;
  billingCache: BillingRequestCache;
  app: AppRecord;
  identity: GatewayIdentity;
  /**
   * The counter of the App Attest assertion the request was signed with,
   * which the install's limiter accepts once and refuses as a replay after.
   * Null where nothing was signed: a server application, or an App Attest one
   * whose `verify_on` is `token_exchange`.
   */
  assertionCounter: number | null;
  plan: ExecutionPlan;
  appVersion: string | null;
  waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * The per-caller limiter a request is counted by, and what it is asked.
 *
 * An App Attest request is counted per install — the key its token names —
 * and its object is called on every signed request, because it also owns the
 * install's assertion counter; an application that verifies App Attest on the
 * token exchange signs nothing per request, so its object is called only
 * where limits exist. Its budget is the install's month by default,
 * or the user's when the application says so. A server application's request
 * is counted per user, and only where per-user limits exist, as before
 * installs did.
 */
export function callerLimiter(
  app: AppRecord,
  identity: GatewayIdentity,
  assertionCounter: number | null,
): { name: string; scope: "install" | "user"; spend: SpendKey & { scope: "install" | "user" } } | null {
  const config = app.config;
  const { appId, userId } = identity;
  // An attest identity is an App Attest application's — client
  // authentication refuses a token minted by the other exchange — and always
  // names its install.
  if (identity.authMethod === "attest") {
    if (assertionCounter === null && !hasUserLevelLimits(config)) return null;
    return {
      name: `${appId}:install:${identity.installId}`,
      scope: "install",
      // An App Attest identity always names somebody, so `user` has a key.
      spend: budgetScope(config) === "user" && userId !== null
        ? { appId, scope: "user", key: userId }
        : { appId, scope: "install", key: identity.installId },
    };
  }
  // `identity.userId` is non-null whenever per-user limits exist: configuring
  // them on an application that identifies no end users is refused when the
  // configuration is parsed, so this is a narrowing, not a second policy.
  if (!hasUserLevelLimits(config) || userId === null) return null;
  return { name: `${appId}:${userId}`, scope: "user", spend: { appId, scope: "user", key: userId } };
}

/**
 * Admits one prepared request, or refuses it. Resolves with how long the
 * limiters took, which the response reports as `server-timing`; a refusal
 * throws, and `onDuration` has reported the same figure by then.
 */
export async function admitRequest(
  input: AdmissionInput,
  onDuration: (durationMs: number) => void = () => {},
): Promise<number> {
  const start = performance.now();
  const { env, app, identity, plan } = input;
  const firstAttempt = plan.attempts[0];

  const blockedEvent = (
    reason: RejectionReason,
    scope: RejectionScope,
    latencyMs: number,
  ) =>
    input.waitUntil(
      recordRejectionEvent({
        env,
        identity,
        attribution: attemptAttribution(firstAttempt),
        endpointSlug: plan.endpointSlug,
        appVersion: input.appVersion,
        reason,
        scope,
        latencyMs: Math.round(latencyMs),
      }),
    );

  const finish = (): number => {
    const durationMs = performance.now() - start;
    onDuration(durationMs);
    return durationMs;
  };

  /** Refuses the request the way the app's own limits decided to. */
  const refuseByAppLimits = (
    result: Extract<LimiterCheckResult, { allowed: false }>,
    scope: "user" | "install" | "app",
    now: number,
  ): never => {
    const durationMs = finish();
    if (result.reason === "replay") {
      blockedEvent("blocked_replay", "install", durationMs);
      throw new GatewayError(403, "attest_failed", "App Attest assertion counter was replayed");
    }
    if (result.reason === "budget") {
      // A budget settles from completed requests, so it has no instant of its
      // own to retry after; the month it is measured over is the honest one.
      const retryAfter = Math.max(1, Math.ceil((nextUtcMonthStart(now) - now) / 1000));
      blockedEvent("blocked_app_budget", scope, durationMs);
      throw new GatewayError(
        429,
        "app_budget_exhausted",
        `The application's monthly ${scope} spending budget is exhausted`,
        { "Retry-After": String(retryAfter) },
        { data: { scope } },
      );
    }
    blockedEvent("blocked_app_rate", scope, durationMs);
    throw new GatewayError(
      429,
      "app_rate_limited",
      `The application's ${scope} request rate limit is exceeded`,
      { "Retry-After": String(result.retryAfterSeconds ?? 60) },
      { data: { scope } },
    );
  };

  /*
   * The D1 block status and the allowance are independent reads, so they are started
   * together rather than one after the other. `allSettled` is what makes that
   * safe: both settle before anything is decided, so the loser of the race is
   * never an unhandled rejection, and the decision order below is fixed
   * regardless of which answered first.
   *
   * Only the allowance *read* overlaps the block check. Claiming it cannot,
   * because it must not happen at all if an app limit refuses first.
   *
   * A self-hosted deployment pays nothing for this: `billingQuota` answers
   * `unmetered` without reading anything when there is no billing binding. In a
   * hosted one a warm isolate answers the plan out of its own TTL cache, so
   * this is not an RPC per request either.
   */
  const [blockedResult, allowanceResult] = await Promise.allSettled([
    // A userless request has no identified person whose status to read.
    identity.userId === null
      ? Promise.resolve(false)
      : cachedAppUserBlocked(env.DB, identity.appId, identity.userId),
    billingQuota(input.deployment, env, app.organizationId, input.billingCache),
  ]);

  if (blockedResult.status === "rejected") throw blockedResult.reason;
  if (blockedResult.value) {
    // Before any limit is consulted, so a blocked user spends no app token.
    const durationMs = finish();
    blockedEvent("blocked_user", "user", durationMs);
    throw new GatewayError(403, "auth_required", "User is blocked");
  }

  /*
   * The app's own limits. Each scope is consulted only when it is configured,
   * so an app that sets none makes no limiter Durable Object calls. Its user
   * status is still read from the bounded D1 cache above.
   *
   * Per-user before per-app, so that one caller over their own limit cannot
   * drain the window every other user shares. The reverse leak is the harmless
   * one: a request the app-wide window refuses has spent one of the caller's
   * own tokens, which costs only the caller already being refused.
   */
  const now = Date.now();
  const caller = callerLimiter(app, identity, input.assertionCounter);
  if (caller !== null) {
    const perUser = app.config.limits.per_user;
    const check: LimiterCheckInput = {
      now,
      rpm: perUser.requests.per_minute,
      rpd: perUser.requests.per_day,
      monthlyBudgetMicrousd: monthlyBudgetMicrousd(perUser),
      spend: caller.spend,
      ...(input.assertionCounter === null ? {} : { assertionCounter: input.assertionCounter }),
    };
    const result = await env.USER_LIMITER.getByName(caller.name).checkAndIncrement(check);
    if (!result.allowed) {
      // A request limit refuses for the caller the limiter counts; a budget
      // for whoever's month it is measured over.
      refuseByAppLimits(result, result.reason === "budget" ? caller.spend.scope : caller.scope, now);
    }
  }
  if (hasAppLevelLimits(app.config)) {
    const result = await env.USER_LIMITER.getByName(identity.appId).checkAndIncrement({
      now,
      rpm: app.config.limits.per_app.requests.per_minute,
      rpd: app.config.limits.per_app.requests.per_day,
      monthlyBudgetMicrousd: monthlyBudgetMicrousd(app.config.limits.per_app),
      spend: { appId: identity.appId, scope: "app", key: null },
    });
    if (!result.allowed) refuseByAppLimits(result, "app", now);
  }

  // Only now: a blocked user is answered as blocked even while billing is
  // failing, because being blocked is a fact about the user and does not
  // depend on what the organization is allowed to spend.
  if (allowanceResult.status === "rejected") throw allowanceResult.reason;

  const quota = allowanceResult.value;
  // Billing that cannot be read, or an organization no plan resolves for, is
  // refused here rather than served uncounted.
  requireActiveBilling(quota.access);
  // Self-hosted, or a plan with no monthly limit: no coordination object is
  // touched at all, so neither pays for a count nothing enforces.
  if (quota.kind === "unmetered") return finish();

  const { period } = quota;
  const admission = await env.ORG_QUOTA.getByName(app.organizationId).admit({
    periodId: period.periodId,
    periodEnd: period.periodEnd,
    limit: quota.limit,
  });
  const durationMs = finish();
  if (!admission.allowed) {
    blockedEvent("blocked_billing", "account", durationMs);
    throw new GatewayError(
      429,
      "billing_request_quota_exceeded",
      `The plan's monthly request allowance of ${admission.limit} is exhausted until ${period.resetAt}`,
      { "Retry-After": String(admission.retryAfterSeconds) },
      {
        data: {
          limit: admission.limit,
          used: admission.used,
          periodId: period.periodId,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          resetAt: period.resetAt,
        },
      },
    );
  }
  return durationMs;
}

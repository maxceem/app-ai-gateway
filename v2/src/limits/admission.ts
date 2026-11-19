/**
 * Admission for one provider request (plan section 4.2, "Admission"): the
 * three limiter objects, called one after another, each only when it has
 * something to check.
 *
 * 1. The end user's limiter: the App Attest replay check and the user's
 *    limits (`EndUserLimiter`).
 * 2. The app's limiter: the app's own limits (`AppLimiter`).
 * 3. The account's limiter: the plan allowance, hosted only, always last
 *    (`AccountLimiter`).
 *
 * The order means a request the customer's own limits refuse never uses the
 * plan allowance it pays for.
 *
 * Deadlines and the timeout rules, in one place:
 *
 * - The replay check has its own deadline. If the end user's limiter does not
 *   answer it, the request is refused (503): it is never served unchecked.
 * - Every other check shares one `LIMITS_DEADLINE_MS` deadline that starts
 *   after the replay check, so a slow replay check never makes the budget
 *   checks skip, and three slow limiters never cost three deadlines. A slow
 *   answer counts as no answer, and a limiter whose turn comes after the
 *   deadline is skipped the same way.
 * - A limit, budget or allowance that does not answer is skipped and the
 *   request is served, logged as a warning (`AGENTS.md`).
 */
import { configuredBudgetScope, scopeHasLimits, type BudgetScope } from "../contracts/app-config.ts";
import { admitAllowance } from "../billing/allowance.ts";
import { admitAppTraffic, getAppTrafficBillingAccess, APP_TRAFFIC_BILLING_DEADLINE_MS } from "../billing/access.ts";
import { billingBinding } from "../billing/contract.ts";
import { billingQuotaFor } from "../billing/quota.ts";
import { installLimiterName, REPLAY_CHECK_DEADLINE_MS } from "../client-auth/replay.ts";
import type { GatewayBillingAccess } from "../contracts/billing.ts";
import { errorFacts } from "../core/error-facts.ts";
import { GatewayError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { serviceUnavailable } from "../core/platform-errors.ts";
import type { AppRecord, GatewayIdentity } from "../core/types.ts";
import type { RequestLimitResult } from "../do/request-limits.ts";
import { nextUtcMonthStart, type SpendKey } from "./spend.ts";

/** The deadline the checks after the replay check share. */
export const LIMITS_DEADLINE_MS = 2_000;

/** Marks a refusal with the rejection event it records. */
export type RefusalMarker = (error: GatewayError, reason: string, scope: string | null) => GatewayError;

export interface AdmissionInput {
  env: Env;
  app: AppRecord;
  identity: GatewayIdentity;
  /** The App Attest assertion counter the request was signed with, or null. */
  assertionCounter: number | null;
  waitUntil: (promise: Promise<unknown>) => void;
  refuse: RefusalMarker;
  /** For tests. */
  replayDeadlineMs?: number;
  limitsDeadlineMs?: number;
  billingDeadlineMs?: number;
}

/** The end user's limiter object a request is counted by, if any. */
export interface EndUserCaller {
  name: string;
  /** Who the request windows count. */
  scope: "install" | "user";
  /** Whose month the budget is measured over. */
  spend: SpendKey & { scope: BudgetScope };
}

/**
 * The end user's limiter and budget month (v1's `callerLimiter` and
 * `attestLedger`): per install on an App Attest app, per user on a server app.
 * An install whose token names no Apple Account is measured over its own month
 * under `apple_account`, as v1, so an older client is never worse off.
 */
export function endUserCaller(app: AppRecord, identity: GatewayIdentity): EndUserCaller | null {
  if (identity.authMethod === "attest") {
    const scope = configuredBudgetScope(app.authentication, app.limits);
    let spend: SpendKey & { scope: BudgetScope } = { appId: app.id, scope: "install", key: identity.installId };
    if (scope === "user" && identity.userId !== null) spend = { appId: app.id, scope: "user", key: identity.userId };
    if (scope === "apple_account" && identity.appleAccountId !== null) {
      spend = { appId: app.id, scope: "apple_account", key: identity.appleAccountId };
    }
    return { name: installLimiterName(app.id, identity.installId), scope: "install", spend };
  }
  if (identity.userId === null) return null;
  return {
    name: userLimiterName(app.id, identity.userId),
    scope: "user",
    spend: { appId: app.id, scope: "user", key: identity.userId },
  };
}

/** The limiter object of one server app's user. */
export function userLimiterName(appId: string, userId: string): string {
  return `${appId}:user:${userId}`;
}

/** An RPC call's result, typed as the object method returns it (stub types are not). */
function rpc<T>(call: unknown): Promise<T> {
  return Promise.resolve(call) as Promise<T>;
}

type Timed<T> = { kind: "answer"; value: T } | { kind: "late" } | { kind: "failed"; error: unknown };

const LATE = { kind: "late" } as const;

/** Waits for `promise` until `ms` from now. A late call keeps running in the background. */
async function within<T>(promise: Promise<T>, ms: number, waitUntil: (p: Promise<unknown>) => void): Promise<Timed<T>> {
  if (ms <= 0) {
    waitUntil(promise.catch(() => undefined));
    return { kind: "late" };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ms);
  });
  try {
    const answer = await Promise.race([promise.then((value) => ({ value })), late]);
    if (answer === "late") {
      waitUntil(promise.catch(() => undefined));
      return { kind: "late" };
    }
    return { kind: "answer", value: answer.value };
  } catch (error) {
    return { kind: "failed", error };
  } finally {
    clearTimeout(timer);
  }
}

/** Admits one provider request, or throws the refusal. */
export async function admitRequest(input: AdmissionInput): Promise<void> {
  const { env, app, identity, refuse } = input;
  const replayDeadlineMs = input.replayDeadlineMs ?? REPLAY_CHECK_DEADLINE_MS;
  const limitsDeadlineMs = input.limitsDeadlineMs ?? LIMITS_DEADLINE_MS;
  const now = Date.now();

  // The plan is read while the app's own limits are checked. Reading it spends
  // nothing; only the account limiter's admission does, and that comes last.
  const billingAccess: Promise<GatewayBillingAccess> | null =
    billingBinding(env) === null
      ? null
      : getAppTrafficBillingAccess(env, app.accountId, input.waitUntil, input.billingDeadlineMs ?? APP_TRAFFIC_BILLING_DEADLINE_MS);

  const perUser = app.limits.per_user;
  const userLimits = {
    now,
    rpm: perUser.requests.per_minute,
    rpd: perUser.requests.per_day,
    budgetNano: perUser.spending.monthly_nano,
  };
  const caller = endUserCaller(app, identity);
  const userHasLimits = scopeHasLimits(perUser);

  // 1a. The replay check, with the user's limits in the same call. Never skipped.
  if (caller !== null && input.assertionCounter !== null) {
    const pending = rpc<RequestLimitResult | { allowed: false; reason: "replay" }>(env.END_USER_LIMITER.getByName(caller.name).check({
      ...(userHasLimits ? userLimits : { now, rpm: null, rpd: null, budgetNano: null }),
      spend: caller.spend,
      assertionCounter: input.assertionCounter,
    }));
    const answer = await within(pending, replayDeadlineMs, input.waitUntil);
    if (answer.kind === "failed") {
      log("error", "replay_check_failed", { app: app.id, error: errorFacts(answer.error) });
      throw serviceUnavailable("platform_unavailable", "The gateway could not check this request; retry shortly", answer.error);
    }
    if (answer.kind === "late") {
      log("error", "replay_check_slow", { app: app.id, deadlineMs: replayDeadlineMs });
      throw serviceUnavailable("deadline_exceeded", "The gateway could not check this request in time; retry shortly");
    }
    if (!answer.value.allowed && answer.value.reason === "replay") {
      throw refuse(new GatewayError(403, "attest_failed", "App Attest assertion counter was replayed"), "blocked_replay", "install");
    }
    settleAppLimit(answer.value, caller, now, refuse, app.id);
  }

  // From here on, one shared deadline.
  const deadlineAt = Date.now() + limitsDeadlineMs;
  const remaining = () => deadlineAt - Date.now();

  // 1b. The user's limits, when there was no replay check to carry them.
  if (caller !== null && input.assertionCounter === null && userHasLimits) {
    const answer = remaining() <= 0 ? LATE : await within(
      rpc<RequestLimitResult>(env.END_USER_LIMITER.getByName(caller.name).check({ ...userLimits, spend: caller.spend })),
      remaining(),
      input.waitUntil,
    );
    if (answer.kind === "answer") settleAppLimit(answer.value, caller, now, refuse, app.id);
    else unchecked(app.id, caller.scope, answer);
  }

  // 2. The app's own limits.
  if (scopeHasLimits(app.limits.per_app)) {
    const perApp = app.limits.per_app;
    // A limiter whose turn comes after the deadline is skipped, not called.
    const answer = remaining() <= 0 ? LATE : await within(
      rpc<RequestLimitResult>(
        env.APP_LIMITER.getByName(app.id).checkRequest({
          now,
          rpm: perApp.requests.per_minute,
          rpd: perApp.requests.per_day,
          budgetNano: perApp.spending.monthly_nano,
          spend: { appId: app.id, scope: "app", key: app.id },
        }),
      ),
      remaining(),
      input.waitUntil,
    );
    if (answer.kind === "answer") settleAppLimit(answer.value, null, now, refuse, app.id);
    else unchecked(app.id, "app", answer);
  }

  // 3. The plan allowance, hosted only, always last.
  if (billingAccess !== null) await admitPlanAllowance(input, billingAccess, remaining);
}

/** Refuses as the app's own limits decided, or notes a budget that could not be read. */
function settleAppLimit(
  result: RequestLimitResult,
  caller: EndUserCaller | null,
  now: number,
  refuse: RefusalMarker,
  appId: string,
): void {
  if (result.allowed) {
    if (result.budget === "unread") log("warn", "app_budget_unchecked", { app: appId, scope: caller?.spend.scope ?? "app" });
    return;
  }
  if (result.reason === "budget") {
    // A budget settles from finished requests, so its honest retry time is the month's end.
    const scope = caller?.spend.scope ?? "app";
    const retryAfter = Math.max(1, Math.ceil((nextUtcMonthStart(now) - now) / 1000));
    throw refuse(
      new GatewayError(
        429,
        "app_budget_exhausted",
        `The app's monthly ${scope === "apple_account" ? "Apple Account" : scope} spending budget is exhausted`,
        { "Retry-After": String(retryAfter) },
        { data: { scope } },
      ),
      "blocked_app_budget",
      scope,
    );
  }
  const scope = caller?.scope ?? "app";
  throw refuse(
    new GatewayError(
      429,
      "app_rate_limited",
      `The app's ${scope} request rate limit is exceeded`,
      { "Retry-After": String(result.retryAfterSeconds ?? 60) },
      { data: { scope } },
    ),
    "blocked_app_rate",
    scope,
  );
}

function unchecked(appId: string, scope: string, answer: { kind: "late" } | { kind: "failed"; error: unknown }): void {
  log("warn", "app_limits_unchecked", {
    app: appId,
    scope,
    reason: answer.kind === "late" ? "deadline" : "failed",
    ...(answer.kind === "failed" ? { error: errorFacts(answer.error) } : {}),
  });
}

/** The plan allowance: counted in the account's limiter, never failing the request. */
async function admitPlanAllowance(
  input: AdmissionInput,
  billingAccess: Promise<GatewayBillingAccess>,
  remaining: () => number,
): Promise<void> {
  const { env, app, refuse } = input;
  if (remaining() <= 0) {
    input.waitUntil(billingAccess.catch(() => undefined));
    log("warn", "allowance_uncounted", { account: app.accountId, reason: "deadline" });
    return;
  }
  const accessAnswer = await within(billingAccess, remaining(), input.waitUntil);
  if (accessAnswer.kind !== "answer") {
    log("warn", "allowance_uncounted", { account: app.accountId, reason: accessAnswer.kind === "late" ? "deadline" : "fault" });
    return;
  }
  const access = accessAnswer.value;
  // No plan resolving at all is still 402, as v1. Billing that cannot be read is served.
  admitAppTraffic(access, app.accountId);
  let quota;
  try {
    quota = await billingQuotaFor(access, env, app.accountId);
  } catch (error) {
    // Plan data this gateway cannot turn into a period is our problem, not the app's.
    log("warn", "allowance_uncounted", { account: app.accountId, reason: "plan_unreadable", error: errorFacts(error) });
    return;
  }
  if (quota.kind === "unmetered") return;
  const { period } = quota;
  if (remaining() <= 0) {
    log("warn", "allowance_uncounted", { account: app.accountId, reason: "deadline" });
    return;
  }
  const outcome = await admitAllowance(
    env.ACCOUNT_LIMITER.getByName(app.accountId),
    app.accountId,
    { periodId: period.periodId, periodEnd: period.periodEnd, limit: quota.limit },
    input.waitUntil,
    remaining(),
  );
  if (outcome.kind === "uncounted") return;
  const refusal = outcome.kind === "exhausted" ? outcome : outcome.admission;
  if (refusal.allowed) return;
  throw refuse(
    new GatewayError(
      429,
      "billing_request_quota_exceeded",
      `The plan's monthly request allowance of ${refusal.limit} is used up until ${period.resetAt}`,
      { "Retry-After": String(refusal.retryAfterSeconds) },
      {
        data: {
          limit: refusal.limit,
          used: refusal.used,
          periodId: period.periodId,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          resetAt: period.resetAt,
        },
      },
    ),
    "blocked_billing",
    "account",
  );
}

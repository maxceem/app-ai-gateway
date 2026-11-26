/**
 * Admission for a live session (plan D15 and section 6;
 * `v2-prep/admission-and-settlement.md`): the end user's limiter, then the
 * app's, each checking its budget and taking a slot in one call, then, hosted
 * only, the plan's live-session minutes (D17, admission T12). Opening a
 * session uses no request (D8): a session counts its minutes at its
 * checkpoints, so the start only reads what the period used, and refuses only
 * when that is known to be used up.
 *
 * As for every request, both checks share one `LIMITS_DEADLINE_MS` deadline,
 * and a limiter that does not answer in time is skipped: the session starts
 * without that check, and no slot is taken there (T13). A refusal is always
 * one of the deliberate reasons `AGENTS.md` names: the user's or the app's
 * own limit or budget.
 *
 * The leases follow the session: `open` activates them, `close` frees them
 * (`activateSessionLeases`, `releaseSessionLeases`), each safe to repeat by
 * session id and never failing the call when a limiter cannot be reached.
 */
import { appSessionCap } from "../contracts/app-config.ts";
import { admitAppTraffic, APP_TRAFFIC_BILLING_DEADLINE_MS, getAppTrafficBillingAccess } from "../billing/access.ts";
import { billingBinding } from "../billing/contract.ts";
import { sessionQuotaFor } from "../billing/quota.ts";
import { errorFacts } from "../core/error-facts.ts";
import { GatewayError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import type { AppRecord, GatewayIdentity } from "../core/types.ts";
import type { AppSessionAdmission } from "../do/AppLimiter.ts";
import type { SessionCheckpointAnswer, SessionCheckpointInput, UserSessionAdmission } from "../do/EndUserLimiter.ts";
import type { SlotClaim } from "../do/session-slots.ts";
import { installLimiterName } from "../client-auth/replay.ts";
import { endUserCaller, LIMITS_DEADLINE_MS, userLimiterName, type RefusalMarker } from "./admission.ts";

/** How long `open` and `close` wait for a limiter before going on without it. */
export const LEASE_DEADLINE_MS = 1_000;

export interface SessionAdmissionInput {
  readonly env: Env;
  readonly app: AppRecord;
  readonly identity: GatewayIdentity;
  readonly claim: SlotClaim;
  /** The session the app names to take over, or null. */
  readonly takesOver: string | null;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly refuse: RefusalMarker;
  /** For tests. */
  readonly limitsDeadlineMs?: number;
  readonly billingDeadlineMs?: number;
}

/** What admission took: the slots to free if the start goes no further. */
export interface SessionAdmission {
  /** The end user's limiter that holds a slot, or null when none was taken there. */
  readonly userLimiter: string | null;
  /** Whether the app's limiter holds a seat. */
  readonly appSeat: boolean;
}

/** An RPC call's result, typed as the object method returns it. */
function rpc<T>(call: unknown): Promise<T> {
  return Promise.resolve(call) as Promise<T>;
}

/** `promise`'s answer, or null when it fails or is later than `ms`. A late call keeps running in the background. */
async function within<T>(promise: Promise<T>, ms: number, waitUntil: (p: Promise<unknown>) => void): Promise<{ value: T } | { missed: "deadline" | "failed"; error?: unknown }> {
  if (ms <= 0) {
    waitUntil(promise.catch(() => undefined));
    return { missed: "deadline" };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ms);
  });
  try {
    const answer = await Promise.race([promise.then((value) => ({ value })), late]);
    if (answer === "late") {
      waitUntil(promise.catch(() => undefined));
      return { missed: "deadline" };
    }
    return answer;
  } catch (error) {
    return { missed: "failed", error };
  } finally {
    clearTimeout(timer);
  }
}

/** The end user's limiter a session's slot lives in, by the ticket's names: per install on an App Attest app, else per user. */
export function sessionLimiterName(appId: string, installId: string | null, endUserId: string | null): string | null {
  if (installId !== null) return installLimiterName(appId, installId);
  if (endUserId !== null) return userLimiterName(appId, endUserId);
  return null;
}

/** Admits one live session, or throws the refusal. Throws nothing when a limiter cannot be reached. */
export async function admitSession(input: SessionAdmissionInput): Promise<SessionAdmission> {
  const { env, app, identity, claim, refuse } = input;
  const now = Date.now();
  const deadlineAt = now + (input.limitsDeadlineMs ?? LIMITS_DEADLINE_MS);
  const remaining = () => deadlineAt - Date.now();
  const caller = endUserCaller(app, identity);
  let userLimiter: string | null = null;

  // 1. The end user: the user's budget, a streaming slot, the bound of 4 (T3, T14).
  if (caller !== null) {
    const answer = await within(
      rpc<UserSessionAdmission>(
        env.END_USER_LIMITER.getByName(caller.name).admitSession({
          ...claim,
          now,
          budgetNano: app.limits.per_user.spending.monthly_nano,
          spend: caller.spend,
          takesOver: input.takesOver,
        }),
      ),
      remaining(),
      input.waitUntil,
    );
    if ("value" in answer) {
      const verdict = answer.value;
      if (!verdict.admitted) throw userRefusal(verdict.reason, caller.spend.scope, refuse);
      userLimiter = caller.name;
      if (verdict.budget === "unread") log("warn", "app_budget_unchecked", { app: app.id, scope: caller.spend.scope });
    } else {
      unchecked(app.id, caller.scope, answer);
    }
  }

  // 2. The app: its budget and its cap for this kind of session (T3). At a
  // full app the customer is told in the console (a rejection event), and it
  // is logged.
  const answer = await within(
    rpc<AppSessionAdmission>(
      env.APP_LIMITER.getByName(app.id).admitSession({
        ...claim,
        now,
        budgetNano: app.limits.per_app.spending.monthly_nano,
        spend: { accountId: app.accountId, appId: app.id, scope: "app", key: app.id },
        cap: appSessionCap(app.limits, claim.kind),
      }),
    ),
    remaining(),
    input.waitUntil,
  );
  let appSeat = false;
  if ("value" in answer) {
    const verdict = answer.value;
    if (!verdict.admitted) {
      // The user's slot is freed at once, so a refused start never holds one.
      if (userLimiter !== null) input.waitUntil(releaseUserSlot(env, userLimiter, claim.sessionId));
      if (verdict.reason === "session_limit") {
        log("warn", "app_session_limit_reached", { app: app.id, kind: claim.kind, cap: verdict.cap ?? null });
        throw refuse(
          new GatewayError(429, "session_limit", `The app has the most ${claim.kind} sessions it allows open at once`, { "Retry-After": "30" }, { data: { scope: "app", kind: claim.kind } }),
          "blocked_session_limit",
          "app",
        );
      }
      throw budgetRefusal("app", refuse);
    }
    if (verdict.budget === "unread") log("warn", "app_budget_unchecked", { app: app.id, scope: "app" });
    appSeat = true;
  } else {
    unchecked(app.id, "app", answer);
  }
  const admission = { userLimiter, appSeat };

  // 3. The plan's live-session minutes, hosted only, always last.
  try {
    await checkSessionMinutes(input, remaining, now);
  } catch (error) {
    // A refused start never holds a slot.
    input.waitUntil(releaseAdmission(env, app.id, claim.sessionId, admission));
    throw error;
  }
  return admission;
}

/**
 * Refuses when the plan's live-session minutes are known to be used up this
 * period, as the proxy refuses a used-up request allowance. Anything it cannot
 * read in time lets the session start, logged (AGENTS.md "Serving requests").
 * It reads billing (`billing_*`) only, never the app's own limits.
 */
async function checkSessionMinutes(input: SessionAdmissionInput, remaining: () => number, now: number): Promise<void> {
  const { env, app, refuse } = input;
  if (billingBinding(env) === null) return;
  const skip = (reason: string, error?: unknown) =>
    log("warn", "session_allowance_unchecked", { account: app.accountId, reason, ...(error === undefined ? {} : { error: errorFacts(error) }) });
  const accessAnswer = await within(
    getAppTrafficBillingAccess(env, app.accountId, input.waitUntil, input.billingDeadlineMs ?? APP_TRAFFIC_BILLING_DEADLINE_MS),
    remaining(),
    input.waitUntil,
  );
  if (!("value" in accessAnswer)) return skip(accessAnswer.missed, accessAnswer.error);
  const access = accessAnswer.value;
  // The last known plan, served while billing cannot answer, is never grounds to refuse.
  if (access.state === "billed" && access.stale === true) return skip("billing_stale");
  // No plan resolving at all is 402, as for a request.
  admitAppTraffic(access, app.accountId);
  const quotaAnswer = await within(sessionQuotaFor(access, env, app.accountId, now), remaining(), input.waitUntil);
  if (!("value" in quotaAnswer)) return skip(quotaAnswer.missed === "deadline" ? "deadline" : "plan_unreadable", quotaAnswer.error);
  const quota = quotaAnswer.value;
  if (quota.kind === "unmetered") return;
  const { period } = quota;
  const usedAnswer = await within(
    rpc<number | null>(
      env.ACCOUNT_LIMITER.getByName(app.accountId).sessionMs({
        accountId: app.accountId,
        fromDay: period.periodStart.slice(0, 10),
        toDay: period.periodEnd.slice(0, 10),
        now,
      }),
    ),
    remaining(),
    input.waitUntil,
  );
  if (!("value" in usedAnswer)) return skip(usedAnswer.missed, usedAnswer.error);
  const used = usedAnswer.value;
  if (used === null) return skip("minutes_unread");
  if (used < quota.limitMs) return;
  const retryAfter = Math.max(1, Math.ceil((Date.parse(period.resetAt) - now) / 1000));
  throw refuse(
    new GatewayError(
      429,
      "billing_request_quota_exceeded",
      `The plan's monthly live-session minutes are used up until ${period.resetAt}`,
      { "Retry-After": String(retryAfter) },
      {
        data: {
          limit: Math.floor(quota.limitMs / 60_000),
          used: Math.floor(used / 60_000),
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

function userRefusal(reason: "budget" | "streaming_limit" | "starting_bound", scope: string, refuse: RefusalMarker): GatewayError {
  if (reason === "budget") return budgetRefusal(scope, refuse);
  if (reason === "streaming_limit") {
    return refuse(
      new GatewayError(429, "session_limit", "This user has the most streaming sessions allowed open at once", { "Retry-After": "30" }, { data: { scope: "user", kind: "streaming" } }),
      "blocked_session_limit",
      "user",
    );
  }
  return refuse(
    new GatewayError(429, "session_limit", "This user has too many sessions starting or running", { "Retry-After": "30" }, { data: { scope: "user", kind: "conversational" } }),
    "blocked_session_limit",
    "user",
  );
}

function budgetRefusal(scope: string, refuse: RefusalMarker): GatewayError {
  return refuse(
    new GatewayError(429, "app_budget_exhausted", `The app's monthly ${scope === "apple_account" ? "Apple Account" : scope} spending budget is exhausted`, {}, { data: { scope } }),
    "blocked_app_budget",
    scope,
  );
}

function unchecked(appId: string, scope: string, answer: { missed: "deadline" | "failed"; error?: unknown }): void {
  log("warn", "session_limits_unchecked", {
    app: appId,
    scope,
    reason: answer.missed,
    ...(answer.missed === "failed" ? { error: errorFacts(answer.error) } : {}),
  });
}

async function releaseUserSlot(env: Env, limiter: string, sessionId: string): Promise<void> {
  try {
    await rpc<void>(env.END_USER_LIMITER.getByName(limiter).releaseSession(sessionId));
  } catch (error) {
    log("warn", "session_lease_release_failed", { scope: "user", error: errorFacts(error) });
  }
}

/** Frees what admission took, when the start goes no further (the ticket could not be made). */
export function releaseAdmission(env: Env, appId: string, sessionId: string, admission: SessionAdmission): Promise<unknown> {
  return Promise.all([
    admission.userLimiter === null ? null : releaseUserSlot(env, admission.userLimiter, sessionId),
    admission.appSeat ? releaseAppSeat(env, appId, sessionId) : null,
  ]);
}

async function releaseAppSeat(env: Env, appId: string, sessionId: string): Promise<void> {
  try {
    await rpc<void>(env.APP_LIMITER.getByName(appId).releaseSession(sessionId));
  } catch (error) {
    log("warn", "session_lease_release_failed", { scope: "app", error: errorFacts(error) });
  }
}

/** Where a session's leases live, from its ticket. */
export interface LeaseOwner {
  readonly appId: string;
  readonly installId: string | null;
  readonly endUserId: string | null;
}

/**
 * `open` succeeded: both leases become `active` (T4). Never fails: a limiter
 * that cannot be reached is logged and skipped (crash table row 7).
 */
export async function activateSessionLeases(env: Env, owner: LeaseOwner, claim: SlotClaim, now: number, waitUntil?: (p: Promise<unknown>) => void): Promise<void> {
  const keep = waitUntil ?? ((promise: Promise<unknown>) => void promise);
  const limiter = sessionLimiterName(owner.appId, owner.installId, owner.endUserId);
  const calls: Array<Promise<void>> = [
    leaseCall("app", owner.appId, () => rpc<void>(env.APP_LIMITER.getByName(owner.appId).activateSession(claim, now)), keep),
  ];
  if (limiter !== null) calls.unshift(leaseCall("user", owner.appId, () => rpc<void>(env.END_USER_LIMITER.getByName(limiter).activateSession(claim, now)), keep));
  await Promise.all(calls);
}

/** `close`: both leases are freed (T8). Never fails. */
export async function releaseSessionLeases(env: Env, owner: LeaseOwner, sessionId: string, waitUntil?: (p: Promise<unknown>) => void): Promise<void> {
  const keep = waitUntil ?? ((promise: Promise<unknown>) => void promise);
  const limiter = sessionLimiterName(owner.appId, owner.installId, owner.endUserId);
  const calls: Array<Promise<void>> = [
    leaseCall("app", owner.appId, () => rpc<void>(env.APP_LIMITER.getByName(owner.appId).releaseSession(sessionId)), keep),
  ];
  if (limiter !== null) calls.unshift(leaseCall("user", owner.appId, () => rpc<void>(env.END_USER_LIMITER.getByName(limiter).releaseSession(sessionId)), keep));
  await Promise.all(calls);
}

async function leaseCall(scope: "user" | "app", appId: string, call: () => Promise<void>, keep: (p: Promise<unknown>) => void): Promise<void> {
  const answer = await within(Promise.resolve().then(call), LEASE_DEADLINE_MS, keep);
  if (!("value" in answer)) {
    log("warn", "session_lease_unchanged", { app: appId, scope, reason: answer.missed, ...(answer.missed === "failed" ? { error: errorFacts(answer.error) } : {}) });
  }
}

/**
 * The replacement decision at a session's live checkpoint (crash table row
 * 20), for the checkpoint to call (step 9a part 2) once the ledger side gave
 * no explicit stop. A limiter that is slow or fails answers "continue", with
 * a warning: the decision waits for the next live checkpoint.
 */
export async function replacementAtCheckpoint(env: Env, owner: LeaseOwner, input: SessionCheckpointInput, waitUntil: (p: Promise<unknown>) => void): Promise<"continue" | "replaced"> {
  const limiter = sessionLimiterName(owner.appId, owner.installId, owner.endUserId);
  if (limiter === null) return "continue";
  const answer = await within(rpc<SessionCheckpointAnswer>(env.END_USER_LIMITER.getByName(limiter).sessionCheckpoint(input)), LEASE_DEADLINE_MS, waitUntil);
  if (!("value" in answer)) {
    log("warn", "session_replacement_unchecked", { app: owner.appId, reason: answer.missed, ...(answer.missed === "failed" ? { error: errorFacts(answer.error) } : {}) });
    return "continue";
  }
  if (answer.value.replaced.length > 0) log("info", "session_replaced", { app: owner.appId, count: answer.value.replaced.length });
  return answer.value.decision;
}

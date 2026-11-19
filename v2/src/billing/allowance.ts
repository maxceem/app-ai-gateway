/**
 * Spending one request of the plan allowance without ever letting the counter
 * fail an app (v1's `allowance-admission.ts`, ported).
 *
 * A request the counter fails to count costs us one cheap request; a request
 * we fail to serve costs a customer's user an error. So whenever the counter
 * cannot answer in time, the request is served uncounted and logged
 * `allowance_uncounted`. The one refusal that survives is the one the account
 * earned: a plan the counter last confirmed used up stays used up.
 */
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";
import { platformFailure, type PlatformFailureReason } from "../core/platform-errors.ts";
import { ttlCache } from "../core/ttl-cache.ts";
import type { AllowanceAdmission, AllowanceAdmissionInput } from "../do/AccountLimiter.ts";

/** What this isolate last learned of an account's allowance. */
interface AllowanceReading {
  periodId: string;
  used: number;
  /** Requests served uncounted since then. */
  uncounted: number;
}

/** Keyed by account ids from D1. A reading only ever undercounts, so an old one errs towards serving. */
const lastReadings = ttlCache<string, AllowanceReading>({
  name: "allowance-last-reading",
  ttlMs: 24 * 60 * 60_000,
  maxEntries: 5_000,
});

export type AllowanceOutcome =
  | { kind: "answered"; admission: AllowanceAdmission }
  | { kind: "uncounted" }
  | { kind: "exhausted"; allowed: false; used: number; limit: number; retryAfterSeconds: number };

type CounterFailure = "timeout" | PlatformFailureReason | "fault";

/** Spends one request, or decides without the counter when it cannot answer within `deadlineMs`. */
export async function admitAllowance(
  counter: { admit(input: AllowanceAdmissionInput): Promise<AllowanceAdmission> | AllowanceAdmission },
  accountId: string,
  input: AllowanceAdmissionInput,
  waitUntil: (promise: Promise<unknown>) => void,
  deadlineMs: number,
): Promise<AllowanceOutcome> {
  let servedUncounted = false;
  const call = Promise.resolve().then(() => counter.admit(input));
  call.catch((error: unknown) => {
    if (platformFailure(error) === null) log("error", "allowance_counter_fault", { account: accountId, error: errorFacts(error) });
  });
  // Whenever the counter answers, in time or not, its figure becomes the reading.
  const recorded = call.then((admission) => {
    const previous = lastReadings.get(accountId);
    const carried = previous?.periodId === input.periodId ? previous.uncounted : 0;
    lastReadings.set(accountId, {
      periodId: input.periodId,
      used: admission.used,
      uncounted: Math.max(0, carried - (servedUncounted ? 1 : 0)),
    });
    return admission;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(0, deadlineMs));
  });
  let failure: CounterFailure;
  let error: unknown;
  try {
    const answer = await Promise.race([recorded, deadline]);
    if (answer !== "timeout") return { kind: "answered", admission: answer };
    failure = "timeout";
    // The abandoned call keeps running, so it can still count the request.
    waitUntil(recorded.catch(() => undefined));
  } catch (caught) {
    error = caught;
    failure = platformFailure(caught) ?? "fault";
  } finally {
    clearTimeout(timer);
  }
  // Refused only when the counter itself last said the period is used up:
  // requests served uncounted since are guesses, and a guess never refuses
  // (AGENTS.md: the allowance must be known to be used up).
  const reading = lastReadings.get(accountId);
  if (reading?.periodId === input.periodId && reading.used >= input.limit) {
    const end = Date.parse(input.periodEnd);
    return {
      kind: "exhausted",
      allowed: false,
      used: reading.used,
      limit: input.limit,
      retryAfterSeconds: Number.isFinite(end) ? Math.max(1, Math.ceil((end - Date.now()) / 1_000)) : 1,
    };
  }
  servedUncounted = true;
  if (reading?.periodId === input.periodId) lastReadings.set(accountId, { ...reading, uncounted: reading.uncounted + 1 });
  log("warn", "allowance_uncounted", {
    account: accountId,
    reason: failure,
    ...(error === undefined ? {} : { error: errorFacts(error) }),
  });
  return { kind: "uncounted" };
}

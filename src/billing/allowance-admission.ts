import type { QuotaAdmission, QuotaAdmissionInput } from "../do/OrgQuota";
import { errorFacts } from "../core/error-facts";
import { log } from "../core/log";
import { platformFailure, type PlatformFailureReason } from "../core/platform-errors";
import { ttlCache } from "../core/ttl-cache";

/**
 * Spending the plan allowance without ever letting the counter fail an app.
 *
 * The allowance is what a customer pays this gateway for, and a request it
 * fails to count costs us one cheap request. A request it fails to serve costs
 * one of our customer's own users an error, which is far worse. So whenever the
 * counter cannot answer promptly — it is slow, the platform lost it, it is
 * overloaded, or it threw for any other reason — the request is served
 * uncounted. The one refusal that survives is the one the customer has earned:
 * a plan this isolate last saw used up stays used up.
 *
 * The count stays exact whenever the counter answers. A call abandoned at the
 * deadline keeps running, so it usually still lands and counts the request it
 * was made for; nothing is ever retried, because a retry could count a request
 * twice.
 */

/**
 * How long a request waits for the counter. Healthy, it answers in tens of
 * milliseconds; this leaves room for a cold object while keeping a stalled one
 * from holding the request.
 */
export const ALLOWANCE_ADMIT_DEADLINE_MS = 2_000;

/** What this isolate last learned of an organization's allowance. */
interface AllowanceReading {
  periodId: string;
  /** The counter's own figure at its last answer. */
  used: number;
  /** Requests this isolate has served uncounted since then. */
  uncounted: number;
}

/**
 * Keyed by organization ids that came from D1, so not attacker-growable. A
 * reading only ever undercounts — `used` never falls within a period — so an
 * old one errs towards serving, which is the direction this module wants.
 */
const lastReadings = ttlCache<string, AllowanceReading>({
  name: "allowance-last-reading",
  ttlMs: 24 * 60 * 60_000,
  maxEntries: 5_000,
});

export type AllowanceOutcome =
  | { kind: "answered"; admission: QuotaAdmission }
  | { kind: "uncounted" }
  | { kind: "exhausted"; allowed: false; used: number; limit: number; retryAfterSeconds: number };

type CounterFailure = "timeout" | PlatformFailureReason | "fault";

/**
 * Spends one request of the organization's allowance, or decides without the
 * counter when it cannot answer within {@link ALLOWANCE_ADMIT_DEADLINE_MS}.
 */
export async function admitAllowance(
  counter: { admit(input: QuotaAdmissionInput): Promise<QuotaAdmission> | QuotaAdmission },
  organizationId: string,
  input: QuotaAdmissionInput,
  waitUntil: (promise: Promise<unknown>) => void,
  deadlineMs: number = ALLOWANCE_ADMIT_DEADLINE_MS,
): Promise<AllowanceOutcome> {
  let servedUncounted = false;
  const call = Promise.resolve().then(() => counter.admit(input));
  // Whenever the counter answers, in time or not, its figure becomes the
  // reading. A late answer counted a request this isolate has already served
  // uncounted, so that one is no longer uncounted.
  const recorded = call.then((admission) => {
    const previous = lastReadings.get(organizationId);
    const carried = previous?.periodId === input.periodId ? previous.uncounted : 0;
    lastReadings.set(organizationId, {
      periodId: input.periodId,
      used: admission.used,
      uncounted: Math.max(0, carried - (servedUncounted ? 1 : 0)),
    });
    return admission;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deadlineMs);
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

  const reading = lastReadings.get(organizationId);
  if (reading?.periodId === input.periodId && reading.used + reading.uncounted >= input.limit) {
    const end = Date.parse(input.periodEnd);
    const now = Date.now();
    return {
      kind: "exhausted",
      allowed: false,
      used: reading.used + reading.uncounted,
      limit: input.limit,
      retryAfterSeconds: Number.isFinite(end) ? Math.max(1, Math.ceil((end - now) / 1_000)) : 1,
    };
  }
  servedUncounted = true;
  if (reading?.periodId === input.periodId) {
    lastReadings.set(organizationId, { ...reading, uncounted: reading.uncounted + 1 });
  }
  // A fault is ours rather than the platform's, so it is logged as an error to
  // be noticed and fixed; the request is still served.
  log(failure === "fault" ? "error" : "warn", "allowance_uncounted", {
    organizationId,
    reason: failure,
    ...(error === undefined ? {} : { error: errorFacts(error) }),
  });
  return { kind: "uncounted" };
}

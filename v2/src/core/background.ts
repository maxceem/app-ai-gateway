import { errorFacts } from "./error-facts.ts";
import { log } from "./log.ts";

/** Work done after the answer is sent. Each kind is named so a failure in the logs says which. */
export type BackgroundTask = "auth_event" | "challenge_attempted" | "auth_last_seen" | "auth_challenges";

/** Runs `work` in the background, logging a failure instead of losing it. */
export function contained(task: BackgroundTask, work: Promise<unknown>): Promise<void> {
  return work.then(
    () => undefined,
    (error: unknown) => log("error", "background_task_failed", { task, error: errorFacts(error) }),
  );
}

/**
 * `work`, or a rejection once `ms` has passed. The work itself keeps running:
 * use it only where every write the work makes is safe whenever it lands (a
 * write by stable id), so a slow D1 still leaves time for a fallback.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, what: string, late: (message: string) => Error = (message) => new Error(message)): Promise<T> {
  // A late failure of the work, after the deadline answered, is not an unhandled rejection.
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(late(`${what} took longer than ${ms} ms`)), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/**
 * How long one job after the answer may take as a whole: well inside the
 * request's `waitUntil`, which ends about 30 s after the answer, so the job's
 * final warning is always logged.
 */
export const BACKGROUND_JOB_DEADLINE_MS = 20_000;

/**
 * Background work with one overall deadline and a final warning (plan, step
 * 8f): `work`'s value, or undefined once it fails or runs out of time, logged
 * as `failure` at `warn`. Never throws.
 */
export async function boundedJob<T>(
  work: Promise<T>,
  what: string,
  failure: string,
  facts: Record<string, unknown> = {},
  ms: number = BACKGROUND_JOB_DEADLINE_MS,
): Promise<T | undefined> {
  try {
    return await withDeadline(work, ms, what);
  } catch (error) {
    log("warn", failure, { ...facts, error: errorFacts(error) });
    return undefined;
  }
}

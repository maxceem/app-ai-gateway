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
export function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  // A late failure of the work, after the deadline answered, is not an unhandled rejection.
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

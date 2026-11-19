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

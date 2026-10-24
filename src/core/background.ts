import { errorFacts } from "./error-facts";
import { log } from "./log";

/** The work the gateway leaves running after a response, named for the log. */
export type BackgroundTask =
  | "maintenance"
  | "served_request"
  | "auth_event"
  | "claim_pending"
  | "rejection_event";

/**
 * `work`, with any failure logged as facts instead of left unhandled. A
 * rejected `waitUntil` promise is logged by the runtime itself, message and
 * stack included, and an error's text can quote what it was given.
 */
export function contained(task: BackgroundTask, work: Promise<unknown>): Promise<void> {
  return work.then(
    () => undefined,
    (error: unknown) => log("error", "background_task_failed", { task, error: errorFacts(error) }),
  );
}

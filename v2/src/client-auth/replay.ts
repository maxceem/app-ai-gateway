/**
 * The App Attest replay check, on the end user's limiter object.
 *
 * Never skipped (plan section 4.2): if the object does not answer within
 * REPLAY_CHECK_DEADLINE_MS, the request is refused with a 503 the client can
 * retry. This deadline is the replay check's own; the budget checks of step
 * 1b share a separate one.
 */
import { GatewayError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { errorFacts } from "../core/error-facts.ts";
import { serviceUnavailable } from "../core/platform-errors.ts";

export const REPLAY_CHECK_DEADLINE_MS = 2_000;

/** The limiter object of one App Attest install. */
export function installLimiterName(appId: string, installId: string): string {
  return `${appId}:install:${installId}`;
}

/** Accepts an assertion counter once for this install, or throws. */
export async function useAssertionCounter(
  env: Env,
  appId: string,
  installId: string,
  counter: number,
  deadlineMs: number = REPLAY_CHECK_DEADLINE_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), deadlineMs);
  });
  let answer: { accepted: boolean } | "late";
  try {
    const pending = env.END_USER_LIMITER.getByName(installLimiterName(appId, installId)).useCounter(counter);
    answer = await Promise.race([pending, late]);
    if (answer === "late") pending.then(undefined, () => undefined);
  } catch (error) {
    log("error", "replay_check_failed", { app: appId, error: errorFacts(error) });
    throw serviceUnavailable("platform_unavailable", "The gateway could not check this request; retry shortly", error);
  } finally {
    clearTimeout(timer);
  }
  if (answer === "late") {
    log("error", "replay_check_slow", { app: appId, deadlineMs });
    throw serviceUnavailable("deadline_exceeded", "The gateway could not check this request in time; retry shortly");
  }
  if (!answer.accepted) {
    throw new GatewayError(403, "attest_failed", "App Attest assertion counter was replayed");
  }
}

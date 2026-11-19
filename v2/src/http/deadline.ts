/**
 * A 10-second deadline on the app sign-in routes and `/me`, as in v1. A call
 * still running then is answered with a 503 the client can retry, and left to
 * finish in the background.
 */
import type { MiddlewareHandler } from "hono";
import { serviceUnavailable } from "../core/platform-errors.ts";

export const CLIENT_CALL_DEADLINE_MS = 10_000;

export interface DeadlineVariables {
  /** Aborted when the deadline passes, with the 503 the client got as its reason. */
  deadline: AbortSignal;
}

export function clientCallDeadline(
  deadlineMs: number = CLIENT_CALL_DEADLINE_MS,
): MiddlewareHandler<{ Bindings: Env; Variables: DeadlineVariables }> {
  return async (c, next) => {
    const controller = new AbortController();
    c.set("deadline", controller.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = serviceUnavailable("deadline_exceeded", "The gateway took too long to answer; retry shortly");
        controller.abort(error);
        reject(error);
      }, deadlineMs);
    });
    const pending = next();
    try {
      await Promise.race([pending, expired]);
    } catch (error) {
      if (controller.signal.aborted) c.executionCtx.waitUntil(pending.catch(() => undefined));
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

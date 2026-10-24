import type { MiddlewareHandler } from "hono";
import { serviceUnavailable } from "../core/platform-errors";
import type { RequestVariables } from "./request-scope";

/**
 * How long a client call that is not a served request — the token exchange,
 * key registration, a challenge, `/me` — may take before the gateway gives up.
 *
 * Each normally answers in well under a second: a few D1 reads, a Durable
 * Object or two, and at most one issuer key fetch, which has its own five
 * seconds. Ten leaves room for a slow moment without holding a client for the
 * half-minute a hung database call otherwise costs. Served requests are never
 * held to it: a provider may stream for minutes.
 */
export const CLIENT_CALL_DEADLINE_MS = 10_000;

/**
 * Answers `service_unavailable` once the deadline passes, rather than leaving
 * the client waiting on whatever hung.
 *
 * The call it abandons is not cancelled — nothing in it takes a signal — so a
 * write in flight may still land. Every one of these is safe to repeat from a
 * fresh challenge: a consumed challenge or an advanced assertion counter is
 * exactly what a retry needs anyway. Should the abandoned call still finish
 * while the request lives, its own failure is logged then, which is what names
 * the call that hung.
 */
export const clientCallDeadline: MiddlewareHandler<{
  Bindings: Env;
  Variables: RequestVariables;
}> = async (c, next) => {
  const controller = new AbortController();
  c.set("deadline", controller.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = serviceUnavailable("deadline_exceeded", "The gateway took too long to answer; retry shortly");
      // Aborted first, so whatever listens — the auth event log — sees the
      // refusal before the client does.
      controller.abort(error);
      reject(error);
    }, CLIENT_CALL_DEADLINE_MS);
  });
  try {
    await Promise.race([next(), expired]);
  } finally {
    clearTimeout(timer);
  }
};

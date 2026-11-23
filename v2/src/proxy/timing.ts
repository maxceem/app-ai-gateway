/**
 * How long each step of a served request took, for the `server-timing` header
 * on its answer, as v1 (`src/execution/timing.ts` at the repository root).
 *
 * The steps, in order:
 * - `auth`: loading the app, checking who is calling, using up a signed
 *   request's counter, and the caller checks that follow it;
 * - `prepare`: reading the body, finding the operation and its price, and
 *   opening the provider key;
 * - `limiter`: the app's limits and the plan allowance;
 * - `provider_ttfb`: the provider's time to its first byte.
 *
 * A step is timed whether it succeeds or refuses, so the step a request was
 * refused in reports how long the refusal took. A step the request never
 * reached is left out, so it is never mistaken for one that took no time.
 * Only durations are sent: nothing about the caller, the app or the provider.
 *
 * One route middleware (`serverTiming`) starts the clock, closes whatever
 * step is still open when the answer is ready, and sets the header on it,
 * error answers included. The steps in between mark where one ends.
 */
import type { MiddlewareHandler } from "hono";

export interface ServedTimings {
  /** When `auth` began: as the request arrived, before its app was loaded. */
  readonly authStartedAt: number;
  authMs?: number;
  /** When `prepare` began: set as `auth` ends. */
  prepareStartedAt?: number;
  prepareMs?: number;
  limiterMs?: number;
  /** The provider's time to its first byte, once it answered. */
  providerTtfbMs?: number;
}

/** One request's timings, found again by each step. Keyed by the request, so nothing is kept once it is gone. */
const TIMINGS = new WeakMap<Request, ServedTimings>();

/** The timings of a served request, or `undefined` for any other request. */
export function timingsOf(request: Request): ServedTimings | undefined {
  return TIMINGS.get(request);
}

/** Ends `auth` and starts `prepare`. */
export function authDone(timings: ServedTimings): void {
  const now = performance.now();
  timings.authMs = now - timings.authStartedAt;
  timings.prepareStartedAt = now;
}

/** Ends `prepare`, if it began and has not ended yet. */
export function prepareDone(timings: ServedTimings): void {
  if (timings.prepareStartedAt === undefined || timings.prepareMs !== undefined) return;
  timings.prepareMs = performance.now() - timings.prepareStartedAt;
}

/**
 * Runs admission as the `limiter` step: `prepare` ends as it starts, and the
 * step is timed whether it admits or refuses.
 */
export async function timedAdmission(timings: ServedTimings | undefined, admit: () => Promise<void>): Promise<void> {
  if (timings === undefined) return admit();
  prepareDone(timings);
  const startedAt = performance.now();
  try {
    await admit();
  } finally {
    timings.limiterMs = performance.now() - startedAt;
  }
}

/** Records the provider's time to its first byte as soon as it answered, before its answer is judged. */
export function providerAnswered(request: Request, providerTtfbMs: number): void {
  const timings = timingsOf(request);
  if (timings !== undefined) timings.providerTtfbMs = providerTtfbMs;
}

/**
 * The `server-timing` value. Entries keep their names and their order, and
 * each is named only once the request reached its step. The provider's entry
 * is there only when it answered.
 */
export function serverTimingValue(timings: ServedTimings): string {
  const entries: Array<[string, number | undefined]> = [
    ["auth", timings.authMs],
    ["prepare", timings.prepareMs],
    ["limiter", timings.limiterMs],
    ["provider_ttfb", timings.providerTtfbMs],
  ];
  const named: string[] = [];
  for (const [name, durationMs] of entries) {
    if (durationMs === undefined || !Number.isFinite(durationMs)) continue;
    named.push(`${name};dur=${Math.max(0, durationMs).toFixed(1)}`);
  }
  return named.join(", ");
}

/**
 * The route middleware of every served route (proxy, presets, passthrough and
 * job polls): starts `auth`, and once the answer is ready, error answers
 * included, closes the step still open and sets the header, replacing any
 * the provider sent.
 */
export const serverTiming: MiddlewareHandler = async (c, next) => {
  const timings: ServedTimings = { authStartedAt: performance.now() };
  TIMINGS.set(c.req.raw, timings);
  await next();
  if (timings.authMs === undefined) timings.authMs = performance.now() - timings.authStartedAt;
  else prepareDone(timings);
  const value = serverTimingValue(timings);
  try {
    c.res.headers.set("server-timing", value);
  } catch {
    // An answer whose headers cannot change (one passed on as it came) is copied once.
    const headers = new Headers(c.res.headers);
    headers.set("server-timing", value);
    c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
  }
};

/**
 * How long each step of a served request took, for the `server-timing` header
 * on its answer, as v1 (`src/execution/timing.ts` at the repository root).
 *
 * The steps, in order:
 * - `auth`: checking who is calling, using up a signed request's counter, and
 *   the caller checks that follow it;
 * - `prepare`: reading the body, finding the operation and its price, and
 *   opening the provider key;
 * - `limiter`: the app's limits and the plan allowance;
 * - `provider_ttfb`: the provider's time to its first byte.
 *
 * A step is timed whether it succeeds or refuses, so the step a request was
 * refused in reports how long the refusal took. A step the request never
 * reached is left out, so it is never mistaken for one that took no time.
 * Only durations are sent: nothing about the caller, the app or the provider.
 */
export interface ServedTimings {
  /** When `auth` began: as the request arrived, before its app was loaded. */
  authStartedAt?: number;
  authMs?: number;
  prepareMs?: number;
  limiterMs?: number;
  /** When `prepare` began: set as `auth` ends. */
  prepareStartedAt?: number;
  /** The provider's time to its first byte, once it answered: kept for an answer the gateway then refuses (a job with no id). */
  providerTtfbMs?: number;
}

/** One request's timings, found again by the error handler. Keyed by the request, so nothing is kept once it is gone. */
const TIMINGS = new WeakMap<Request, ServedTimings>();

/** Starts timing a served request, with `auth`: from loading its app on, as v1. Called again, it answers the same timings. */
export function startTimings(request: Request): ServedTimings {
  const known = TIMINGS.get(request);
  if (known !== undefined) return known;
  const timings: ServedTimings = { authStartedAt: performance.now() };
  TIMINGS.set(request, timings);
  return timings;
}

/** Ends `auth` for a request refused in it, such as one for an app that does not exist or is disabled. */
export function authRefused(timings: ServedTimings): void {
  if (timings.authMs === undefined && timings.authStartedAt !== undefined) timings.authMs = performance.now() - timings.authStartedAt;
}

/** The timings of a served request, or `undefined` for any other request. */
export function timingsOf(request: Request): ServedTimings | undefined {
  return TIMINGS.get(request);
}

/** Ends `auth` and starts `prepare`. */
export function authDone(timings: ServedTimings, authStartedAt: number): void {
  const now = performance.now();
  timings.authMs = now - authStartedAt;
  timings.prepareStartedAt = now;
}

/** Ends `prepare`, if it began and has not ended yet: before admission, or as a refusal leaves it. */
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

/**
 * The `server-timing` value. Entries keep their names and their order, and
 * each is named only once the request reached its step. The provider's entry
 * is there only when it answered.
 */
export function serverTiming(timings: ServedTimings, providerTtfbMs?: number): string {
  const entries: Array<[string, number | undefined]> = [
    ["auth", timings.authMs],
    ["prepare", timings.prepareMs],
    ["limiter", timings.limiterMs],
    ["provider_ttfb", providerTtfbMs ?? timings.providerTtfbMs],
  ];
  const named: string[] = [];
  for (const [name, durationMs] of entries) {
    if (durationMs === undefined || !Number.isFinite(durationMs)) continue;
    named.push(`${name};dur=${Math.max(0, durationMs).toFixed(1)}`);
  }
  return named.join(", ");
}

/** Sets the header on an answer, when the request is a served one with anything to say. */
export function setServerTiming(headers: Headers, request: Request, providerTtfbMs?: number): void {
  const timings = timingsOf(request);
  if (timings === undefined) return;
  const value = serverTiming(timings, providerTtfbMs);
  if (value === "") headers.delete("server-timing");
  else headers.set("server-timing", value);
}

/** Records the provider's time to its first byte as soon as it answered, before its answer is judged. */
export function providerAnswered(request: Request, providerTtfbMs: number): void {
  const timings = timingsOf(request);
  if (timings !== undefined) timings.providerTtfbMs = providerTtfbMs;
}

/**
 * How long authentication, preparing the plan and the limiters took, for
 * `server-timing` on any answer. `prepareMs` stays absent until the request
 * reaches that step; one refused in it reports the time it took to refuse.
 */
export interface ServedTimings {
  authMs: number;
  prepareMs?: number;
  limiterMs: number;
}

/**
 * The `server-timing` value for a served request, provider time included where
 * there was one. Clients may parse it, so entries keep their names and order:
 * `prepare` is named only once the request reached it, so a reader can tell a
 * step that never ran from one that took no time.
 */
export function serverTiming(timings: ServedTimings, providerTtfbMs = 0): string {
  const prepare = timings.prepareMs === undefined ? "" : `, prepare;dur=${timings.prepareMs.toFixed(1)}`;
  return `auth;dur=${timings.authMs.toFixed(1)}${prepare}, limiter;dur=${timings.limiterMs.toFixed(1)}, provider_ttfb;dur=${providerTtfbMs.toFixed(1)}`;
}

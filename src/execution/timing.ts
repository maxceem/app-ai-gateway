/**
 * How long authentication, preparing the plan and the limiters took, for
 * `server-timing` on any answer. A step the request never reached stays 0; one
 * it was refused in reports the time it took to refuse.
 */
export interface ServedTimings {
  authMs: number;
  prepareMs: number;
  limiterMs: number;
}

/**
 * The `server-timing` value for a served request, provider time included where
 * there was one. Every entry is always present, in this order; clients may
 * parse it, so a new entry goes in without moving the others.
 */
export function serverTiming(timings: ServedTimings, providerTtfbMs = 0): string {
  return `auth;dur=${timings.authMs.toFixed(1)}, prepare;dur=${timings.prepareMs.toFixed(1)}, limiter;dur=${timings.limiterMs.toFixed(1)}, provider_ttfb;dur=${providerTtfbMs.toFixed(1)}`;
}

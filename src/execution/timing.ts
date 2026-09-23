/** How long authentication and the limiters took, for `server-timing` on any answer. */
export interface ServedTimings {
  authMs: number;
  limiterMs: number;
}

/** The `server-timing` value for a served request, provider time included where there was one. */
export function serverTiming(timings: ServedTimings, providerTtfbMs = 0): string {
  return `auth;dur=${timings.authMs.toFixed(1)}, limiter;dur=${timings.limiterMs.toFixed(1)}, provider_ttfb;dur=${providerTtfbMs.toFixed(1)}`;
}

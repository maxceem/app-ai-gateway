/**
 * How long each step of a served request took, for `server-timing` on any
 * answer. A step is timed whether it succeeds or refuses, so one a request was
 * refused in reports how long the refusal took; a step it never reached stays
 * absent.
 */
export interface ServedTimings {
  authMs?: number;
  prepareMs?: number;
  limiterMs?: number;
}

/**
 * The `server-timing` value for a served request. Entries keep their names and
 * their order, and each is named only once the request reached its step, so a
 * reader can tell a step that never ran from one that took no time. The
 * provider's entry is present only when it answered.
 */
export function serverTiming(timings: ServedTimings, providerTtfbMs?: number): string {
  return [
    ["auth", timings.authMs],
    ["prepare", timings.prepareMs],
    ["limiter", timings.limiterMs],
    ["provider_ttfb", providerTtfbMs],
  ]
    .filter((entry): entry is [string, number] => entry[1] !== undefined)
    .map(([name, durationMs]) => `${name};dur=${durationMs.toFixed(1)}`)
    .join(", ");
}

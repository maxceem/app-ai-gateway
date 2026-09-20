/** Maximum client-version metadata retained in rows and structured logs. */
export const APP_VERSION_MAX_LENGTH = 64;

/**
 * Bounds caller-controlled version metadata before it reaches durable storage
 * or logs. Slice by UTF-16 code units, as JavaScript strings and D1 bindings do,
 * so the operation never has to copy or iterate over the unbounded remainder.
 */
export function storedAppVersion(value: string | null | undefined): string | null {
  return value === null || value === undefined
    ? null
    : value.slice(0, APP_VERSION_MAX_LENGTH);
}

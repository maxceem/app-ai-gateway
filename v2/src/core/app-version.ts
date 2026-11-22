/** Maximum client-version metadata retained in rows and structured logs. */
export const APP_VERSION_MAX_LENGTH = 32;

/**
 * A version as apps send it: an optional `v`, a digit, then up to 31 letters,
 * digits and `.+_-`, such as `1.4.2`, `v2.0.0-beta.3` or `2024.11.22+45`.
 * Anything else is the caller's text and may be a key pasted by mistake, so
 * it is never stored (v1 stored any value, cut to 64 characters).
 */
const APP_VERSION = /^v?[0-9][0-9A-Za-z.+_-]{0,31}$/u;

/**
 * The caller's `X-App-Version` as rows and logs keep it: the value when it is
 * shaped like a version (`APP_VERSION`), otherwise nothing. Never a reason to
 * refuse a request: the header is still required where it was.
 */
export function storedAppVersion(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.length > APP_VERSION_MAX_LENGTH + 1) return null;
  return APP_VERSION.test(value) ? value : null;
}

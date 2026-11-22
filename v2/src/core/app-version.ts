/**
 * A version as apps send it: an optional `v`, a numeric core of one to four
 * dotted numbers, an optional short pre-release or build tail starting with
 * `-` or `+`, and an optional build number in parentheses: `1.4.2`,
 * `v2.0.0-beta.3`, `2024.11.22+45`, `1.2.3 (45)`. Anything else, such as
 * `1.0 beta` or a key pasted by mistake, is the caller's own text and is not
 * stored (v1 stored any value, cut to 64 characters).
 */
const APP_VERSION = /^v?[0-9]{1,10}(?:\.[0-9]{1,10}){0,3}(?:[-+][0-9A-Za-z.+_-]{1,20})?(?: \([0-9]{1,10}\))?$/u;
/** The longest value `APP_VERSION` accepts: `v`, four numbers and three dots, a tail of 21, and ` (` + 10 digits + `)`. */
const APP_VERSION_LONGEST = 1 + 4 * 10 + 3 + 21 + 13;

/**
 * The caller's `X-App-Version` as rows and logs keep it: the value when it is
 * shaped like a version (`APP_VERSION`), otherwise nothing. Never a reason to
 * refuse a request: the header is still required where it was.
 */
export function storedAppVersion(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.length > APP_VERSION_LONGEST) return null;
  return APP_VERSION.test(value) ? value : null;
}

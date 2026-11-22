/**
 * A version as apps send it: an optional `v`, a numeric core of one to four
 * dotted numbers, an optional pre-release or build tail of up to 32
 * characters starting with `-` or `+`, and an optional build number in
 * parentheses, one to four dotted numbers as Apple's `CFBundleVersion`
 * allows: `1.4.2`, `v2.0.0-beta.3`, `1.2.3-beta.1+20261122.1`,
 * `1.2.3 (45)`, `1.2.3 (2026.11.1)`. Anything else, such as
 * `1.0 beta` or a key pasted by mistake, is the caller's own text and is not
 * stored (v1 stored any value, cut to 64 characters).
 */
const APP_VERSION = /^v?[0-9]{1,10}(?:\.[0-9]{1,10}){0,3}(?:[-+][0-9A-Za-z.+_-]{1,32})?(?: \([0-9]{1,10}(?:\.[0-9]{1,10}){0,3}\))?$/u;
/** The longest value `APP_VERSION` accepts: `v`, four numbers and three dots, a tail of 33, and ` (` + four numbers and three dots + `)`. */
const APP_VERSION_LONGEST = 1 + (4 * 10 + 3) + 33 + (2 + 4 * 10 + 3 + 1);

/**
 * The caller's `X-App-Version` as rows and logs keep it: the value when it is
 * shaped like a version (`APP_VERSION`), otherwise nothing. Never a reason to
 * refuse a request: the header is still required where it was.
 */
export function storedAppVersion(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.length > APP_VERSION_LONGEST) return null;
  return APP_VERSION.test(value) ? value : null;
}

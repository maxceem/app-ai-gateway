/**
 * The header a gateway client package names itself with, such as
 * `app-ai-gateway-swift/1.7.0`, so an application's owner can see which
 * release of the package its installs run.
 *
 * Read only on the authentication routes and recorded on `app_auth_event`;
 * never forwarded to a provider, because it is not on the forwarded-header
 * allowlist in `src/execution/proxy-rules.ts`.
 */
export const CLIENT_SDK_HEADER = "x-client-sdk";

/** Checked before the pattern, so an oversized value is never scanned at all. */
export const CLIENT_SDK_MAX_LENGTH = 64;

/**
 * The packages this gateway ships, and a stable semantic version: what the
 * package's publish script accepts as a `VERSION`. Each number is at most six
 * digits, so a matching value is at most 41 characters.
 */
const CLIENT_SDK_PATTERN = /^app-ai-gateway-swift\/(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})$/u;

/**
 * The client package a request names, exactly as sent, or `null` for anything
 * that is not one of ours in the exact `<package>/<major>.<minor>.<patch>`
 * form.
 *
 * The header is caller-controlled and unauthenticated, so nothing but a value
 * of that closed shape is ever stored: the result is a bounded token rather
 * than request data, and a malformed value is dropped rather than refused,
 * because it is diagnostics and never a reason to fail a request.
 */
export function storedClientSdk(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.length > CLIENT_SDK_MAX_LENGTH) return null;
  return CLIENT_SDK_PATTERN.test(value) ? value : null;
}

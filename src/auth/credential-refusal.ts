import { bearerToken } from "./bearer";
import {
  CONSOLE_REQUEST_HEADER,
  IDENTITY_COOKIE_PREFIX,
  MANAGEMENT_KEY_PREFIX,
  OAUTH_ACCESS_TOKEN_PREFIX,
} from "./identity";

/**
 * Why a management request was refused `auth_required`, from what it sent:
 *
 * - `credential_missing`: nothing at all — a console checking whether anyone
 *   is signed in, or a client that forgot to authenticate;
 * - `credential_malformed`: something that cannot be a management credential —
 *   another scheme than `Bearer`, an empty one, an application or provider key;
 * - `console_header_missing`: the console's session cookie without the
 *   console's own request header, which only the console sends;
 * - `credential_rejected`: a management key or OAuth token, well formed, that
 *   no longer authenticates — expired, revoked, its account gone;
 * - `session_expired`: the console's session cookie, with its header, that no
 *   longer authenticates.
 *
 * The first three are a caller's mistake; the last two a credential that has
 * gone stale. A reason is the gateway's own: like every `GatewayError`
 * reason it is logged and recorded in management analytics, and never sent to
 * the caller, whose answer is the same `401 auth_required` whatever it is.
 */
export type CredentialRefusalReason =
  | "credential_missing"
  | "credential_malformed"
  | "console_header_missing"
  | "credential_rejected"
  | "session_expired";

/**
 * Better Auth's session cookie, as the console's browser sends it over plain
 * HTTP or HTTPS. cf-auth gives Better Auth the prefix `<prefix>_auth`, so it is
 * `agw_identity_auth.session_token`; the tests send a real one.
 */
const SESSION_COOKIE = new RegExp(
  `(?:^|;\\s*)(?:__Secure-)?${IDENTITY_COOKIE_PREFIX.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}_auth\\.session_token=`,
  "u",
);

/**
 * Reads only whether each credential was sent and what kind it is, never its
 * value. `cookies: false` for a surface where a cookie is never a credential,
 * such as the MCP endpoint, so a browser's cookie there is no credential at all.
 */
export function credentialRefusalReason(
  header: (name: string) => string | undefined,
  { cookies = true }: { cookies?: boolean } = {},
): CredentialRefusalReason {
  const authorization = header("authorization")?.trim();
  if (authorization) {
    const token = bearerToken(authorization);
    if (token === undefined) return "credential_malformed";
    return token.startsWith(MANAGEMENT_KEY_PREFIX) || token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)
      ? "credential_rejected"
      : "credential_malformed";
  }
  if (!cookies || !SESSION_COOKIE.test(header("cookie") ?? "")) return "credential_missing";
  return header(CONSOLE_REQUEST_HEADER) === "1" ? "session_expired" : "console_header_missing";
}

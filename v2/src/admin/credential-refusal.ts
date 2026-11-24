/**
 * Why a management request was refused `auth_required`, from what it sent
 * (v1's, ported), for management analytics:
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
 * A reason is the gateway's own: it is recorded in management analytics and
 * never sent to the caller, whose answer is the same `401 auth_required`
 * whatever it is.
 */
import type { ManagementCredential } from "../analytics/management.ts";
import { bearerToken } from "./actor.ts";
import { CONSOLE_REQUEST_HEADER, IDENTITY_COOKIE_PREFIX, MANAGEMENT_KEY_PREFIX, OAUTH_ACCESS_TOKEN_PREFIX } from "../auth/identity.ts";

export type CredentialRefusalReason =
  | "credential_missing"
  | "credential_malformed"
  | "console_header_missing"
  | "credential_rejected"
  | "session_expired";

/**
 * Better Auth's session cookie, as the console's browser sends it over plain
 * HTTP or HTTPS. cf-auth gives Better Auth the prefix `<prefix>_auth`.
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

/**
 * The credential a request presented, for one refused before it resolved
 * one: a bearer token by its prefix, else the console's session, which the
 * console's own request header stands for. Nothing of the credential itself.
 */
export function presentedCredential(header: (name: string) => string | undefined): ManagementCredential {
  const bearer = bearerToken(header("authorization"));
  if (bearer !== undefined) return bearer.startsWith(OAUTH_ACCESS_TOKEN_PREFIX) ? "oauth" : "apiKey";
  return header(CONSOLE_REQUEST_HEADER) === "1" ? "session" : "none";
}

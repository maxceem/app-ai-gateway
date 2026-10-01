import type { Deployment } from "../policy/deployment";

/**
 * The bearer half of the two management entry points, `/mcp` and
 * `/v1/admin`: reading the token, and the `WWW-Authenticate` challenge a
 * refusal carries. Nothing here loads the identity library.
 */

/** The token of an `Authorization: Bearer …` header, the scheme matched in any case. */
export function bearerToken(header: string | undefined): string | undefined {
  const value = header?.trim();
  if (!value || !/^bearer\s/iu.test(value)) return undefined;
  const token = value.slice(6).trim();
  return token === "" ? undefined : token;
}

/**
 * The protection space both entry points share: the management surface, which
 * `/mcp` and `/v1/admin` both serve and one credential reaches.
 */
export const BEARER_REALM = "management";

/** Where a client reads the MCP endpoint's protected resource metadata, or null where the deployment runs no OAuth. */
export function mcpResourceMetadataUrl(deployment: Deployment): string | null {
  const issuer = deployment.oauth.issuer();
  return issuer === null ? null : `${issuer}/.well-known/oauth-protected-resource/mcp`;
}

/**
 * The challenge a refused bearer request carries (RFC 6750 §3, RFC 9728 §5.1).
 *
 * `discovery` says whether the entry point is where a client discovers the
 * authorization server. Only `/mcp` is: where the deployment runs OAuth, its
 * challenge names the MCP endpoint's own protected resource metadata, whose
 * `resource` is the URL the client called, as RFC 9728 §3.3 requires a client
 * to check. `/v1/admin` accepts the same tokens, but no published document's
 * `resource` is its URL, so a conforming client would reject one named there:
 * its challenge names none, and discovery stays on `/mcp`.
 *
 * `invalid_token` says a token was presented and is not good;
 * `insufficient_scope` says a live one lacks the grant, which is always
 * `manage`, the only grant above `read`. Every challenge names the realm
 * {@link BEARER_REALM}, so none is ever parameterless (RFC 6750 §3).
 */
export function bearerChallenge(
  deployment: Deployment,
  discovery: boolean,
  error?: "invalid_token" | "insufficient_scope",
): string {
  const metadata = discovery ? mcpResourceMetadataUrl(deployment) : null;
  const parameters = [
    `realm="${BEARER_REALM}"`,
    ...(error === undefined ? [] : [`error="${error}"`]),
    ...(error === "insufficient_scope" ? ['scope="manage"'] : []),
    ...(metadata === null ? [] : [`resource_metadata="${metadata}"`]),
  ];
  return `Bearer ${parameters.join(", ")}`;
}

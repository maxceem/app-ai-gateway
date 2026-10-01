import type { AuthState } from "@maxceem/cf-auth";
import { bearerChallenge, bearerToken } from "../auth/bearer";
import {
  identityAuthFor,
  isCfAuthError,
  MANAGEMENT_IDENTITY,
  MANAGEMENT_KEY_PREFIX,
  OAUTH_ACCESS_TOKEN_PREFIX,
  type IdentityAuthScope,
} from "../auth/identity";
import { GatewayError } from "../core/errors";
import type { AdminActor } from "../management/actor";
import { managementActor } from "../middleware/admin";
import type { Deployment } from "../policy/deployment";
import { jsonRpcRefusal } from "./refusal";

/** Who an MCP request is, for every tool call it carries. */
export interface McpAuth {
  state: AuthState;
  actor: AdminActor;
}

function authenticationRequired(
  deployment: Deployment,
  message: string,
  error?: "invalid_token",
): Response {
  return jsonRpcRefusal(401, message, { "WWW-Authenticate": bearerChallenge(deployment, true, error) });
}

/**
 * The bearer gate in front of the MCP endpoint: a management key, or an OAuth
 * connection's access token, as a bearer token, resolved into the one
 * {@link AdminActor} the admin API and the CLI resolve a credential into, or a
 * `401` with a challenge naming the endpoint's protected resource metadata.
 *
 * Only the `Authorization` header is read. A cookie is never a credential here,
 * and neither is the console's request header, so a page that can make a
 * signed-in browser send a request gets nothing through this endpoint.
 *
 * The action source cf-auth records is `mcp` because this is the MCP endpoint,
 * not because a client said so: `X-Client`, which the admin API reads for a
 * key, is not consulted, so a caller cannot label its use of a credential as
 * anything else. A token is routed by its prefix, which no key can begin with.
 *
 * What the actor may then do is each tool's operation policy, applied by
 * `runOperation`; a tool's refusal for want of a grant is that tool's result,
 * never an HTTP status. This decides nothing but who is asking — and since
 * every grant may read, and reading is all the endpoint itself needs, a live
 * credential is never short of one here.
 */
export async function authenticateMcp(
  c: IdentityAuthScope & { req: { header(name: string): string | undefined } },
): Promise<McpAuth | Response> {
  const deployment = c.get("deployment");
  const token = bearerToken(c.req.header("authorization"));
  if (token === undefined) {
    return authenticationRequired(
      deployment,
      "A management key or an OAuth access token is required as a bearer token",
    );
  }
  const refused = () =>
    authenticationRequired(
      deployment,
      "The bearer token is not a valid management key or OAuth access token",
      "invalid_token",
    );
  const oauthToken = token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX);
  if (!oauthToken && !token.startsWith(MANAGEMENT_KEY_PREFIX)) return refused();
  // The management surface's own instance, which the tools' operations then
  // reuse rather than build a second.
  const identity = await identityAuthFor(c, MANAGEMENT_IDENTITY);
  let state: AuthState;
  if (oauthToken) {
    if (identity.config.oauth === null) return refused();
    state = await identity.oauth.resolveAccessTokenAuthState(token, { source: "mcp" });
  } else {
    state = await identity.service.resolveApiKeyAuthState(token, "mcp");
  }
  if (!state.authenticated) return refused();
  try {
    return { state, actor: await managementActor(state) };
  } catch (error) {
    // A credential that resolved but names no usable account or identity is
    // one that does not authenticate, and is answered as one. Anything else
    // is a failure of the gateway's, and is not.
    if (error instanceof GatewayError && error.status === 401) return refused();
    if (isCfAuthError(error) && error.status === 401) return refused();
    throw error;
  }
}

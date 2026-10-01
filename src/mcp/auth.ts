import type { AuthState } from "@maxceem/cf-auth";
import {
  identityAuthFor,
  isCfAuthError,
  MANAGEMENT_KEY_PREFIX,
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

/**
 * The `WWW-Authenticate` challenge a refused MCP request carries.
 *
 * A bare `Bearer` today, because a management key is the only credential and a
 * client can learn nothing more from the challenge than that one is needed.
 * This is the seam OAuth fills in: once the deployment publishes protected
 * resource metadata, the challenge names it with `resource_metadata="…"`
 * derived from the deployment's console origin, and a client discovers the
 * authorization server from the refusal alone.
 */
export function bearerChallenge(_deployment: Deployment, error?: "invalid_token"): string {
  return error === undefined ? "Bearer" : `Bearer error="${error}"`;
}

function authenticationRequired(
  deployment: Deployment,
  message: string,
  error?: "invalid_token",
): Response {
  return jsonRpcRefusal(401, message, { "WWW-Authenticate": bearerChallenge(deployment, error) });
}

/** The token of an `Authorization: Bearer …` header, the scheme matched in any case. */
function bearerToken(header: string | undefined): string | undefined {
  const value = header?.trim();
  if (!value || !/^bearer\s/iu.test(value)) return undefined;
  const token = value.slice(6).trim();
  return token === "" ? undefined : token;
}

/**
 * The bearer gate in front of the MCP endpoint: a management key as a bearer
 * token, resolved into the one {@link AdminActor} the admin API and the CLI
 * resolve it into, or a `401` with a challenge.
 *
 * Only the `Authorization` header is read. A cookie is never a credential here,
 * and neither is the console's request header, so a page that can make a
 * signed-in browser send a request gets nothing through this endpoint.
 *
 * The action source cf-auth records is `mcp` because this is the MCP endpoint,
 * not because a client said so: `X-Client`, which the admin API reads, is not
 * consulted, so a caller cannot label its use of a key as anything else.
 *
 * What the actor may then do is each tool's operation policy, applied by
 * `runOperation`; this decides nothing but who is asking.
 */
export async function authenticateMcp(
  c: IdentityAuthScope & { req: { header(name: string): string | undefined } },
): Promise<McpAuth | Response> {
  const deployment = c.get("deployment");
  const token = bearerToken(c.req.header("authorization"));
  if (token === undefined) {
    return authenticationRequired(deployment, "A management key is required as a bearer token");
  }
  const refused = () =>
    authenticationRequired(deployment, "The bearer token is not a valid management key", "invalid_token");
  if (!token.startsWith(MANAGEMENT_KEY_PREFIX)) return refused();
  const identity = await identityAuthFor(c);
  const state = await identity.service.resolveApiKeyAuthState(token, "mcp");
  if (!state.authenticated) return refused();
  try {
    return { state, actor: await managementActor(state) };
  } catch (error) {
    // A key that resolved but names no usable account or identity is a key
    // that does not authenticate, and is answered as one. Anything else is a
    // failure of the gateway's, and is not.
    if (error instanceof GatewayError && error.status === 401) return refused();
    if (isCfAuthError(error) && error.status === 401) return refused();
    throw error;
  }
}

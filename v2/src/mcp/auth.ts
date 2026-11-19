/**
 * The bearer gate in front of the MCP endpoint (v1's, ported): a management
 * key or an OAuth access token, resolved into the same caller the management
 * API resolves one into, or a `401` whose challenge names the endpoint's
 * protected resource metadata.
 *
 * Only the `Authorization` header is read. A cookie is never a credential
 * here, so a page that can make a signed-in browser send a request gets
 * nothing through this endpoint. The action source cf-auth records is `mcp`
 * because this is the MCP endpoint, never because a client said so.
 *
 * What the caller may then do is each tool's operation's to decide.
 */
import type { CfAuth } from "@maxceem/cf-auth";
import type { Context } from "hono";
import { bearerToken, managementActor, type PresetCaller } from "../admin/actor.ts";
import { identityFor, isCfAuthError, MANAGEMENT_KEY_PREFIX, OAUTH_ACCESS_TOKEN_PREFIX } from "../auth/identity.ts";
import { oauthIssuer } from "../auth/settings.ts";
import { GatewayError } from "../core/errors.ts";
import { jsonRpcRefusal } from "./refusal.ts";

export type McpContext = Context<{ Bindings: Env; Variables: { identity: Promise<CfAuth> } }>;

/** Where a client reads this endpoint's protected resource metadata, or null where the deployment runs no OAuth. */
export function mcpResourceMetadataUrl(env: Env): string | null {
  const issuer = oauthIssuer(env);
  if (issuer === null) return null;
  const { origin, pathname } = new URL(issuer);
  return `${origin}/.well-known/oauth-protected-resource${pathname}/mcp`;
}

/** The challenge a refused request carries (RFC 6750 §3, RFC 9728 §5.1). */
export function mcpChallenge(env: Env, error?: "invalid_token"): string {
  const metadata = mcpResourceMetadataUrl(env);
  return `Bearer ${[
    'realm="management"',
    ...(error === undefined ? [] : [`error="${error}"`]),
    ...(metadata === null ? [] : [`resource_metadata="${metadata}"`]),
  ].join(", ")}`;
}

function required(env: Env, message: string, error?: "invalid_token"): Response {
  return jsonRpcRefusal(401, message, { "WWW-Authenticate": mcpChallenge(env, error) });
}

export async function authenticateMcp(c: McpContext): Promise<PresetCaller | Response> {
  const token = bearerToken(c.req.header("authorization"));
  if (token === undefined) {
    return required(c.env, "A management key or an OAuth access token is required as a bearer token");
  }
  const refused = () =>
    required(c.env, "The bearer token is not a valid management key or OAuth access token", "invalid_token");
  const oauthToken = token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX);
  if (!oauthToken && !token.startsWith(MANAGEMENT_KEY_PREFIX)) return refused();
  const identity = identityFor(c);
  const auth = await identity;
  let state;
  if (oauthToken) {
    if (auth.config.oauth === null) return refused();
    state = await auth.oauth.resolveAccessTokenAuthState(token, { source: "mcp" });
  } else {
    state = await auth.service.resolveApiKeyAuthState(token, "mcp");
  }
  if (!state.authenticated) return refused();
  try {
    return { state, actor: await managementActor(state), identity };
  } catch (error) {
    // A credential that resolved but names no usable account is one that
    // does not authenticate. Anything else is a failure of the gateway's.
    if (error instanceof GatewayError && error.status === 401) return refused();
    if (isCfAuthError(error) && error.status === 401) return refused();
    throw error;
  }
}

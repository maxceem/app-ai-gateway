import type { AuthState } from "@maxceem/cf-auth";
import type { MiddlewareHandler } from "hono";
import { bearerChallenge, bearerToken } from "../auth/bearer";
import {
  asGatewayAuthError,
  cfAuth,
  CONSOLE_REQUEST_HEADER,
  identityAuthFor,
  isCfAuthError,
  MANAGEMENT_KEY_PREFIX,
  OAUTH_ACCESS_TOKEN_PREFIX,
} from "../auth/identity";
import { GatewayError } from "../core/errors";
import type { Deployment } from "../policy/deployment";
import type { AdminActor } from "../management/actor";
import type { RequestVariables } from "./request-scope";

export interface AdminVariables extends RequestVariables {
  authState: AuthState;
  actor: AdminActor;
}

/**
 * Authenticates a management request, and decides nothing else.
 *
 * What the caller is then allowed to do is declared on the operation in
 * `src/contracts/catalog.ts` and applied by `runOperation`, so adding a route
 * does not mean remembering a path regex here. All this establishes is who
 * is asking: which credential, which user, which organization and with what
 * role — as one {@link AdminActor} on the context.
 *
 * Three credentials reach it: the console's session cookie, a management key,
 * and an OAuth connection's access token. A token is routed by its prefix and
 * resolved with the action source `api`, because this is the management API —
 * never from `X-Client`, which only labels a key. Every `401` carries a
 * `Bearer` challenge, and a token whose grant is short of what its operation
 * needs is answered `403` with an `insufficient_scope` one, so an OAuth client
 * learns from the refusal that it needs a connection with the `manage` grant.
 * Neither names protected resource metadata: discovery is the MCP endpoint's.
 */
export const adminAuth: MiddlewareHandler<{
  Bindings: Env;
  Variables: AdminVariables;
}> = async (c, next) => {
  const deployment = c.get("deployment");
  const authorization = c.req.header("authorization")?.trim();
  const token = bearerToken(authorization);
  try {
    if (token !== undefined && token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
      const identity = await identityAuthFor(c);
      // A deployment that runs no OAuth has no connection for a token to name.
      const state = identity.config.oauth === null
        ? null
        : await identity.oauth.resolveAccessTokenAuthState(token, { source: "api" });
      if (!state?.authenticated)
        throw new GatewayError(401, "auth_required", "The OAuth access token is not valid");
      c.set("authState", state);
      c.set("actor", await managementActor(state));
      await next();
      return;
    }
    if (authorization?.toLowerCase().startsWith("bearer ")) {
      const key = authorization.slice(7).trim();
      if (!key.startsWith(MANAGEMENT_KEY_PREFIX)) {
        throw new GatewayError(401, "auth_required", "A valid management key is required");
      }
      // cf-auth matches the scheme with `startsWith("Bearer ")`, so a client that
      // spells it in another case authenticates as nobody rather than being
      // refused. Rewriting the header here keeps that request answerable; the
      // real fix belongs upstream, and this goes when it lands.
      if (!authorization.startsWith("Bearer ")) {
        const headers = new Headers(c.req.raw.headers);
        headers.set("authorization", `Bearer ${key}`);
        c.req.raw = new Request(c.req.raw, { headers });
      }
    }

    // A token never gets here: it was resolved above, and an access-prefixed
    // bearer the library would otherwise route itself is not read again.
    await (await identityAuthFor(c)).middleware<{
      Bindings: Env;
      Variables: AdminVariables;
    }>({ oauth: false })(c, async () => {
      const state = c.get("authState");
      if (
        state.credentialType === "session"
        && c.req.header(CONSOLE_REQUEST_HEADER) !== "1"
      ) {
        throw new GatewayError(
          401,
          "auth_required",
          `Cookie-authenticated admin requests must set ${CONSOLE_REQUEST_HEADER}: 1`,
        );
      }
      c.set("actor", await managementActor(state));
      await next();
    });
  } catch (error) {
    throw challenged(error, deployment, {
      presented: token !== undefined,
      oauth: c.get("actor")?.credentialType === "oauth",
    });
  }
};

/**
 * A refusal with the challenge it owes: every `401` a `Bearer` one, with
 * `invalid_token` when a bearer token was presented;
 * an OAuth connection refused for its grant gets `insufficient_scope`.
 * Anything else is passed through untouched.
 */
function challenged(
  error: unknown,
  deployment: Deployment,
  { presented, oauth }: { presented: boolean; oauth: boolean },
): unknown {
  const refusal = isCfAuthError(error) ? asGatewayAuthError(error) : error;
  if (!(refusal instanceof GatewayError)) return error;
  let challenge: string | null = null;
  if (refusal.status === 401) {
    challenge = bearerChallenge(deployment, false, presented ? "invalid_token" : undefined);
  } else if (refusal.status === 403 && refusal.code === "grant_insufficient" && oauth) {
    challenge = bearerChallenge(deployment, false, "insufficient_scope");
  }
  if (challenge === null) return refusal;
  const headers = new Headers(refusal.headers);
  headers.set("WWW-Authenticate", challenge);
  return new GatewayError(refusal.status, refusal.code, refusal.message, headers, {
    reason: refusal.reason,
    userId: refusal.userId,
    data: refusal.data,
  });
}

/**
 * The one {@link AdminActor} an authenticated management caller is, whichever
 * surface authenticated it: the admin API here, the MCP endpoint, or the
 * CLI's management operations with their own cf-auth options. What it may then do is the
 * operation's catalog policy, applied by `runOperation`.
 */
export async function managementActor(state: AuthState): Promise<AdminActor> {
  const { requireOrganization } = await cfAuth();
  const resolved = requireOrganization(state);
  const user = state.user;
  if (
    !user
    || state.grant === null
    || (state.credentialType !== "session"
      && state.credentialType !== "apiKey"
      && state.credentialType !== "oauth")
  ) {
    throw new GatewayError(401, "auth_required", "Authentication is required");
  }
  return {
    organizationId: resolved.organization.id,
    userId: user.id,
    // Null rather than the empty string: a session with no credential id has
    // none, and `""` is a value.
    credentialId: state.actor?.credentialId ?? null,
    role: resolved.role,
    credentialType: state.credentialType,
    identityKind: user.kind,
    grant: state.grant,
  };
}

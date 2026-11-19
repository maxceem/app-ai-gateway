/**
 * Who is calling the management API.
 *
 * Three credentials reach it, all resolved by cf-auth:
 *
 * - a management key (`Authorization: Bearer agw_mgmt_…`);
 * - an OAuth connection's access token (`Bearer agw_oat_…`), from the CLI or
 *   an MCP client;
 * - the console's sign-in cookie, with `x-console-request: 1`, so a page on
 *   another site cannot make a signed-in browser call it.
 *
 * Reading needs any member. Writing needs the `manage` grant and an owner or
 * admin role, with v1's codes (`grant_insufficient`, `forbidden`). Every 401
 * carries a `Bearer` challenge.
 *
 * Loaded only with the rest of the management code (`../management/app.ts`).
 */
import type { AuthState, CfAuth } from "@maxceem/cf-auth";
import type { MiddlewareHandler } from "hono";
import { GatewayError } from "../core/errors.ts";
import {
  cfAuth,
  CONSOLE_REQUEST_HEADER,
  gatewayErrorOf,
  humanSession,
  identityFor,
  MANAGEMENT_KEY_PREFIX,
  OAUTH_ACCESS_TOKEN_PREFIX,
} from "../auth/identity.ts";

export type AccountRole = "owner" | "admin" | "member";
export type CredentialType = "session" | "apiKey" | "oauth";

export interface AdminActor {
  readonly accountId: string;
  readonly userId: string;
  /** The management key's or OAuth connection's id; null for a console session. */
  readonly credentialId: string | null;
  readonly credentialType: CredentialType;
  readonly role: AccountRole;
  readonly grant: "read" | "manage";
}

export interface AdminVariables {
  actor: AdminActor;
  authState: AuthState;
  identity: Promise<CfAuth>;
}

const BEARER_REALM = "management";

/** The challenge a refusal carries (RFC 6750 §3). */
function challenge(error?: "invalid_token" | "insufficient_scope"): string {
  return [
    `Bearer realm="${BEARER_REALM}"`,
    ...(error === undefined ? [] : [`error="${error}"`]),
    ...(error === "insufficient_scope" ? ['scope="manage"'] : []),
  ].join(", ");
}

function unauthenticated(presented: boolean): GatewayError {
  return new GatewayError(401, "auth_required", "A valid management key, OAuth token or console sign-in is required", {
    "WWW-Authenticate": challenge(presented ? "invalid_token" : undefined),
  });
}

/** The token of an `Authorization: Bearer …` header, the scheme matched in any case. */
export function bearerToken(header: string | undefined): string | undefined {
  const value = header?.trim();
  if (!value || !/^bearer\s/iu.test(value)) return undefined;
  const token = value.slice(6).trim();
  return token === "" ? undefined : token;
}

/** The one {@link AdminActor} an authenticated caller is. */
export async function managementActor(state: AuthState): Promise<AdminActor> {
  const user = state.user;
  if (
    !state.authenticated
    || !user
    || state.grant === null
    || (state.credentialType !== "session" && state.credentialType !== "apiKey" && state.credentialType !== "oauth")
  ) {
    throw unauthenticated(false);
  }
  const { requireOrganization } = await cfAuth();
  const resolved = requireOrganization(state);
  return {
    accountId: resolved.organization.id,
    userId: user.id,
    credentialId: state.actor?.credentialId ?? null,
    credentialType: state.credentialType,
    role: resolved.role,
    grant: state.grant,
  };
}

type AdminEnv = { Bindings: Env; Variables: AdminVariables };

/** A caller another entry point of this Worker has already authenticated. */
export interface PresetCaller {
  readonly state: AuthState;
  readonly actor: AdminActor;
  readonly identity: Promise<CfAuth>;
}

/**
 * Requests built inside this Worker on behalf of a caller it has already
 * authenticated: an MCP tool call, or a CLI tool call, runs its operation as
 * a request to the management API. Only code in this Worker can put an entry
 * here, so no request from outside can carry a caller in.
 */
const PRESET_CALLERS = new WeakMap<Request, PresetCaller>();

/** Marks an in-process request as made by `caller`, and returns it. */
export function asCaller(request: Request, caller: PresetCaller): Request {
  PRESET_CALLERS.set(request, caller);
  return request;
}

/** Puts the caller on the context, or refuses with 401. */
export const adminAuth: MiddlewareHandler<AdminEnv> = async (c, next) => {
  const preset = PRESET_CALLERS.get(c.req.raw);
  if (preset !== undefined) {
    c.set("identity", preset.identity);
    c.set("authState", preset.state);
    c.set("actor", preset.actor);
    await next();
    return;
  }
  const authorization = c.req.header("authorization");
  const token = bearerToken(authorization);
  try {
    if (token !== undefined && token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
      const identity = await identityFor(c);
      const state = identity.config.oauth === null
        ? null
        : await identity.oauth.resolveAccessTokenAuthState(token, { source: "api" });
      if (!state?.authenticated) throw unauthenticated(true);
      c.set("authState", state);
      c.set("actor", await managementActor(state));
      await next();
      return;
    }
    // Only a Bearer token is read as a credential. Another scheme, such as
    // Basic from a self-hosted auth proxy, falls through to the console cookie (as v1).
    if (token !== undefined) {
      if (!token.startsWith(MANAGEMENT_KEY_PREFIX)) throw unauthenticated(true);
      // cf-auth reads the scheme as `Bearer ` exactly, so another spelling is
      // rewritten rather than read as nobody.
      if (!authorization!.trim().startsWith("Bearer ")) {
        const headers = new Headers(c.req.raw.headers);
        headers.set("authorization", `Bearer ${token}`);
        c.req.raw = new Request(c.req.raw, { headers });
      }
    }
    // An access token never gets here: it was resolved above.
    await (await identityFor(c)).middleware<AdminEnv>({ oauth: false })(c, async () => {
      const state = c.get("authState");
      if (!state.authenticated) throw unauthenticated(token !== undefined);
      if (state.credentialType === "session" && c.req.header(CONSOLE_REQUEST_HEADER) !== "1") {
        throw new GatewayError(401, "auth_required", `Console requests must send ${CONSOLE_REQUEST_HEADER}: 1`, {
          "WWW-Authenticate": challenge(),
        });
      }
      c.set("actor", await managementActor(state));
      await next();
    });
  } catch (error) {
    throw withChallenge(gatewayErrorOf(error), c.get("actor")?.credentialType === "oauth");
  }
};

/** Adds the `Bearer` challenge a refusal owes: every 401, and an OAuth token short of its grant. */
function withChallenge(error: unknown, oauth: boolean): unknown {
  if (!(error instanceof GatewayError)) return error;
  const headers = new Headers(error.headers);
  if (error.status === 401 && !headers.has("WWW-Authenticate")) headers.set("WWW-Authenticate", challenge());
  else if (error.status === 403 && error.code === "grant_insufficient" && oauth) {
    headers.set("WWW-Authenticate", challenge("insufficient_scope"));
  } else return error;
  return new GatewayError(error.status, error.code, error.message, headers, { data: error.data, cause: error.cause });
}

/** Refuses a write by a credential with only the read grant, or by a member who is not an owner or admin. */
export function requireManage(actor: AdminActor): void {
  if (actor.grant !== "manage") {
    throw new GatewayError(403, "grant_insufficient", "This credential has the read grant; use one with the manage grant");
  }
  if (actor.role !== "owner" && actor.role !== "admin") {
    throw new GatewayError(403, "forbidden", "Only account owners and admins can change gateway resources");
  }
}

/**
 * Refuses anything but a person signed in to the console. Management keys and
 * sign-ins are administered by a person: a key that could mint keys would
 * hand over more than itself.
 */
export function requireConsoleSession(state: AuthState): AuthState {
  const session = humanSession(state);
  if (session === null) {
    throw new GatewayError(403, "session_required", "Only a person signed in to the console can do this");
  }
  return session;
}

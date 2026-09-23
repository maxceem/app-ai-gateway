import type { AuthState } from "@maxceem/cf-auth";
import type { MiddlewareHandler } from "hono";
import {
  cfAuth,
  CONSOLE_REQUEST_HEADER,
  identityAuthFor,
  MANAGEMENT_KEY_PREFIX,
} from "../auth/identity";
import { GatewayError } from "../core/errors";
import type { app } from "../db/schema";
import type { AdminActor } from "../management/actor";
import type { RequestVariables } from "./request-scope";

export interface AdminVariables extends RequestVariables {
  authState: AuthState;
  actor: AdminActor;
  adminApp?: typeof app.$inferSelect;
}

/**
 * Authenticates a management request, and decides nothing else.
 *
 * What the caller is then allowed to do is declared on the operation in
 * `src/contracts/catalog.ts` and applied by `catalogRouter`, so adding a route
 * does not mean remembering a path regex here. All this establishes is who
 * is asking: which credential, which user, which organization and with what
 * role — as one {@link AdminActor} on the context.
 */
export const adminAuth: MiddlewareHandler<{
  Bindings: Env;
  Variables: AdminVariables;
}> = async (c, next) => {
  const authorization = c.req.header("authorization")?.trim();
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice(7).trim();
    if (!token.startsWith(MANAGEMENT_KEY_PREFIX)) {
      throw new GatewayError(401, "auth_required", "A valid management key is required");
    }
    // cf-auth matches the scheme with `startsWith("Bearer ")`, so a client that
    // spells it in another case authenticates as nobody rather than being
    // refused. Rewriting the header here keeps that request answerable; the
    // real fix belongs upstream, and this goes when it lands.
    if (!authorization.startsWith("Bearer ")) {
      const headers = new Headers(c.req.raw.headers);
      headers.set("authorization", `Bearer ${token}`);
      c.req.raw = new Request(c.req.raw, { headers });
    }
  }

  await (await identityAuthFor(c)).middleware<{
    Bindings: Env;
    Variables: AdminVariables;
  }>()(c, async () => {
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
};

/**
 * The one {@link AdminActor} an authenticated management caller is, whichever
 * surface authenticated it: the admin API here, or the CLI's management
 * operations with their own cf-auth options. What it may then do is the
 * operation's catalog policy, applied by `catalogRouter`.
 */
export async function managementActor(state: AuthState): Promise<AdminActor> {
  const { requireOrganization } = await cfAuth();
  const resolved = requireOrganization(state);
  const user = state.user;
  if (
    !user
    || (state.credentialType !== "session" && state.credentialType !== "apiKey")
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
  };
}

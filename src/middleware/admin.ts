import {
  canManageOrganization,
  requireOrganization,
  type AuthState,
  type CfAuth,
  type OrganizationRole,
} from "@maxceem/cf-auth";
import type { MiddlewareHandler } from "hono";
import {
  CONSOLE_REQUEST_HEADER,
  createOperatorAuth,
  MANAGEMENT_KEY_PREFIX,
  rethrowCfAuthError,
} from "../auth/operator";
import { GatewayError } from "../core/errors";
import type { apps } from "../db/schema";
import type { BillingVariables } from "../billing/gateway";

export interface AdminContext {
  userId: string;
  organizationId: string;
  role: OrganizationRole;
  credentialType: "session" | "apiKey";
}

export interface AdminVariables extends BillingVariables {
  authState: AuthState;
  operatorAuth: CfAuth;
  admin: AdminContext;
  adminApp?: typeof apps.$inferSelect;
}

function isMutation(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  return !path.endsWith("/validate");
}

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
    if (!authorization.startsWith("Bearer ")) {
      const headers = new Headers(c.req.raw.headers);
      headers.set("authorization", `Bearer ${token}`);
      c.req.raw = new Request(c.req.raw, { headers });
    }
  }

  const operatorAuth = createOperatorAuth(c.env, c.req.url);
  c.set("operatorAuth", operatorAuth);

  try {
    await operatorAuth.middleware<{
      Bindings: Env;
      Variables: AdminVariables;
    }>()(c, async () => {
      const state = c.get("authState");
      const resolved = requireOrganization(state);

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

      if (isMutation(c.req.method, c.req.path) && !canManageOrganization(resolved.role)) {
        throw new GatewayError(
          403,
          "forbidden",
          "Only organization owners and admins can mutate gateway resources",
        );
      }

      const actorId = state.user?.id ?? state.actor?.id;
      if (
        !actorId
        || (state.credentialType !== "session" && state.credentialType !== "apiKey")
      ) {
        throw new GatewayError(401, "auth_required", "Authentication is required");
      }

      c.set("admin", {
        userId: actorId,
        organizationId: resolved.organization.id,
        role: resolved.role,
        credentialType: state.credentialType,
      });
      await next();
    });
  } catch (error) {
    rethrowCfAuthError(error);
  }
};

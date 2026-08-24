import type { AuthState } from "@maxceem/cf-auth";
import { Hono, type Context } from "hono";
import { rethrowCfAuthError } from "../../auth/operator";
import {
  OrganizationMemberRoleUpdateRequestSchema,
  OrganizationSelectRequestSchema,
} from "../../contracts/schemas";
import { GatewayError } from "../../core/errors";
import type { AdminVariables } from "../../middleware/admin";

type OrganizationEnv = { Bindings: Env; Variables: AdminVariables };

/**
 * Identity, organization membership and member administration for operator
 * clients.
 *
 * These are thin wrappers over `cfAuth.service.*`: every authorization rule
 * (owner-only owner changes, last-owner protection, manager-only member reads)
 * already lives in the service, so the routes only translate HTTP into service
 * calls and cf-auth errors into the gateway error envelope.
 */
export const organizationRoutes = new Hono<OrganizationEnv>();

/** Session-only surface: a management key has no user identity to administer. */
function sessionActor(admin: AdminVariables["admin"]): string {
  if (admin.credentialType !== "session") {
    throw new GatewayError(
      403,
      "session_required",
      "Organization membership can only be administered from a user session",
    );
  }
  return admin.userId;
}

async function requestBody(c: Context<OrganizationEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new GatewayError(400, "invalid_request", "A JSON object is required");
  }
}

function schemaBody<T>(
  schema: {
    safeParse(value: unknown):
      | { success: true; data: T }
      | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
  },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new GatewayError(
    400,
    "invalid_request",
    issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid request body",
  );
}

/**
 * The console's identity bootstrap. `GET /v1/auth/get-session` only reports
 * better-auth's user record, which leaves a client unable to tell an owner from
 * a read-only member or to name the organization it is acting in.
 */
function sessionPayload(state: AuthState, admin: AdminVariables["admin"]) {
  return {
    user: state.user,
    organization: state.organization,
    role: admin.role,
    memberships: state.memberships,
    credentialType: admin.credentialType,
  };
}

organizationRoutes.get("/session", (c) =>
  c.json({ session: sessionPayload(c.get("authState"), c.get("admin")) }));

organizationRoutes.get("/organizations", async (c) => {
  const actorUserId = sessionActor(c.get("admin"));
  try {
    const organizations = await c.get("operatorAuth").service.listOrganizations(actorUserId);
    return c.json({ organizations });
  } catch (error) {
    rethrowCfAuthError(error);
  }
});

/**
 * Switches the active organization by re-signing the current-organization
 * cookie. Deliberately exempt from the owner/admin mutation gate in
 * `adminAuth`: a read-only member still has to be able to move between the
 * organizations they belong to.
 */
organizationRoutes.post("/organizations/select", async (c) => {
  const admin = c.get("admin");
  const actorUserId = sessionActor(admin);
  const { organizationId } = schemaBody(
    OrganizationSelectRequestSchema,
    await requestBody(c),
  );

  const operatorAuth = c.get("operatorAuth");
  try {
    const state = await operatorAuth.service.selectOrganization(actorUserId, organizationId);
    await operatorAuth.currentOrganizationCookie.write(c, organizationId);
    return c.json({
      session: sessionPayload(state, {
        ...admin,
        organizationId: state.organization?.id ?? admin.organizationId,
        role: state.role ?? admin.role,
      }),
    });
  } catch (error) {
    rethrowCfAuthError(error);
  }
});

/**
 * Members are always read within the caller's current organization, matching
 * how every other admin route derives its tenant from the session.
 */
organizationRoutes.get("/members", async (c) => {
  const admin = c.get("admin");
  const actorUserId = sessionActor(admin);
  try {
    const members = await c.get("operatorAuth").service.listOrganizationMembers(
      actorUserId,
      admin.organizationId,
    );
    return c.json({ members });
  } catch (error) {
    rethrowCfAuthError(error);
  }
});

organizationRoutes.put("/members/:user", async (c) => {
  const admin = c.get("admin");
  const actorUserId = sessionActor(admin);
  const { role } = schemaBody(
    OrganizationMemberRoleUpdateRequestSchema,
    await requestBody(c),
  );
  try {
    const member = await c.get("operatorAuth").service.updateOrganizationMemberRole({
      actorUserId,
      organizationId: admin.organizationId,
      userId: c.req.param("user"),
      role,
    });
    return c.json({ member });
  } catch (error) {
    rethrowCfAuthError(error);
  }
});

organizationRoutes.delete("/members/:user", async (c) => {
  const admin = c.get("admin");
  const actorUserId = sessionActor(admin);
  try {
    const removed = await c.get("operatorAuth").service.removeOrganizationMember({
      actorUserId,
      organizationId: admin.organizationId,
      userId: c.req.param("user"),
    });
    return c.json({ removed });
  } catch (error) {
    rethrowCfAuthError(error);
  }
});

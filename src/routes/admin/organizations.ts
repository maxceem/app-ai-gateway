import type { AuthState } from "@maxceem/cf-auth";
import { Hono, type Context } from "hono";
import { rethrowCfAuthError } from "../../auth/identity";
import { OrganizationSelectRequestSchema } from "../../contracts/schemas";
import type { IdentitySession, OrganizationListResponse } from "../../contracts/responses";
import { GatewayError } from "../../core/errors";
import type { AdminVariables } from "../../middleware/admin";

type OrganizationEnv = { Bindings: Env; Variables: AdminVariables };

/**
 * Identity and organization membership for management clients.
 *
 * These are thin wrappers over `cfAuth.service.*`: every authorization rule
 * already lives in the service, so the routes only translate HTTP into service
 * calls and cf-auth errors into the gateway error envelope.
 */
export const organizationRoutes = new Hono<OrganizationEnv>();

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
function sessionPayload(state: AuthState, admin: AdminVariables["admin"]): IdentitySession["session"] {
  return {
    user: state.user,
    organization: state.organization,
    role: admin.role,
    memberships: state.memberships,
    credentialType: admin.credentialType,
    assurance: state.assurance,
    actor: state.actor,
  };
}

organizationRoutes.get("/session", (c) =>
  c.json({ session: sessionPayload(c.get("authState"), c.get("admin")) } satisfies IdentitySession));

organizationRoutes.get("/organizations", async (c) => {
  try {
    const organizations = await c
      .get("identityAuth")
      .service.listOrganizations(c.get("authState"));
    return c.json({ organizations } satisfies OrganizationListResponse);
  } catch (error) {
    rethrowCfAuthError(error);
  }
});

/**
 * Switches the active organization by re-signing the current-organization
 * cookie. Deliberately exempt from the owner/admin mutation gate in
 * `adminAuth`: a read-only member still has to be able to move between the
 * organizations they belong to.
 *
 * Both this and the listing above hand the whole `authState` to cf-auth rather
 * than a user id: an API key is scoped to one organization, and it is the
 * library's own rule that such a credential may not read or move between the
 * others its owner belongs to.
 */
organizationRoutes.post("/organizations/select", async (c) => {
  const admin = c.get("admin");
  const { organizationId } = schemaBody(
    OrganizationSelectRequestSchema,
    await requestBody(c),
  );

  const identityAuth = c.get("identityAuth");
  try {
    const state = await identityAuth.service.selectOrganization(
      c.get("authState"),
      organizationId,
    );
    await identityAuth.currentOrganizationCookie.write(c, organizationId);
    return c.json({
      session: sessionPayload(state, {
        ...admin,
        organizationId: state.organization?.id ?? admin.organizationId,
        role: state.role ?? admin.role,
      }),
    } satisfies IdentitySession);
  } catch (error) {
    rethrowCfAuthError(error);
  }
});

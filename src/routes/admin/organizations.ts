import type { AuthState } from "@maxceem/cf-auth";
import { Hono } from "hono";
import { rethrowCfAuthError } from "../../auth/identity";
import { OrganizationSelectRequestSchema } from "../../contracts/schemas";
import type { IdentitySession } from "../../contracts/responses";
import { schemaBody } from "../../management/validation";
import { jsonBody } from "./body";
import { catalogRouter } from "../catalog-router";
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
const routes = catalogRouter(organizationRoutes, "/v1/admin");

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

routes.handle("getAdminSession", (c) =>
  ({ session: sessionPayload(c.get("authState"), c.get("admin")) }));

routes.handle("listOrganizations", async (c) => {
  try {
    const organizations = await c
      .get("identityAuth")
      .service.listOrganizations(c.get("authState"));
    return { organizations };
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
routes.handle("selectOrganization", async (c) => {
  const admin = c.get("admin");
  const { organizationId } = schemaBody(OrganizationSelectRequestSchema, await jsonBody(c));

  const identityAuth = c.get("identityAuth");
  try {
    const state = await identityAuth.service.selectOrganization(
      c.get("authState"),
      organizationId,
    );
    await identityAuth.currentOrganizationCookie.write(c, organizationId);
    return {
      session: sessionPayload(state, {
        ...admin,
        organizationId: state.organization?.id ?? admin.organizationId,
        role: state.role ?? admin.role,
      }),
    };
  } catch (error) {
    rethrowCfAuthError(error);
  }
});

import type { AuthState } from "@maxceem/cf-auth";
import { Hono, type Context } from "hono";
import { accountLifecycle } from "../../core/account-lifecycle";
import { accountAccessDenial } from "../../policy/accounts";
import { identityAuthFor } from "../../auth/identity";
import type { IdentitySession } from "../../contracts/responses";
import { adminRouter } from "../catalog-router";
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
const routes = adminRouter(organizationRoutes);

/**
 * The console's identity bootstrap. `GET /v1/auth/get-session` only reports
 * better-auth's user record, which leaves a client unable to tell an owner from
 * a read-only member or to name the organization it is acting in.
 */
async function sessionPayload(
  c: Context<OrganizationEnv>,
  state: AuthState,
  actor: AdminVariables["actor"],
): Promise<IdentitySession["session"]> {
  return {
    user: state.user,
    organization: state.organization,
    role: actor.role,
    memberships: state.memberships,
    credentialType: actor.credentialType,
    assurance: state.assurance,
    actor: state.actor,
    verificationPending: await verificationPending(c, actor.organizationId),
  };
}

/**
 * Whether the account's apps are refused for its owner's unverified email, as
 * a request to one of them would be: the console says so only when it is
 * true, rather than for every unverified sign-in.
 */
async function verificationPending(c: Context<OrganizationEnv>, organizationId: string): Promise<boolean> {
  const deployment = c.get("deployment");
  if (deployment.emailVerification === "off") return false;
  const account = await accountLifecycle(c.env, organizationId);
  return accountAccessDenial(deployment, account, "proxy", Date.now()) === "email_unverified";
}

routes.handle("getAdminSession", async (c) =>
  ({ session: await sessionPayload(c, c.get("authState"), c.get("actor")) }));

routes.handle("listOrganizations", async (c) => {
  const organizations = await (await identityAuthFor(c)).service.listOrganizations(c.get("authState"));
  return { organizations };
});

/**
 * Switches the active organization by re-signing the current-organization
 * cookie. Its catalog entry declares `role: "member"` for exactly that reason:
 * a read-only member still has to be able to move between the organizations
 * they belong to.
 *
 * Both this and the listing above hand the whole `authState` to cf-auth rather
 * than a user id: an API key is scoped to one organization, and it is the
 * library's own rule that such a credential may not read or move between the
 * others its owner belongs to.
 */
routes.handle("selectOrganization", async (c, { actor, body: { organizationId } }) => {
  const identityAuth = await identityAuthFor(c);
  const state = await identityAuth.service.selectOrganization(
    c.get("authState"),
    organizationId,
  );
  await identityAuth.currentOrganizationCookie.write(c, organizationId);
  return {
    session: await sessionPayload(c, state, {
      ...actor,
      organizationId: state.organization?.id ?? actor.organizationId,
      role: state.role ?? actor.role,
    }),
  };
});

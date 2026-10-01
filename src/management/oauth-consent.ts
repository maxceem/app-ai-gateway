/**
 * The OAuth consent page's decisions: what it shows, and the three answers a
 * browser may give an MCP client's authorization request — a signed-in
 * person allows it into one of their accounts, a guest continues without an
 * account, or anyone holding the link denies it.
 *
 * cf-auth decides everything that is a security rule — the proof, the client,
 * the session and membership re-read in the batch that completes the
 * authorization, the code — and answers the redirect the browser is sent to.
 * What is this gateway's is what an account is and who may have one without a
 * person: the guest door is the second door onto unclaimed accounts, beside
 * the CLI's bootstrap, and runs the same admission, the same rate limit and
 * the same provisioning (`./provisioning`).
 */

import type { AuthState, CfAuthOAuth, OrganizationMembership } from "@maxceem/cf-auth";
import { googleAuthEnabled, registrationOpen } from "../auth/identity";
import type { OAuthConsentAllowRequest, OAuthConsentProof } from "../contracts/schemas";
import type {
  OAuthConsentDetailsResponse,
  OAuthConsentRedirectResponse,
} from "../contracts/responses";
import { assertAccountAccess } from "../core/account-lifecycle";
import { GatewayError } from "../core/errors";
import { digest } from "./digest";
import {
  admitUnclaimedAccountCondition,
  limitUnclaimedAccounts,
  unclaimedAccountAvailable,
  unclaimedAccountDecision,
  unclaimedAccountRule,
  unclaimedAccountStatements,
} from "./provisioning";
import type { ManagementScope } from "./scope";

/**
 * The name of the service identity that owns an account created through the
 * consent page: the door's own, as the CLI's bootstrap names its identity.
 */
const GUEST_SERVICE_NAME = "MCP connection";

/**
 * The OAuth service, or the refusal a deployment that runs none answers with:
 * the consent page addresses an authorization that cannot exist there.
 */
async function oauthService(scope: ManagementScope): Promise<CfAuthOAuth> {
  const identity = await scope.identity();
  if (identity.config.oauth === null) throw new GatewayError(404, "not_found", "Page was not found");
  return identity.oauth;
}

/** The accounts a person may connect a client to: every active membership in a live account. */
function usableAccounts(memberships: readonly OrganizationMembership[], now: number) {
  return memberships
    .filter(({ organization, status }) => {
      if (status !== "active") return false;
      const expiresAt = organization.expiresAt === null ? null : Date.parse(organization.expiresAt);
      return expiresAt === null || expiresAt > now;
    })
    .map(({ organization, role }) => ({ id: organization.id, name: organization.name, role }));
}

/**
 * What the consent page shows, for the holder of the browser proof. `viewer`
 * is the session this browser holds, or null; cf-auth names only an
 * interactive human session, so a key or a token is shown as nobody.
 *
 * Whether the guest door is offered is the deployment's admission, read
 * without counting anything, so the button a person is offered and the answer
 * pressing it gets agree — the rate limit aside, which only answers once it
 * is spent.
 */
export async function oauthConsentDetails(
  scope: ManagementScope,
  viewer: AuthState | null,
  id: string,
  { submissionToken }: OAuthConsentProof,
): Promise<OAuthConsentDetailsResponse> {
  const oauth = await oauthService(scope);
  const details = await oauth.authorizationDetails({ id, proof: submissionToken, viewer });
  const now = Date.now();
  const accounts = details.viewer ? usableAccounts(details.viewer.memberships, now) : [];
  const guestAvailable = await unclaimedAccountAvailable(scope);
  return {
    id: details.id,
    state: details.state,
    client: {
      id: details.client.id,
      // Untrusted: the client's own claim, trimmed and bounded by cf-auth and
      // never interpreted here. The page renders it as text.
      name: details.client.name,
      domain: details.client.domain,
      source: details.client.source,
    },
    redirectHost: details.redirectHost,
    requestedGrant: details.requestedGrant,
    expiresAt: details.expiresAt,
    viewer: details.viewer
      ? { name: details.viewer.user.name, email: details.viewer.user.email }
      : null,
    accounts,
    blockedBy: details.viewer === null
      ? "registration_required"
      : accounts.length === 0
        ? "no_eligible_organization"
        : null,
    guestAvailable,
    guestExpiresAt: guestAvailable
      ? unclaimedAccountDecision(scope, { requestHash: "", nowMs: now }).recoveryEndsAt
      : null,
    googleEnabled: googleAuthEnabled(scope.env),
    registrationOpen: await registrationOpen(scope.deployment, scope.env),
  };
}

/**
 * A signed-in person allows the client into one of their accounts, with the
 * grant they chose. The account has to be one they belong to and one whose
 * standing still admits reading it, as a claim's approval checks; cf-auth
 * then re-reads the session, the membership and the deadline in the batch
 * that completes the authorization.
 */
export async function allowOauthConsent(
  scope: ManagementScope,
  state: AuthState,
  id: string,
  { submissionToken, organizationId, grant }: OAuthConsentAllowRequest,
): Promise<OAuthConsentRedirectResponse> {
  const oauth = await oauthService(scope);
  // Asked before the account's standing, so a person learns nothing about an
  // account they do not belong to.
  if (!state.memberships.some(({ organization }) => organization.id === organizationId))
    throw new GatewayError(403, "not_a_member", "Choose one of your own accounts");
  await assertAccountAccess(scope.deployment, scope.env, organizationId, "read");
  return oauth.approveAuthorization({ id, proof: submissionToken, actor: state, organizationId, grant });
}

/**
 * "Continue without an account": an unclaimed account, created in the batch
 * that completes the authorization, connected with the `manage` grant.
 *
 * In cf-auth's order, which is the bootstrap's: the deployment's admission,
 * whose refusal spends nothing; then the per-address limit the CLI's
 * bootstrap counts under too, keyed on this browser's address; then the
 * account's rows, every one conditioned on the guard cf-auth hands over — the
 * admission it judged and latched once, as the batch's first write, and never
 * judges again, since the account itself is what makes an emptiness rule
 * false. The ids are derived from the authorization's own, so a retry names
 * the same rows; an authorization already completed answers its redirect
 * before any of this runs.
 */
export async function continueOauthWithoutAccount(
  scope: ManagementScope,
  id: string,
  { submissionToken }: OAuthConsentProof,
  address: string,
): Promise<OAuthConsentRedirectResponse> {
  const oauth = await oauthService(scope);
  const rule = unclaimedAccountRule(scope);
  const { redirect } = await oauth.approveGuestAuthorization({
    id,
    proof: submissionToken,
    admit: () => admitUnclaimedAccountCondition(scope, rule),
    rateLimit: () => limitUnclaimedAccounts(scope, rule, address),
    provision: async (ctx) => {
      const decision = unclaimedAccountDecision(scope, {
        requestHash: await digest(ctx.operationId),
        nowMs: ctx.now,
      });
      return {
        userId: decision.userId,
        organizationId: decision.accountId,
        statements: unclaimedAccountStatements(scope, decision, {
          guard: ctx.guard,
          admission: null,
          serviceName: GUEST_SERVICE_NAME,
        }),
      };
    },
  });
  return { redirect };
}

/** Anyone holding the link declines: the client is told `access_denied`. */
export async function denyOauthConsent(
  scope: ManagementScope,
  id: string,
  { submissionToken }: OAuthConsentProof,
): Promise<OAuthConsentRedirectResponse> {
  const oauth = await oauthService(scope);
  return oauth.denyAuthorization({ id, proof: submissionToken });
}

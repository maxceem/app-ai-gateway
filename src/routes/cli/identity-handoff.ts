import { createIdentityAuth, rethrowCfAuthError } from "../../auth/identity";
import { invalidateBillingRequestAccess } from "../../billing/gateway";
import {
  assertAccountAccess,
  invalidateAccountLifecycle,
} from "../../core/account-lifecycle";
import { GatewayError } from "../../core/errors";
import { authState } from "./operations";
import type { CliApprovalRefusal } from "../../contracts/cli";
import type { AuthState } from "@maxceem/cf-auth";
import type { CliContext, HandoffRow } from "./types";

/**
 * Why this browser cannot approve a claim on `organizationId`, or null when it
 * can.
 *
 * Asked of memberships rather than of the session, because the three cases that
 * decide it are all about what a human already owns: Google consent can sign
 * someone in as a human who exists already, a human with no membership at all
 * (registered for a claim that then expired) may legitimately sign in and
 * claim, and a claim that already landed has to stay re-approvable, which is
 * why the account being claimed is excluded from the count.
 */
export function claimRefusal(
  state: AuthState,
  organizationId: string,
): CliApprovalRefusal | null {
  if (
    state.assurance !== "interactive" ||
    state.user?.kind !== "human" ||
    !state.actor?.credentialId
  )
    return "session_required";
  if (state.memberships.some((member) => member.organization.id !== organizationId))
    return "account_exists";
  return null;
}

/** Claim is the sole interactive identity handoff. It never fabricates a key session. */
export async function completeIdentity(
  c: CliContext,
  row: HandoffRow,
): Promise<void> {
  if (row.kind !== "claim")
    throw new GatewayError(400, "invalid_request", "Unsupported identity handoff");
  const state = await authState(c, true);
  const refusal = claimRefusal(state, row.organization_id);
  const approver = state.user;
  if (refusal === "session_required" || !approver)
    throw new GatewayError(
      401,
      "session_required",
      "Sign in as a person before approving this request",
    );
  if (refusal === "account_exists")
    throw new GatewayError(
      403,
      "account_exists",
      "This sign-in already has an account; sign out and create a new sign-in to claim this one",
    );

  const target = row.organization_id;
  await assertAccountAccess(c.env, target, "claim");

  // Every row this moves — the owner membership, the account's deadline, the
  // service identity's key — belongs to cf-auth, so cf-auth moves them, in one
  // transaction guarded by its own re-read of this session and of the CLI
  // credential that asked for the claim.
  //
  // Ordered before the handoff is consumed, not inside it, because the two
  // failures are not equally recoverable: a claim that landed can simply be
  // approved again, since claiming settles on the same owner rather than
  // refusing, while a request consumed without a claim could never be retried.
  try {
    await createIdentityAuth(c.env, c.req.url, {
      suppressDefaultOrganization: true,
    }).service.claimOrganization({
      actor: state,
      organizationId: target,
      provisioning: {
        userId: row.initiating_user_id,
        credentialId: row.initiating_credential_id,
        // A claim never retires the CLI that asked for it: the person approving
        // is at their terminal mid-command, and an approval that logged them
        // out of it would be a worse answer than anything it could protect
        // against. Retiring that access is the console's job, afterwards.
        revokeAccess: false,
      },
    });
  } catch (error) {
    rethrowCfAuthError(error);
  }

  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE mgmt_handoff SET consumed_at=?,outcome=?,updated_at=?
       WHERE id=? AND kind='claim' AND consumed_at IS NULL AND expires_at>?`,
    ).bind(
      now,
      JSON.stringify({ accountId: target, approvedBy: approver.id }),
      now,
      row.id,
      now,
    ),
    // Bootstrap authority ends with the claim: the encrypted credential the
    // poller would otherwise collect goes with it.
    c.env.DB.prepare(
      `UPDATE mgmt_resource_receipt SET consumed_at=?,protected_credential=NULL,
       protected_credential_expires_at=NULL,updated_at=?
       WHERE kind='bootstrap' AND organization_id=? AND consumed_at IS NULL`,
    ).bind(now, now, target),
  ]);
  const completed = await c.env.DB.prepare("SELECT consumed_at FROM mgmt_handoff WHERE id=?")
    .bind(row.id)
    .first<{ consumed_at: number | null }>();
  if (!completed?.consumed_at)
    throw new GatewayError(
      409,
      "conflict",
      "Operation could not be approved; create a fresh request",
    );
  // The account now has a human owner and no deadline. Both are read from
  // caches keyed on this account, and a claim only ever widens what they allow.
  invalidateAccountLifecycle(target);
  invalidateBillingRequestAccess(target, c.get("billingRequestCache"));
}

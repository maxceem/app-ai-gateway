import { identityAuthFor } from "../../auth/identity";
import { invalidateBillingAccess } from "../../billing/gateway";
import {
  assertAccountAccess,
  invalidateAccountLifecycle,
} from "../../core/account-lifecycle";
import { GatewayError } from "../../core/errors";
import { operationKind } from "./operation-kinds";
import { authState, completeStatement, operationRow } from "./operations";
import type { CliApprovalRefusal } from "../../contracts/cli";
import type { AuthState } from "@maxceem/cf-auth";
import type { CliContext, OperationRow } from "./types";

/**
 * What has to happen before this browser may claim `organizationId`, or null
 * when nothing does.
 *
 * Asked of memberships rather than of the session, because the three cases that
 * decide it are all about what a person already owns: Google consent can sign
 * someone in as a person who exists already, a person with no membership at all
 * (registered for a claim that then expired) may legitimately go on and claim,
 * and a claim that already landed has to stay re-approvable, which is why the
 * account being claimed is excluded from the count.
 *
 * The answer names a remedy rather than a cause, because it is the whole of
 * what the approval page is told. Registering is the remedy for having no
 * session here, not signing in: a claim is taken by a person who does not have
 * an account yet, so the door that admits people who already have one is the
 * door this rule exists to shut.
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
    return "registration_required";
  if (state.memberships.some((member) => member.organization.id !== organizationId))
    return "sign_out_required";
  return null;
}

/** Claim is the sole interactive identity operation. It never fabricates a key session. */
export async function completeIdentity(
  c: CliContext,
  row: OperationRow,
): Promise<void> {
  const kind = operationKind(row.kind);
  if (kind.type !== "claim" || !row.organization_id || !row.initiating_user_id || !row.initiating_credential_id)
    throw new GatewayError(400, "invalid_request", "Unsupported identity operation");
  const state = await authState(c, true);
  const refusal = claimRefusal(state, row.organization_id);
  const approver = state.user;
  // The refusal names what a person must do; the status names why the request
  // failed. Two audiences, one decision, translated in this one place.
  if (refusal === "registration_required" || !approver)
    throw new GatewayError(
      401,
      "session_required",
      "Create a sign-in on the approval page before approving this request",
    );
  if (refusal === "sign_out_required")
    throw new GatewayError(
      403,
      "account_exists",
      "This sign-in already has an account; sign out and create a new sign-in to claim this one",
    );

  const target = row.organization_id;
  await assertAccountAccess(c.get("deployment"), c.env, target, kind.open);

  // Every row this moves — the owner membership, the account's deadline, the
  // service identity's key — belongs to cf-auth, so cf-auth moves them, in one
  // transaction guarded by its own re-read of this session and of the CLI
  // credential that asked for the claim.
  //
  // Ordered before the operation is completed, not inside it, because the two
  // failures are not equally recoverable: a claim that landed can simply be
  // approved again, since claiming settles on the same owner rather than
  // refusing, while an operation completed without a claim could never be
  // retried.
  await (await identityAuthFor(c, { suppressDefaultOrganization: true }))
    .service.claimOrganization({
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

  const now = Date.now();
  await c.env.DB.batch([
    // Unguarded by `changes()`, unlike a resource write's: the claim landed
    // before this batch was built, so there is no preceding write in it for
    // the completion to ride on. A claim that is already complete stays so.
    completeStatement(
      c.env.DB,
      row,
      { outcome: JSON.stringify({ accountId: target, approvedBy: approver.id }), sealed: null, sealedUntil: null },
      now,
    ),
    // Bootstrap authority ends with the claim: the sealed credential the CLI
    // could otherwise collect goes with it.
    c.env.DB.prepare(
      `UPDATE mgmt_operation SET state='retired',sealed_outcome=NULL,sealed_until=NULL,updated_at=?
       WHERE kind='bootstrap' AND organization_id=? AND state='completed'`,
    ).bind(now, target),
  ]);
  if ((await operationRow(c.env.DB, row.id))?.state !== "completed")
    throw new GatewayError(409, "conflict", "Operation could not be approved; create a fresh request");
  // The account now has a human owner and no deadline. Both are read from
  // caches keyed on this account, and a claim only ever widens what they allow.
  invalidateAccountLifecycle(target);
  invalidateBillingAccess(target, c.get("billingRequestCache"));
}

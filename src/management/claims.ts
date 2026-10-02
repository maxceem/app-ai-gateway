import type { AuthState, CfAuthOperations, OperationView } from "@maxceem/cf-auth";
import { assertAccountAccess } from "../core/account-lifecycle";
import { enforceEndpointRateLimit } from "../core/endpoint-rate-limit";
import { GatewayError } from "../core/errors";
import type { Actor } from "./actor";
import { approvalUrl } from "./operation-links";
import type { ManagementScope } from "./scope";

/** A claim as it stands once asked for, and the link that approves it while it is pending. */
export interface OpenedClaim {
  view: OperationView;
  /** Null once the claim is no longer pending, or its link's proof has been spent. */
  url: string | null;
}

/**
 * Asks for an unclaimed account to be settled on a person, or answers again
 * for the claim this token already asked for.
 *
 * A claim is opened under the caller's own authority over the account — a
 * credential, never an operation's proof — and completed only by an eligible
 * person approving it in a browser, who becomes the account's owner. Asking
 * needs read access, so an unclaimed account whose free window has closed can
 * still be claimed, and is refused once a person owns it. A new token is
 * counted against the account's operation limit; a resend is answered as a
 * poll would be, whatever the count, so a caller that lost its answer is never
 * locked out of the claim it is waiting on.
 *
 * `engine` is cf-auth's operation engine for the request, and `opener` the
 * cf-auth state the caller authenticated with, which the engine binds the
 * claim to; `id` is the id the caller derived from `token`.
 */
export async function openClaim(
  scope: ManagementScope,
  actor: Actor,
  opener: AuthState,
  engine: CfAuthOperations,
  { token, id }: { token: string; id: string },
): Promise<OpenedClaim> {
  if (actor.credentialId === null) {
    throw new GatewayError(403, "forbidden", "Account administration is required");
  }
  const account = await assertAccountAccess(scope.deployment, scope.env, actor.organizationId, "read");
  if (account.claimed) {
    throw new GatewayError(409, "conflict", "Account is already claimed");
  }
  if (!(await engine.findByToken({ token })))
    await enforceEndpointRateLimit(scope.env, "operation", actor.organizationId);
  const view = await engine.open({ id, kind: "claim", token, opener });
  return { view, url: view.state === "pending" ? approvalUrl(scope.deployment, view) : null };
}

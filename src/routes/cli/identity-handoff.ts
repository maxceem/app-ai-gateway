/**
 * The two browser steps that ask who is holding the browser: a claim, which
 * settles an unowned account on the person approving it, and a login, which
 * gives a CLI a key of its own in one of the approver's accounts. Both are
 * approved through cf-auth's operation engine; what this file decides is who
 * may press the button, and what the answer to pressing it says.
 */

import { sql } from "drizzle-orm";
import type { AuthState, OperationBrowserCredential, OperationDetails } from "@maxceem/cf-auth";
import { claimRefusal } from "../../auth/operation-kinds";
import { engineRefused, identityAuthFor } from "../../auth/identity";
import { invalidateBillingAccess } from "../../billing/gateway";
import {
  assertAccountAccess,
  invalidateAccountLifecycle,
} from "../../core/account-lifecycle";
import { GatewayError } from "../../core/errors";
import { log } from "../../core/log";
import type { CliApprovalRefusal, CliLoginOrganization } from "../../contracts/cli";
import { prepared } from "../../db/sql";
import { shouldProvisionDefaultOrganization } from "../../policy/deployment";
import { authState, operationEngine } from "./operations";
import type { ClaimKind, LoginKind } from "./operation-kinds";
import type { CliContext } from "./types";

/** Whether this browser holds an interactive human session, which approving either kind needs. */
function interactiveHuman(state: AuthState): boolean {
  return (
    state.authenticated
    && state.assurance === "interactive"
    && state.credentialType === "session"
    && state.user?.kind === "human"
    && Boolean(state.actor?.credentialId)
  );
}

/** The accounts a login's approver may log a CLI in to: every live membership. */
export function loginOrganizations(state: AuthState): CliLoginOrganization[] {
  if (!interactiveHuman(state)) return [];
  const now = Date.now();
  return state.memberships
    .filter(({ organization }) => {
      const expiresAt = organization.expiresAt === null ? null : Date.parse(organization.expiresAt);
      return expiresAt === null || expiresAt > now;
    })
    .map(({ organization, role }) => ({ id: organization.id, name: organization.name, role }));
}

/**
 * Whether approving a login gives a person who belongs to no account one of
 * their own, as registering on this deployment would. Where it does not, such
 * a person has nowhere to log a CLI in to.
 */
export function provisionsDefaultAccount(c: CliContext): boolean {
  return shouldProvisionDefaultOrganization(c.get("deployment"), {
    claimRegistration: false,
    suppressDefaultOrganization: false,
    provisionRegistration: false,
  });
}

/**
 * What stands between this browser and approving a claim or a login — the
 * engine's verdict for the viewer, from its kind's `refusal` — in the page's
 * vocabulary.
 *
 * A claim's verdicts are the page's own. A login's are translated: nobody
 * signed in is the claim's `registration_required`, the approval page's one
 * way in, whose refusal of a taken email offers signing in. Belonging to other
 * accounts is no obstacle — a login is how a person who has accounts lets a CLI
 * into one — and belonging to none is one only where this deployment would not
 * give that person an account of their own when they approve.
 */
export function pageRefusal(c: CliContext, verdict: string | null): CliApprovalRefusal | null {
  switch (verdict) {
    case null:
      return null;
    case "registration_required":
    case "sign_out_required":
      return verdict;
    case "session_required":
      return "registration_required";
    case "no_eligible_organization":
      return provisionsDefaultAccount(c) ? null : "no_eligible_organization";
    default:
      // A verdict this gateway has not learned yet — a newer library's, say —
      // still leaves the page something to show: sign in as someone who may
      // approve. Only the code is logged, which names no person or operation.
      log("warn", "approval_refusal_unknown", { verdict });
      return "registration_required";
  }
}

/** Claim is the sole interactive identity operation that takes an account over. It never fabricates a key session. */
export async function approveClaim(
  c: CliContext,
  details: OperationDetails,
  entry: ClaimKind,
  credential: OperationBrowserCredential,
): Promise<void> {
  const target = details.organization?.id;
  if (!target) throw new GatewayError(500, "internal_error", "A stored operation does not match its kind");
  const state = await authState(c, true);
  const refusal = claimRefusal(state, target);
  // The refusal names what a person must do; the status names why the request
  // failed. Two audiences, one decision, translated in this one place.
  if (refusal === "registration_required")
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
  await assertAccountAccess(c.get("deployment"), c.env, target, entry.open);

  const engine = await operationEngine(c);
  try {
    // The claim kind's approval is cf-auth's `claimOrganization`, run before
    // the engine completes the operation under its own re-read of this session
    // and of the CLI credential that asked; see `src/auth/operation-kinds.ts`.
    await engine.approve({ id: details.id, ...credential, actor: state });
  } catch (error) {
    if (!engineRefused(error, "already_completed")) throw error;
    // Approving a claim that already landed, for the owner it landed on, is a
    // retry a dropped connection provokes: it is answered as approved. For
    // anyone else it is a claim somebody else took. A claim settles its
    // account on its approver as owner, so owning it now — read afresh, since
    // this call's own claim may be what just landed — is who approved it.
    const current = await authState(c, true);
    const owner = current.user?.id === state.user?.id
      && current.memberships.some(({ organization, role }) => organization.id === target && role === "owner");
    if (!owner) throw new GatewayError(409, "conflict", "This account has already been claimed by someone else");
  }
  // Bootstrap authority ends with the claim, and the credential the engine
  // still holds sealed for it goes with it. A bootstrap is refused for a
  // claimed account whatever its record says, so this is tidiness rather than
  // the guard, and it may follow the claim rather than share its batch. A
  // bootstrap is opened by nobody, so it names its account only in its record;
  // the engine offers no way to find an operation by what its record holds.
  const bootstraps = await prepared(c.env.DB, sql`SELECT id FROM mgmt_operation
    WHERE kind='bootstrap' AND state='completed' AND json_extract(outcome,'$.accountId')=${target}`)
    .all<{ id: string }>();
  for (const { id } of bootstraps.results) await engine.retire({ id });
  // The account now has a human owner and no deadline. Both are read from
  // caches keyed on this account, and a claim only ever widens what they allow.
  invalidateAccountLifecycle(target);
  invalidateBillingAccess(target, c.get("billingRequestCache"));
}

/**
 * Approves a login into the account its approver picked.
 *
 * `organizationId` may be left out by a person who belongs to exactly one. A
 * person who belongs to none is given one first, where this deployment gives
 * every new person one; otherwise there is nowhere to log the CLI in to. The
 * engine mints the key, owned by the approver, in the batch that completes the
 * login, under a guard that re-reads their session and membership.
 */
export async function approveLogin(
  c: CliContext,
  details: OperationDetails,
  entry: LoginKind,
  credential: OperationBrowserCredential,
  organizationId: string | undefined,
): Promise<{ redirectUrl: string | null }> {
  let state = await authState(c, true);
  if (!interactiveHuman(state))
    throw new GatewayError(
      401,
      "session_required",
      "Sign in on the approval page before approving this request",
    );
  if (loginOrganizations(state).length === 0 && provisionsDefaultAccount(c)) {
    // The instance that provisions, as registration on this deployment would.
    state = await (await identityAuthFor(c)).service.ensureDefaultOrganization(state);
  }
  const organizations = loginOrganizations(state);
  if (organizations.length === 0)
    throw new GatewayError(
      403,
      "no_eligible_organization",
      "This sign-in belongs to no account a CLI can be logged in to",
    );
  const chosen = organizationId ?? (organizations.length === 1 ? organizations[0]!.id : undefined);
  if (chosen === undefined)
    throw new GatewayError(400, "invalid_request", "Choose which account to log the CLI in to");
  if (!organizations.some((organization) => organization.id === chosen))
    throw new GatewayError(403, "not_a_member", "This sign-in does not belong to that account");
  await assertAccountAccess(c.get("deployment"), c.env, chosen, entry.open);

  try {
    const approval = await (await operationEngine(c)).approve({
      id: details.id,
      ...credential,
      actor: state,
      organizationId: chosen,
    });
    return { redirectUrl: approval.redirectUrl };
  } catch (error) {
    // Pressing Approve twice: the first landed, and the CLI has its answer.
    if (engineRefused(error, "already_completed")) return { redirectUrl: null };
    throw error;
  }
}

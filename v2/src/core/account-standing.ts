/**
 * Whether an account may serve application traffic yet: v1's account gate,
 * for the one rule v2 keeps (owner, 2026-11-19: there are no unclaimed
 * accounts in v2, so no deadlines).
 *
 * Every account serves, except one whose every active owner has an address
 * marked as waiting (`email_pending_verification`) and not verified yet. The
 * mark is written, by address, only when a password sign-up happens while the
 * deployment verifies addresses, and before the person or their account
 * exists (`../auth/identity.ts`): so no account is ever visible unmarked first.
 * Confirming the link removes it (`../auth/email-verification.ts`), and any
 * other way the address becomes verified, such as a linked Google sign-in,
 * clears the gate too. So turning email verification on later refuses no
 * account that served before, and an account made by
 * `scripts/management-key.ts --create-account`, whose owner is a key, never
 * waits. A deployment that does not verify email never asks.
 *
 * On the request path the answer costs no read of its own: it is read in the
 * same D1 query that loads the app, and cached with it
 * (`../apps/app-records.ts`, {@link accountPendingSql}). Only the console's
 * session asks for it alone ({@link readAccountPending}).
 *
 * Reading and configuring an account never waits for this: everything can be
 * set up before the link is clicked. Only app traffic does: provider requests,
 * the app sign-in calls and `/me`.
 */
import { emailSetup } from "../email/sender.ts";
import { GatewayError } from "./errors.ts";

/**
 * Whether this deployment verifies people's email addresses: wherever it is
 * set up to send email, even where that setup is not complete yet.
 */
export function emailVerificationRequired(env: Env): boolean {
  return emailSetup(env).state !== "off";
}

/** SQL true when the owner row `u` has an address marked as waiting and not verified. Served by the mark table's key. */
const OWNER_WAITING = `u.email_verified = 0 AND EXISTS (SELECT 1 FROM email_pending_verification p WHERE p.email = lower(u.email))`;

/**
 * SQL true when the account named by `account` (a SQL expression, such as a
 * column or a `?1`) is waiting for its owner's address: it has an active
 * owner waiting, and none that is not. Served by the membership's account
 * index, the person's key and the mark table's key.
 */
export function accountPendingSql(account: string): string {
  const owners = `FROM mgmt_organization_user m JOIN mgmt_user u ON u.id = m.user_id
    WHERE m.organization_id = ${account} AND m.role = 'owner' AND m.status = 'active'`;
  return `(EXISTS (SELECT 1 ${owners} AND ${OWNER_WAITING}) AND NOT EXISTS (SELECT 1 ${owners} AND NOT (${OWNER_WAITING})))`;
}

/** Whether the account is marked as waiting, read now: for the console's session, never the request path. */
export async function readAccountPending(env: Env, accountId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT ${accountPendingSql("?1")} AS pending`).bind(accountId).first<{ pending: number }>();
  return Boolean(row?.pending);
}

/**
 * Refuses app traffic for an account still waiting for its owner's address,
 * where the deployment verifies addresses. `pending` is what the app's own
 * read found, so this costs nothing.
 */
export function assertAccountServes(env: Env, pending: boolean): void {
  if (!pending || !emailVerificationRequired(env)) return;
  throw new GatewayError(
    403,
    "email_unverified",
    "This account's owner has not verified their email address yet. Open the link in the "
      + "verification email, or send a new one from the console, and requests will be served.",
  );
}

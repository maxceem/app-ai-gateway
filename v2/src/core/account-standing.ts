/**
 * Whether an account may serve application traffic yet: v1's account gate,
 * for the one rule v2 keeps (owner, 2026-11-19: there are no unclaimed
 * accounts in v2, so no deadlines). Where the deployment verifies email, an
 * account serves requests once an owner has verified their address, or once
 * it was activated without one (`account_activation`). A deployment that does
 * not verify email never asks, and this costs it nothing.
 *
 * On the request path the answer costs no read of its own: it is read in the
 * same D1 query that loads the app, and cached with it
 * (`../apps/app-records.ts`, {@link accountActivatedSql}). Only the console's
 * session asks for it alone ({@link readAccountActivated}).
 *
 * The answer only ever goes from "not yet" to "yes": an owner's verified email
 * is never unverified, and an activation row is never removed from a live
 * account. So a cached "yes" is kept as long as the app is, and a stale "not
 * yet" can only refuse for a moment longer, never admit.
 *
 * Reading and configuring an account never waits for this: everything can be
 * set up before the link is clicked. Only app traffic does: provider requests,
 * the app sign-in calls and `/me`.
 */
import { emailSetup } from "../email/sender.ts";
import { GatewayError } from "./errors.ts";

/**
 * Whether this deployment verifies people's email addresses: wherever it is
 * set up to send email, even where that setup is not complete yet. An account
 * made then still waits for its owner's address, and sign-up says so
 * (`../management/identity-routes.ts`), so fixing the setup later lets nobody
 * past the gate unverified.
 */
export function emailVerificationRequired(env: Env): boolean {
  return emailSetup(env).state !== "off";
}

/**
 * SQL true when the account named by `account` (a SQL expression, such as a
 * column or a `?1`) is activated: an activation row, or an owner who is a
 * person with a verified address. Served by the activation table's key and
 * the membership index.
 */
export function accountActivatedSql(account: string): string {
  return `(EXISTS (SELECT 1 FROM account_activation a WHERE a.account_id = ${account})
  OR EXISTS (
    SELECT 1 FROM mgmt_organization_user m JOIN mgmt_user u ON u.id = m.user_id
    WHERE m.organization_id = ${account} AND m.role = 'owner' AND m.status = 'active'
      AND u.kind = 'human' AND u.email_verified = 1
  ))`;
}

/** Whether the account is activated, read now: for the console's session, never the request path. */
export async function readAccountActivated(env: Env, accountId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT ${accountActivatedSql("?1")} AS activated`).bind(accountId).first<{ activated: number }>();
  return Boolean(row?.activated);
}

/**
 * Refuses app traffic for an account whose owner has not verified their
 * address yet, where the deployment verifies addresses. `activated` is what the
 * app's own read found, so this costs nothing.
 */
export function assertAccountServes(env: Env, activated: boolean): void {
  if (activated || !emailVerificationRequired(env)) return;
  throw new GatewayError(
    403,
    "email_unverified",
    "This account's owner has not verified their email address yet. Open the link in the "
      + "verification email, or send a new one from the console, and requests will be served.",
  );
}

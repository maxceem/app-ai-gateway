/**
 * Whether an account may serve application traffic yet: v1's account gate,
 * for the one rule v2 keeps (owner, 2026-11-19: there are no unclaimed
 * accounts in v2, so no deadlines). Where the deployment sends email, an
 * account serves requests once an owner has verified their address, or once
 * it was activated without one (`account_activation`). A deployment that
 * sends no email never asks, and this costs it nothing.
 *
 * The answer only ever goes from "not yet" to "yes": an owner's verified email
 * is never unverified, and an activation row is never removed from a live
 * account. So it is cached per isolate for a short while, and a stale entry
 * can only refuse for a moment longer, never admit. The isolate that verifies
 * an address drops its own entries ({@link invalidateAccountStanding}); every
 * other isolate catches up within the cache's ten seconds.
 *
 * Reading and configuring an account never waits for this: everything can be
 * set up before the link is clicked. Only app traffic does: provider requests,
 * the app sign-in calls and `/me`.
 */
import { emailSetup } from "../email/sender.ts";
import { GatewayError } from "./errors.ts";
import { readOrKnown } from "./stale-read.ts";
import { ttlCache } from "./ttl-cache.ts";

/** Whether this deployment verifies people's email addresses: wherever it is set up to send email. */
export function emailVerificationRequired(env: Env): boolean {
  return emailSetup(env).state !== "off";
}

const STANDING_CACHE_TTL_MS = 10_000;

/** Keyed by account ids that came out of D1, so not attacker-growable. */
export const accountStandingCache = ttlCache<string, boolean>({
  name: "account-standing",
  ttlMs: STANDING_CACHE_TTL_MS,
  maxEntries: 5_000,
});

export function invalidateAccountStanding(accountId: string): void {
  accountStandingCache.delete(accountId);
}

/**
 * SQL true when the account named by the `?` it is bound with is activated:
 * an activation row, or an owner who is a person with a verified address.
 */
export const ACCOUNT_ACTIVATED_SQL = `(EXISTS (SELECT 1 FROM account_activation a WHERE a.account_id = ?1)
  OR EXISTS (
    SELECT 1 FROM mgmt_organization_user m JOIN mgmt_user u ON u.id = m.user_id
    WHERE m.organization_id = ?1 AND m.role = 'owner' AND m.status = 'active'
      AND u.kind = 'human' AND u.email_verified = 1
  ))`;

async function readActivated(env: Env, accountId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT ${ACCOUNT_ACTIVATED_SQL} AS activated`).bind(accountId).first<{ activated: number }>();
  const activated = Boolean(row?.activated);
  accountStandingCache.set(accountId, activated);
  return activated;
}

/** Whether the account is activated, through the short cache; a D1 stall serves the last answer. */
export async function accountActivated(env: Env, accountId: string): Promise<boolean> {
  const cached = accountStandingCache.get(accountId);
  if (cached !== undefined) return cached;
  return readOrKnown("account", accountStandingCache.peek(accountId), () => readActivated(env, accountId));
}

/**
 * Refuses app traffic for an account whose owner has not verified their
 * address yet, where the deployment verifies addresses. A read that cannot
 * finish refuses too: the request is never served unchecked.
 */
export async function assertAccountServes(env: Env, accountId: string): Promise<void> {
  if (!emailVerificationRequired(env)) return;
  if (await accountActivated(env, accountId)) return;
  throw new GatewayError(
    403,
    "email_unverified",
    "This account's owner has not verified their email address yet. Open the link in the "
      + "verification email, or send a new one from the console, and requests will be served.",
  );
}

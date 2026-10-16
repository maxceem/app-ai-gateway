import type { DeploymentRules, EmailVerification } from "./deployment";

/**
 * How long an account nobody has claimed may serve traffic and change
 * resources. The gateway's own window, unrelated to any trial the billing
 * service runs.
 */
export const UNCLAIMED_ACCESS_MS = 30 * 86_400_000;
export const ACCOUNT_RECOVERY_MS = 90 * 86_400_000;

export interface AccountLifecycle {
  id: string;
  name: string;
  createdAt: string;
  claimed: boolean;
  /** The recovery deadline a cloud bootstrap sets, cleared when a human claims. */
  expiresAt: string | null;
  /**
   * Whether the account may serve application traffic where email has to be
   * verified: an owner has verified their address, or the account is activated
   * without one (`account_activation`). Only ever goes from false to true.
   */
  activated: boolean;
}

export type AccountAccessMode = "read" | "setup" | "proxy";
export type AccountAccessDenial = "account_expired" | "unclaimed_access_expired" | "email_unverified";

/** D1 defaults omit a zone; ISO values already carry one. Invalid stored values stay invalid. */
export function accountInstant(value: string): number | null {
  const parsed = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

export function accountUnclaimed<Account extends Pick<AccountLifecycle, "claimed" | "expiresAt">>(
  account: Account,
): account is Account & { expiresAt: string } {
  return !account.claimed && account.expiresAt !== null;
}

/** The single calculation used by lifecycle enforcement, quota periods and bootstrap output. */
export function unclaimedAccessDeadline(createdAt: string): number | null {
  const created = accountInstant(createdAt);
  return created === null ? null : created + UNCLAIMED_ACCESS_MS;
}

/** Whether this access runs out with an unclaimed account's free window. */
export function requiresUnclaimedAccess(
  rules: DeploymentRules,
  accessMode: AccountAccessMode,
): boolean {
  return rules.accountDeadlines && (accessMode === "setup" || accessMode === "proxy");
}

/**
 * Whether this access waits for a verified email: only application traffic,
 * and only where the deployment verifies addresses. Reading and configuring an
 * account never does, so everything can be set up before the link is clicked.
 */
export function requiresVerifiedEmail(
  emailVerification: EmailVerification,
  accessMode: AccountAccessMode,
): boolean {
  return emailVerification === "required" && accessMode === "proxy";
}

export function accountAccessDenial(
  policy: { rules: DeploymentRules; emailVerification: EmailVerification },
  account: AccountLifecycle,
  accessMode: AccountAccessMode,
  nowMs: number,
): AccountAccessDenial | null {
  const { rules } = policy;
  if (!accountUnclaimed(account)) {
    // An account nobody owns yet is under the unclaimed rules alone: it is a
    // claim, which waits for a verified email itself, that brings it here.
    return account.claimed
      && !account.activated
      && requiresVerifiedEmail(policy.emailVerification, accessMode)
      ? "email_unverified"
      : null;
  }
  const recoveryDeadline = accountInstant(account.expiresAt);
  if (recoveryDeadline === null || recoveryDeadline <= nowMs) return "account_expired";
  if (requiresUnclaimedAccess(rules, accessMode)) {
    const trialDeadline = unclaimedAccessDeadline(account.createdAt);
    if (trialDeadline === null || trialDeadline <= nowMs) return "unclaimed_access_expired";
  }
  return null;
}

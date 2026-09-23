import type { DeploymentMode } from "./deployment";

export const ACCOUNT_TRIAL_MS = 30 * 86_400_000;
export const ACCOUNT_RECOVERY_MS = 90 * 86_400_000;

export interface AccountLifecycle {
  id: string;
  name: string;
  createdAt: string;
  claimed: boolean;
  /** The recovery deadline a cloud bootstrap sets, cleared when a human claims. */
  expiresAt: string | null;
}

export type AccountAccessMode = "read" | "setup" | "proxy";
export type AccountAccessDenial = "account_expired" | "billing_trial_expired";

/** D1 defaults omit a zone; ISO values already carry one. Invalid stored values stay invalid. */
export function accountInstant(value: string): number | null {
  const parsed = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

export function accountOnTrial(
  account: AccountLifecycle,
): account is AccountLifecycle & { expiresAt: string } {
  return !account.claimed && account.expiresAt !== null;
}

/** The single calculation used by lifecycle enforcement, quota periods and bootstrap output. */
export function accountTrialDeadline(createdAt: string): number | null {
  const created = accountInstant(createdAt);
  return created === null ? null : created + ACCOUNT_TRIAL_MS;
}

export function requiresActiveTrial(
  deploymentMode: DeploymentMode,
  accessMode: AccountAccessMode,
): boolean {
  return deploymentMode === "cloud" && (accessMode === "setup" || accessMode === "proxy");
}

export function accountAccessDenial(
  deploymentMode: DeploymentMode,
  account: AccountLifecycle,
  accessMode: AccountAccessMode,
  nowMs: number,
): AccountAccessDenial | null {
  if (!accountOnTrial(account)) return null;
  const recoveryDeadline = accountInstant(account.expiresAt);
  if (recoveryDeadline === null || recoveryDeadline <= nowMs) return "account_expired";
  if (requiresActiveTrial(deploymentMode, accessMode)) {
    const trialDeadline = accountTrialDeadline(account.createdAt);
    if (trialDeadline === null || trialDeadline <= nowMs) return "billing_trial_expired";
  }
  return null;
}

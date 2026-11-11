/** Refusals sampled for diagnostics before a provider is contacted. */
export const REJECTION_REASONS = [
  "blocked_app_rate",
  "blocked_app_budget",
  "blocked_billing",
  "blocked_user",
  /** An App Attest assertion whose counter the install had already used. */
  "blocked_replay",
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];
/**
 * Whose limit refused: one end user's, one install's (App Attest applications
 * count request limits per install), one Apple Account's budget (every install
 * of one person's Apple Account, the App Attest default), the whole app's, or
 * the account's plan allowance. `account` is the gateway customer's account and
 * `apple_account` is their end user's: unrelated, despite the shared word.
 */
export const REJECTION_SCOPES = ["user", "install", "apple_account", "app", "account"] as const;
export type RejectionScope = (typeof REJECTION_SCOPES)[number];

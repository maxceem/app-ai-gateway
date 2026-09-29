/** Refusals sampled for diagnostics before a provider is contacted. */
export const REJECTION_REASONS = [
  "blocked_app_rate",
  "blocked_app_budget",
  "blocked_billing",
  "blocked_user",
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];
export const REJECTION_SCOPES = ["user", "app", "account"] as const;
export type RejectionScope = (typeof REJECTION_SCOPES)[number];

/**
 * Refusals caused by the app's own settings, or by a request they cannot
 * serve, recorded after the caller proved who it is. Each is the error code
 * the client was answered with, so the console and the app's error read the
 * same. A refusal before the caller is authenticated is never recorded: anyone
 * could send one, and fill an app's history with them.
 */
export const CONFIG_REJECTION_REASONS = [
  "path_not_allowed",
  "model_not_allowed",
  "provider_not_configured",
  "provider_disabled",
  "pricing_not_configured",
  "max_output_tokens_exceeded",
  "api_style_not_supported",
  "payload_too_large",
  "endpoint_not_found",
] as const;

export type ConfigRejectionReason = (typeof CONFIG_REJECTION_REASONS)[number];

const CONFIG_REASONS: ReadonlySet<string> = new Set(CONFIG_REJECTION_REASONS);

/** Whether a code is a refusal by the app's own settings. */
export function isConfigRejectionReason(code: string): code is ConfigRejectionReason {
  return CONFIG_REASONS.has(code);
}

/** Refusals sampled for diagnostics before a provider is contacted. */
export const REJECTION_REASONS = [
  "blocked_app_rate",
  "blocked_app_budget",
  "blocked_billing",
  "blocked_user",
  /** An App Attest assertion whose counter the install had already used. */
  "blocked_replay",
  ...CONFIG_REJECTION_REASONS,
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

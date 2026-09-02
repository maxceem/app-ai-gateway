import { ApiError } from "./api";

/**
 * Better Auth answers `/v1/auth/*` with SCREAMING_SNAKE codes and terse
 * messages aimed at developers. These translations are what an operator sees on
 * the sign-in and sign-up screens.
 */
const AUTH_MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "That email and password combination is not correct.",
  INVALID_EMAIL: "Enter a valid email address.",
  INVALID_PASSWORD: "That password is not correct.",
  USER_ALREADY_EXISTS: "An account with that email already exists.",
  USER_NOT_FOUND: "No account exists for that email.",
  PASSWORD_TOO_SHORT: "Choose a longer password.",
  PASSWORD_TOO_LONG: "Choose a shorter password.",
  EMAIL_NOT_VERIFIED: "Verify your email address before signing in.",
  CREDENTIAL_ACCOUNT_NOT_FOUND: "This account signs in with Google.",
  SESSION_EXPIRED: "Your session expired. Sign in again.",
  // Surfaced by the gateway rather than Better Auth, but shown on the same screens.
  registration_disabled: "Public registration is disabled for this deployment.",
};

export const SIGN_UP_DISABLED_CODE = "registration_disabled";

/** True when the gateway refused a signup because registration is closed. */
export function isRegistrationDisabled(error: unknown): boolean {
  return error instanceof ApiError && error.code === SIGN_UP_DISABLED_CODE;
}

/** A human-facing message for any auth failure, with a sane generic fallback. */
export function authErrorMessage(error: unknown, fallback = "Something went wrong. Try again."): string {
  if (error instanceof ApiError) {
    const mapped = AUTH_MESSAGES[error.code];
    if (mapped) return mapped;
    // Better Auth messages are already sentence-shaped; prefer them to a generic string.
    if (error.message && !error.message.startsWith("Request failed with status")) {
      return error.message;
    }
    return fallback;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

import { api } from "./api";
import { DEFAULT_LANDING, isSafeReturnPath, loginUrlFor } from "./auth-redirect";

/**
 * Better Auth's HTTP surface, mounted by the Worker at `/v1/auth`.
 *
 * The console talks to it with plain fetch rather than a client SDK: cf-auth
 * ships server-side only, and these five calls are the entire surface the
 * console needs.
 */
export const AUTH_BASE = "/v1/auth";

export interface SignInInput {
  email: string;
  password: string;
}

export interface SignUpInput extends SignInInput {
  name: string;
}

export function signInWithPassword(input: SignInInput): Promise<unknown> {
  return api.post(`${AUTH_BASE}/sign-in/email`, { ...input, rememberMe: true });
}

export function signUpWithPassword(input: SignUpInput): Promise<unknown> {
  return api.post(`${AUTH_BASE}/sign-up/email`, input);
}

export function signOut(): Promise<unknown> {
  return api.post(`${AUTH_BASE}/sign-out`);
}

export function changePassword(input: {
  currentPassword: string;
  newPassword: string;
  revokeOtherSessions?: boolean;
}): Promise<unknown> {
  return api.post(`${AUTH_BASE}/change-password`, input);
}

/**
 * Starts the Google flow. Better Auth answers with the provider URL instead of
 * redirecting, so the console performs the top-level navigation itself.
 *
 * Both outcomes are top-level navigations, so the destination the operator was
 * originally headed for has to survive in the URLs handed to the provider:
 * success returns there directly, and failure returns to sign-in still carrying
 * it, alongside the `?error=` the sign-in screen renders.
 *
 * `returnPath` reaches here from the query string, so it is sanitized rather
 * than trusted.
 */
export async function startGoogleSignIn(returnPath?: string): Promise<void> {
  const destination = isSafeReturnPath(returnPath) ? returnPath : DEFAULT_LANDING;
  const result = await api.post<{ url?: string; redirect?: boolean }>(
    `${AUTH_BASE}/sign-in/social`,
    {
      provider: "google",
      callbackURL: destination,
      errorCallbackURL: loginUrlFor(destination),
    },
  );
  if (!result?.url) throw new Error("Google sign-in is unavailable right now.");
  window.location.assign(result.url);
}

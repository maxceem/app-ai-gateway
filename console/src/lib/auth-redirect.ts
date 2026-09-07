import { ApiError } from "./api";

export const LOGIN_PATH = "/login";
export const SIGNUP_PATH = "/signup";
export const DEFAULT_LANDING = "/apps";

/** Screens that render without a session; a 401 there is a failed attempt, not an expiry. */
export const AUTH_PATHS: ReadonlySet<string> = new Set([LOGIN_PATH, SIGNUP_PATH]);

/** Carries the page the operator wanted, so re-auth returns them to it. */
export const RETURN_PARAM = "from";

/** Carries an OAuth failure back from a top-level provider redirect. */
export const ERROR_PARAM = "error";

/**
 * Deterministic client errors: the server has judged the request itself, so a
 * retry sends the identical request and gets the identical answer. Retrying
 * them only delays the error the operator needs to see.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return !(error.status >= 400 && error.status < 500);
  }
  return true;
}

/**
 * Accepts only same-origin absolute paths.
 *
 * A return path arrives from the URL, so treating it as trusted would let a
 * crafted link bounce the operator off-site straight after authenticating.
 */
export function isSafeReturnPath(path: string | null | undefined): path is string {
  if (!path) return false;
  // "//host" and "/\host" are protocol-relative; browsers navigate off-origin.
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return false;
  return !AUTH_PATHS.has(new URL(path, "https://console.invalid").pathname);
}

/** The path to return to after signing in, defaulting to the console landing page. */
export function returnPathFrom(search: string): string {
  const raw = new URLSearchParams(search).get(RETURN_PARAM);
  return isSafeReturnPath(raw) ? raw : DEFAULT_LANDING;
}

/** The sign-in URL that remembers where the operator was headed. */
export function loginUrlFor(path: string | null | undefined): string {
  if (!isSafeReturnPath(path) || path === DEFAULT_LANDING) return LOGIN_PATH;
  return `${LOGIN_PATH}?${RETURN_PARAM}=${encodeURIComponent(path)}`;
}

export interface OAuthErrorNotice {
  tone: "default" | "destructive";
  title: string;
  description: string;
}

/**
 * Copy for an OAuth failure handed back through the query string.
 *
 * A provider redirect cannot deliver a response body, so a denied consent or a
 * closed-registration rejection arrives as `?error=…` on a fresh page load.
 * Without this the operator sees an ordinary sign-in form and no explanation
 * for why nothing happened.
 */
const OAUTH_ERRORS: Record<string, OAuthErrorNotice> = {
  access_denied: {
    tone: "default",
    title: "Google sign-in was cancelled",
    description: "You declined the permission request. Try again or use your password.",
  },
  registration_disabled: {
    tone: "destructive",
    title: "This gateway does not accept new accounts",
    description:
      "Your Google account is not registered here. Ask an owner or admin to add you, then sign in.",
  },
  signup_disabled: {
    tone: "destructive",
    title: "This gateway does not accept new accounts",
    description:
      "Your Google account is not registered here. Ask an owner or admin to add you, then sign in.",
  },
};

export function oauthErrorNotice(search: string): OAuthErrorNotice | null {
  const raw = new URLSearchParams(search).get(ERROR_PARAM);
  if (!raw) return null;
  // Providers vary between "access_denied" and "access denied".
  const code = raw.trim().toLowerCase().replaceAll(/[\s-]+/gu, "_");
  return (
    OAUTH_ERRORS[code] ?? {
      tone: "destructive",
      title: "Sign-in failed",
      description: "The identity provider rejected the sign-in. Try again or use your password.",
    }
  );
}

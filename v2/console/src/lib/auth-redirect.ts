import { ApiError } from "./api";

/**
 * Where the console lives: under `/v2`, beside v1's console on the same host.
 * The router's `basename`, and the same value as `base` in `vite.config.ts`.
 */
export const CONSOLE_BASE = "/v2";

export const LOGIN_PATH = "/login";
export const SIGNUP_PATH = "/signup";
/** Where a signed-in person lands. */
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

/**
 * The path to return to after signing in, defaulting to the console landing
 * page. The stored path keeps its own query string: {@link isSafeReturnPath}
 * judges the pathname alone.
 */
export function returnPathFrom(search: string): string {
  const raw = new URLSearchParams(search).get(RETURN_PARAM);
  return isSafeReturnPath(raw) ? raw : DEFAULT_LANDING;
}

/** A browser path as the router sees it: the console's `/v2` base taken off. */
export function routerPath(pathname: string): string {
  if (pathname === CONSOLE_BASE) return "/";
  const path = pathname.startsWith(`${CONSOLE_BASE}/`) ? pathname.slice(CONSOLE_BASE.length) : pathname;
  // One trailing slash is the same page to the router: `/v2/login/` is the sign-in page.
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Where an operator belongs the moment they are authenticated. */
export function postAuthPath(search: string): string {
  return returnPathFrom(search);
}

/** The sign-in URL that remembers where the operator was headed. */
export function loginUrlFor(path: string | null | undefined): string {
  return authUrlFor(LOGIN_PATH, path);
}

/** The sign-up URL that remembers where the operator was headed. */
export function signupUrlFor(path: string | null | undefined): string {
  return authUrlFor(SIGNUP_PATH, path);
}

function authUrlFor(screen: string, path: string | null | undefined): string {
  if (!isSafeReturnPath(path) || path === DEFAULT_LANDING) return screen;
  return `${screen}?${RETURN_PARAM}=${encodeURIComponent(path)}`;
}

/**
 * The URL a top-level navigation needs for a console path. The router works
 * below `/v2` and leaves it out of every path, but a URL handed to the
 * browser or to the server for a redirect (Google's return, for one) must
 * carry it.
 */
export function consoleUrl(path: string): string {
  return `${CONSOLE_BASE}${path}`;
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
    title: "This email can't register here",
    description:
      "Your Google account's email is not allowed to create an account on this gateway.",
  },
  signup_disabled: {
    tone: "destructive",
    title: "This email can't register here",
    description:
      "Your Google account's email is not allowed to create an account on this gateway.",
  },
  // Better Auth refuses to join a Google login to a sign-in it did not create,
  // so this is what an email that already has a password gets back.
  account_not_linked: {
    tone: "destructive",
    title: "This email already signs in with a password",
    description:
      "An account with this email already signs in with a password. Sign in with your password instead.",
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

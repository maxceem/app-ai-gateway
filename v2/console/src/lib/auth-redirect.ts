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

/** Where a plan chosen before sign-in is bought (a hosted deployment's pricing page links here). */
export const CHECKOUT_PATH = "/checkout";

/** Carries a plan picked on the pricing page, before the visitor had an account. */
export const PLAN_PARAM = "plan";

/**
 * The billing service's free tier: what every account already has, so never
 * something to send anyone to checkout for.
 */
export const FREE_PLAN_KEY = "free";

/**
 * Plan keys are short lowercase slugs. The value arrives from a link anyone
 * can write and is put back into a URL, so it is held to a shape that cannot
 * carry anything else. Whether it names a real plan is settled against the
 * catalog later.
 */
const PLAN_KEY_PATTERN = /^[a-z0-9_-]{1,32}$/u;

/** The plan named in a query string, or `null` when there is no usable one. */
export function planKeyFrom(search: string): string | null {
  const raw = new URLSearchParams(search).get(PLAN_PARAM);
  return raw !== null && PLAN_KEY_PATTERN.test(raw) ? raw : null;
}

/** The console path that starts checkout for one plan. */
export function checkoutPathFor(planKey: string): string {
  return `${CHECKOUT_PATH}?${PLAN_PARAM}=${encodeURIComponent(planKey)}`;
}

/**
 * Where an operator belongs the moment they are authenticated. A paid plan
 * named on the link is an intent formed before the account existed (a price
 * pressed on the pricing page), so it goes to that plan's checkout (v1's rule).
 */
export function postAuthPath(search: string): string {
  const planKey = planKeyFrom(search);
  if (planKey !== null && planKey !== FREE_PLAN_KEY) return checkoutPathFor(planKey);
  return returnPathFrom(search);
}

/**
 * Marks the page a completed checkout returns to. The provider sends the
 * browser back with nothing but a URL, so the purchase can only travel as a
 * query marker: read once, announced, and stripped.
 */
export const CHECKOUT_PARAM = "checkout";
export const CHECKOUT_SUCCESS = "success";

/**
 * The account a checkout was started for, which the gateway writes into the
 * return address: a return read in another account's console announces
 * nothing about this one.
 */
export const ACCOUNT_PARAM = "account";

/**
 * The shape of an account id. The value arrives from a link or from storage
 * and is sent back as a request header, so it is held to a shape that cannot
 * carry anything else (a newline would make every request throw).
 */
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/u;

export function isAccountId(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_ID_PATTERN.test(value);
}

/** The account a checkout return names, or `null`. */
export function checkoutAccountFrom(search: string): string | null {
  const raw = new URLSearchParams(search).get(ACCOUNT_PARAM);
  return isAccountId(raw) ? raw : null;
}

/**
 * The account a checkout return names, whether this is the return itself or
 * the sign-in page it was sent to (the return travels in `from`), or `null`.
 */
export function checkoutReturnAccount(search: string): string | null {
  if (checkoutSucceeded(search)) return checkoutAccountFrom(search);
  const back = new URLSearchParams(search).get(RETURN_PARAM);
  if (!isSafeReturnPath(back)) return null;
  const query = new URL(back, "https://console.invalid").search;
  return checkoutSucceeded(query) ? checkoutAccountFrom(query) : null;
}

/** True when this load is the return leg of a completed checkout. */
export function checkoutSucceeded(search: string): boolean {
  return new URLSearchParams(search).get(CHECKOUT_PARAM) === CHECKOUT_SUCCESS;
}

/** The same location with the checkout marker and its plan spent, keeping any other query. */
export function pathWithoutCheckout(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete(CHECKOUT_PARAM);
  params.delete(PLAN_PARAM);
  params.delete(ACCOUNT_PARAM);
  const rest = params.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}

/** Where a completed checkout for `planKey` sends the operator (a router path). */
export function checkoutReturnPathFor(planKey: string, accountId?: string): string {
  const account = accountId === undefined ? "" : `&${ACCOUNT_PARAM}=${encodeURIComponent(accountId)}`;
  return `${DEFAULT_LANDING}?${CHECKOUT_PARAM}=${CHECKOUT_SUCCESS}&${PLAN_PARAM}=${encodeURIComponent(planKey)}${account}`;
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

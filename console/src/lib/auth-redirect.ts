import { ApiError } from "./api";

export const LOGIN_PATH = "/login";
export const SIGNUP_PATH = "/signup";
export const DEFAULT_LANDING = "/apps";
export const CHECKOUT_PATH = "/checkout";

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
 * page.
 *
 * The stored path keeps its own query string: {@link isSafeReturnPath} judges
 * the pathname alone, so `/checkout?plan=growth` survives a round trip through
 * sign-in intact. That is load-bearing for plan intent, which is carried in
 * exactly that shape.
 */
export function returnPathFrom(search: string): string {
  const raw = new URLSearchParams(search).get(RETURN_PARAM);
  return isSafeReturnPath(raw) ? raw : DEFAULT_LANDING;
}

/** Carries a plan the visitor picked on the marketing site, before they had an account. */
export const PLAN_PARAM = "plan";

/**
 * The billing service's free tier. It is what every organization already has,
 * so it is never something to send anyone to checkout for.
 */
export const FREE_PLAN_KEY = "free";

/**
 * Plan keys are lowercase slugs in the billing catalog (`free`, `starter`,
 * `growth`, `scale`). The pattern is deliberately narrower than the catalog:
 * this value arrives from a link anyone can write and is pasted into a URL and
 * rendered, so it is constrained to a shape that cannot carry anything else.
 * Whether the key names a real plan is settled later, against the catalog.
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

/** The same plan carried onto another auth screen, so it survives the hop. */
export function authPathWithPlan(path: string, planKey: string | null): string {
  return planKey === null ? path : `${path}?${PLAN_PARAM}=${encodeURIComponent(planKey)}`;
}

/**
 * Where an operator belongs the moment they are authenticated.
 *
 * A paid plan named in the query string is an intent formed before the account
 * existed — someone pressed a price on the marketing site — so it outranks the
 * `from` path, which is only ever written by this console's own 401 handling
 * and cannot be present on a link from outside. The free plan is not a
 * destination: it is what the organization already has.
 */
export function postAuthPath(search: string): string {
  const planKey = planKeyFrom(search);
  if (planKey !== null && planKey !== FREE_PLAN_KEY) return checkoutPathFor(planKey);
  return returnPathFrom(search);
}

/** The sign-in URL that remembers where the operator was headed. */
export function loginUrlFor(path: string | null | undefined): string {
  if (!isSafeReturnPath(path) || path === DEFAULT_LANDING) return LOGIN_PATH;
  return `${LOGIN_PATH}?${RETURN_PARAM}=${encodeURIComponent(path)}`;
}

/**
 * Marks the console landing that a completed checkout returns to.
 *
 * The provider redirects the browser back with nothing but a URL, so the fact
 * that a purchase just happened can only travel as a query parameter. It is
 * read once, announced, and stripped: reloading a bare landing page must not
 * congratulate anyone a second time.
 */
export const CHECKOUT_PARAM = "checkout";
export const CHECKOUT_SUCCESS = "success";

/** True when this load is the return leg of a completed checkout. */
export function checkoutSucceeded(search: string): boolean {
  return new URLSearchParams(search).get(CHECKOUT_PARAM) === CHECKOUT_SUCCESS;
}

/** The same location with the checkout marker spent, keeping any other query. */
export function pathWithoutCheckout(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete(CHECKOUT_PARAM);
  const rest = params.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}

/**
 * Where a completed checkout sends the operator.
 *
 * The console names this on the checkout it asks for, so it is also the one
 * place the destination is decided. The billing service holds the same URL as
 * a fallback for a caller that supplies none; this one wins whenever the
 * console is the caller.
 */
export const CHECKOUT_RETURN_PATH = `${DEFAULT_LANDING}?${CHECKOUT_PARAM}=${CHECKOUT_SUCCESS}`;

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

import { claimOAuthAuthorized, CLAIM_OAUTH_COOKIE } from "./cli/oauth";
import { Hono } from "hono";
import { clientAddress, enforceEndpointRateLimit } from "../core/endpoint-rate-limit";
import {
  identityAuthFor,
  IDENTITY_AUTH_BASE_PATH,
  registrationOpen,
  relaySocialSignIn,
} from "../auth/identity";
import type { RequestVariables } from "../middleware/request-scope";

export const identityAuthRoutes = new Hono<{
  Bindings: Env;
  Variables: RequestVariables;
}>();

/** Where the console serves its sign-in screen. */
const CONSOLE_LOGIN_PATH = "/login";

/** The Better Auth route that answers with a provider authorization URL. */
const SOCIAL_SIGN_IN_PATH = `${IDENTITY_AUTH_BASE_PATH}/sign-in/social`;

/** The Better Auth route that accepts a password. */
const PASSWORD_SIGN_IN_PATH = `${IDENTITY_AUTH_BASE_PATH}/sign-in/email`;

/**
 * The account an attempt names, read without consuming the request.
 *
 * Always from a clone, so Better Auth still receives its own body. Both media
 * types this route accepts are read: Better Auth takes the credentials
 * form-encoded as readily as it takes them as JSON, and a counter that only
 * understood JSON would be bypassed by changing one header. A body in neither
 * shape names no account, and only the address counter applies.
 */
async function submittedEmail(request: Request): Promise<string | null> {
  const clone = request.clone();
  const named = request.headers.get("content-type")?.includes(
    "application/x-www-form-urlencoded",
  )
    ? (await clone.formData().catch(() => undefined))?.get("email")
    : ((await clone.json().catch(() => undefined)) as { email?: unknown } | undefined)?.email;
  if (typeof named !== "string") return null;
  // Normalized, so one account is one counter however the attempt spells it.
  return named.trim().toLowerCase() || null;
}

/**
 * Bounds password guessing on the one route where guessing pays.
 *
 * This is the gateway's own limit and runs on every deployment, because the
 * zone rules that would otherwise do it need a zone: a one-click `workers.dev`
 * install has none, and Better Auth's own limiter is off. Only this route is
 * counted. Sign-up is already refused outright once a deployment has its
 * owner, and the rest of Better Auth's surface either needs a session or hands
 * out nothing an attacker can grind for.
 *
 * The address is counted first and counted always, including for a body that
 * names no account: the attempt reached the endpoint and cost this Worker the
 * same as any other.
 */
async function enforcePasswordSignInLimit(env: Env, request: Request): Promise<void> {
  await enforceEndpointRateLimit(env, "sign_in_address", clientAddress(request));
  const email = await submittedEmail(request);
  if (email) await enforceEndpointRateLimit(env, "sign_in_email", email);
}

function registrationDisabled() {
  return {
    error: {
      code: "registration_disabled",
      message: "Public registration is disabled for this deployment",
    },
  };
}

/**
 * True when the browser is navigating at the top level rather than calling the
 * API from script.
 *
 * The OAuth callback is a full page load, so answering it with a JSON error
 * body strands the operator on raw JSON outside the console. Script callers,
 * which can read a body, keep getting the machine-readable error.
 */
function isTopLevelNavigation(request: Request): boolean {
  if (request.headers.get("sec-fetch-mode") === "navigate") return true;
  // Fall back to content negotiation for clients that omit Fetch Metadata.
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html") && !accept.includes("application/json");
}

async function isDisabledSignup(response: Response): Promise<boolean> {
  const location = response.headers.get("location");
  if (location) {
    const error = new URL(location, "https://auth.invalid").searchParams.get("error");
    if (error?.replaceAll("_", " ").toLowerCase() === "signup disabled") return true;
  }

  if (!response.headers.get("content-type")?.includes("application/json")) return false;
  const body = (await response
    .clone()
    .json()
    .catch(() => undefined)) as { code?: unknown; message?: unknown } | undefined;
  return (
    (body?.code === "REGISTRATION_DISABLED" || body?.code === "OAUTH_LINK_ERROR") &&
    typeof body.message === "string" &&
    body.message.toLowerCase() === "signup disabled"
  );
}

/**
 * Rebuilds the rejection as a redirect to the console sign-in screen.
 *
 * Better Auth's own response is discarded, so two things have to be carried
 * across: its `Set-Cookie` headers, which clear the transient OAuth state
 * cookies (leaving them behind would strand cookies the flow no longer owns),
 * and any `from` destination it was going to return the operator to.
 */
export function registrationDisabledRedirect(rejected: Response): Response {
  const target = new URL(CONSOLE_LOGIN_PATH, "https://console.invalid");

  const location = rejected.headers.get("location");
  if (location) {
    const from = new URL(location, "https://auth.invalid").searchParams.get("from");
    if (from) target.searchParams.set("from", from);
  }
  target.searchParams.set("error", "registration_disabled");

  const redirect = new Response(null, {
    status: 302,
    headers: { location: `${target.pathname}${target.search}` },
  });
  for (const cookie of rejected.headers.getSetCookie()) {
    redirect.headers.append("set-cookie", cookie);
  }
  return redirect;
}

identityAuthRoutes.all("/*", async (c) => {
  if (c.req.method === "POST" && c.req.path === PASSWORD_SIGN_IN_PATH) {
    await enforcePasswordSignInLimit(c.env, c.req.raw);
  }

  if (
    c.req.method === "POST" &&
    c.req.path === "/v1/auth/sign-up/email" &&
    !(await registrationOpen(c.get("deployment"), c.env))
  ) {
    return c.json(registrationDisabled(), 403);
  }

  const callback = c.req.path === `${IDENTITY_AUTH_BASE_PATH}/callback/google`;
  const claim = callback && (await claimOAuthAuthorized(c.env, c.req.raw));
  let registrationDenied = false;
  const markRegistrationDenied = () => {
    registrationDenied = true;
  };
  const auth = identityAuthFor(c, {
    ...(claim
      ? { claimRegistration: true }
      : { provisionRegistration: true }),
    onRegistrationDenied: markRegistrationDenied,
  });
  let handled = await auth.handler(c.req.raw);
  if (callback) {
    const headers = new Headers(handled.headers);
    headers.append(
      "Set-Cookie",
      `${CLAIM_OAUTH_COOKIE}=; Path=/v1/auth/callback/google; HttpOnly; SameSite=Lax; Max-Age=0${new URL(c.req.url).protocol === "https:" ? "; Secure" : ""}`,
    );
    handled = new Response(handled.body, { status: handled.status, headers });
  }
  // Only the one response that hands the browser a provider URL is rewritten,
  // and only when an OAuth relay is configured; everything else is untouched.
  const response =
    c.req.method === "POST" && c.req.path === SOCIAL_SIGN_IN_PATH
      ? await relaySocialSignIn(c.env, c.req.url, handled)
      : handled;
  if ((await isDisabledSignup(response)) || registrationDenied) {
    // The OAuth callback is a top-level navigation, so the rejection has to be
    // delivered as one. Returning JSON here would leave the operator looking at
    // an error document with no way back into the console.
    if (isTopLevelNavigation(c.req.raw)) {
      return registrationDisabledRedirect(response);
    }
    return c.json(registrationDisabled(), 403);
  }
  return response;
});

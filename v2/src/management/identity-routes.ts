/**
 * Better Auth's own routes, under `/v2/auth`: sign-up, sign-in with a
 * password or Google, sign-out and the session. v1's handling, ported:
 *
 * - password sign-in is counted per network address and per email, and
 *   sign-up per address, before Better Auth reads anything;
 * - a sign-up the deployment does not admit is refused with
 *   `registration_disabled`, as JSON for a script and as a redirect to the
 *   console's sign-in page for a browser coming back from Google;
 * - with `OAUTH_RELAY_URL`, Google's authorization URL is wrapped in the relay.
 */
import type { CfAuth } from "@maxceem/cf-auth";
import { Hono } from "hono";
import { createIdentity, IDENTITY_BASE_PATH, oauthRelayOrigin } from "../auth/identity.ts";
import { registrationAllowed, V2_PATH } from "../auth/settings.ts";
import { clientAddress, enforceEndpointRateLimit } from "../core/flood-limit.ts";

export const identityRoutes = new Hono<{ Bindings: Env; Variables: { identity: Promise<CfAuth> } }>();

/** Where the console serves its sign-in page. */
const CONSOLE_LOGIN_PATH = `${V2_PATH}/login`;
const SOCIAL_SIGN_IN_PATH = `${IDENTITY_BASE_PATH}/sign-in/social`;
const PASSWORD_SIGN_IN_PATH = `${IDENTITY_BASE_PATH}/sign-in/email`;
const PASSWORD_SIGN_UP_PATH = `${IDENTITY_BASE_PATH}/sign-up/email`;
const GOOGLE_AUTHORIZATION_HOST = "accounts.google.com";

/**
 * One field of a JSON or form body, read from a clone and the way Better Auth
 * will read it, so a counter keyed on it counts the account Better Auth signs
 * in: the format from the media type alone, and a form's last value.
 */
async function submittedField(request: Request, field: string): Promise<unknown> {
  const clone = request.clone();
  const mediaType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (mediaType === "application/x-www-form-urlencoded") {
    return (await clone.formData().catch(() => undefined))?.getAll(field).at(-1);
  }
  if (mediaType === "application/json") {
    return ((await clone.json().catch(() => undefined)) as Record<string, unknown> | undefined)?.[field];
  }
  return undefined;
}

async function submittedEmail(request: Request): Promise<string | null> {
  const named = await submittedField(request, "email");
  if (typeof named !== "string") return null;
  return named.trim().toLowerCase() || null;
}

function registrationDisabled() {
  return { error: { code: "registration_disabled", message: "This email address is not allowed to sign up on this deployment" } };
}

/** A top-level page load, such as Google's callback, rather than a script call. */
function isTopLevelNavigation(request: Request): boolean {
  if (request.headers.get("sec-fetch-mode") === "navigate") return true;
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html") && !accept.includes("application/json");
}

/** Whether Better Auth refused a sign-up, by redirect or by JSON. */
async function isDisabledSignup(response: Response): Promise<boolean> {
  const location = response.headers.get("location");
  if (location) {
    const error = new URL(location, "https://auth.invalid").searchParams.get("error");
    if (error?.replaceAll("_", " ").toLowerCase() === "signup disabled") return true;
  }
  if (!response.headers.get("content-type")?.includes("application/json")) return false;
  const body = (await response.clone().json().catch(() => undefined)) as { code?: unknown; message?: unknown } | undefined;
  return (
    (body?.code === "REGISTRATION_DISABLED" || body?.code === "OAUTH_LINK_ERROR")
    && typeof body.message === "string"
    && body.message.toLowerCase() === "signup disabled"
  );
}

/**
 * The refusal as a redirect to the console's sign-in page, carrying Better
 * Auth's `Set-Cookie` headers (they clear its OAuth state cookies) and any
 * `from` destination it had.
 */
export function registrationDisabledRedirect(rejected: Response): Response {
  const target = new URL(CONSOLE_LOGIN_PATH, "https://console.invalid");
  const location = rejected.headers.get("location");
  if (location) {
    const from = new URL(location, "https://auth.invalid").searchParams.get("from");
    if (from) target.searchParams.set("from", from);
  }
  target.searchParams.set("error", "registration_disabled");
  const redirect = new Response(null, { status: 302, headers: { location: `${target.pathname}${target.search}` } });
  for (const cookie of rejected.headers.getSetCookie()) redirect.headers.append("set-cookie", cookie);
  return redirect;
}

/**
 * With `OAUTH_RELAY_URL` set, sends the browser to the relay instead of
 * straight to Google, carrying this origin's own callback, so Google needs
 * only the relay's redirect URI registered. Anything else passes untouched.
 */
async function relaySocialSignIn(env: Env, requestUrl: string, response: Response): Promise<Response> {
  const relay = oauthRelayOrigin(env);
  if (relay === undefined) return response;
  if (!response.headers.get("content-type")?.includes("application/json")) return response;
  const body = (await response.clone().json().catch(() => undefined)) as Record<string, unknown> | undefined;
  if (typeof body?.url !== "string") return response;
  let providerUrl: URL;
  try {
    providerUrl = new URL(body.url);
  } catch {
    return response;
  }
  if (providerUrl.hostname !== GOOGLE_AUTHORIZATION_HOST) return response;
  const start = new URL(`${relay}/start`);
  start.searchParams.set("return", new URL(`${IDENTITY_BASE_PATH}/callback/google`, requestUrl).toString());
  start.searchParams.set("next", providerUrl.toString());
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify({ ...body, url: start.toString() }), { status: response.status, headers });
}

identityRoutes.all(`${IDENTITY_BASE_PATH}/*`, async (c) => {
  const request = c.req.raw;
  const post = c.req.method === "POST";
  if (post && c.req.path === PASSWORD_SIGN_IN_PATH) {
    // The address first and always, even for a body that names no account.
    await enforceEndpointRateLimit(c.env, "sign_in_address", clientAddress(request));
    const email = await submittedEmail(request);
    if (email) await enforceEndpointRateLimit(c.env, "sign_in_email", email);
  }
  const signUp = post && c.req.path === PASSWORD_SIGN_UP_PATH;
  if (signUp) {
    await enforceEndpointRateLimit(c.env, "sign_up_address", clientAddress(request));
    if (!registrationAllowed(c.env, await submittedEmail(request))) return c.json(registrationDisabled(), 403);
  }
  let denied = false;
  const identity = await createIdentity(c.env, c.req.url, { onRegistrationDenied: () => { denied = true; } }, c.req.header("cf-ray") ?? null);
  const handled = await identity.handler(request);
  const response = post && c.req.path === SOCIAL_SIGN_IN_PATH ? await relaySocialSignIn(c.env, c.req.url, handled) : handled;
  if (denied || (await isDisabledSignup(response))) {
    // Google's callback is a page load: a JSON error would strand the person on it.
    return isTopLevelNavigation(request) ? registrationDisabledRedirect(response) : c.json(registrationDisabled(), 403);
  }
  return response;
});

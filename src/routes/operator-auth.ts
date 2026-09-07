import { Hono } from "hono";
import { createOperatorAuth, registrationOpen } from "../auth/operator";

export const operatorAuthRoutes = new Hono<{ Bindings: Env }>();

/** Where the console serves its sign-in screen. */
const CONSOLE_LOGIN_PATH = "/login";

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

async function isDisabledSocialSignup(response: Response): Promise<boolean> {
  const location = response.headers.get("location");
  if (location) {
    const error = new URL(location, "https://auth.invalid").searchParams.get("error");
    if (error?.replaceAll("_", " ").toLowerCase() === "signup disabled") return true;
  }

  if (!response.headers.get("content-type")?.includes("application/json")) return false;
  const body = await response.clone().json().catch(() => undefined) as
    | { code?: unknown; message?: unknown }
    | undefined;
  return body?.code === "OAUTH_LINK_ERROR"
    && typeof body.message === "string"
    && body.message.toLowerCase() === "signup disabled";
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

operatorAuthRoutes.all("/*", async (c) => {
  if (
    c.req.method === "POST"
    && c.req.path === "/v1/auth/sign-up/email"
    && !registrationOpen(c.env)
  ) {
    return c.json(registrationDisabled(), 403);
  }

  const response = await createOperatorAuth(c.env, c.req.url).handler(c.req.raw);
  if (!registrationOpen(c.env) && await isDisabledSocialSignup(response)) {
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

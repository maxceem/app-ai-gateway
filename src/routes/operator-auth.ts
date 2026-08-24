import { Hono } from "hono";
import { createOperatorAuth, registrationOpen } from "../auth/operator";

export const operatorAuthRoutes = new Hono<{ Bindings: Env }>();

function registrationDisabled() {
  return {
    error: {
      code: "registration_disabled",
      message: "Public registration is disabled for this deployment",
    },
  };
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
    return c.json(registrationDisabled(), 403);
  }
  return response;
});

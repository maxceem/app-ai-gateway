import { Hono } from "hono";
import { createOperatorAuth, registrationOpen } from "../auth/operator";

export const operatorAuthRoutes = new Hono<{ Bindings: Env }>();

operatorAuthRoutes.all("/*", async (c) => {
  if (
    c.req.method === "POST"
    && c.req.path === "/v1/auth/sign-up/email"
    && !registrationOpen(c.env)
  ) {
    return c.json(
      {
        error: {
          code: "registration_disabled",
          message: "Public registration is disabled for this deployment",
        },
      },
      403,
    );
  }

  return createOperatorAuth(c.env, c.req.url).handler(c.req.raw);
});

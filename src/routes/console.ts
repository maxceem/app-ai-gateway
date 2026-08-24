import { Hono } from "hono";
import { billingBinding } from "../billing/gateway";
import { googleAuthEnabled, registrationOpen } from "../auth/operator";

export const consoleRoutes = new Hono<{ Bindings: Env }>();

consoleRoutes.get("/capabilities", (c) => c.json({
  billing: Boolean(billingBinding(c.env)),
  registrationOpen: registrationOpen(c.env),
  googleAuth: googleAuthEnabled(c.env),
}));

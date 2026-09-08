import { Hono } from "hono";
import { billingBinding } from "../billing/gateway";
import { googleAuthEnabled, registrationOpen } from "../auth/operator";
import { publicApiOrigin } from "../core/public-api-url";

export const consoleRoutes = new Hono<{ Bindings: Env }>();

function optionalUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

consoleRoutes.get("/capabilities", (c) => c.json({
  billing: Boolean(billingBinding(c.env)),
  registrationOpen: registrationOpen(c.env),
  googleAuth: googleAuthEnabled(c.env),
  // Legal documents are deployment-specific. The console shows the sign-up
  // consent line only when the operator configured both links.
  termsOfServiceUrl: optionalUrl(c.env.TERMS_OF_SERVICE_URL),
  privacyPolicyUrl: optionalUrl(c.env.PRIVACY_POLICY_URL),
  // Present only where the deployment publishes a separate host for application
  // clients; otherwise the console builds client URLs from its own origin.
  apiBaseUrl: publicApiOrigin(c.env),
}));

import { Hono } from "hono";
import type { ConsoleCapabilitiesResponse } from "../contracts/responses";
import { googleAuthEnabled, registrationOpen } from "../auth/identity";
import { publicApiOrigin } from "../core/public-api-url";
import type { RequestVariables } from "../middleware/request-scope";

export const consoleRoutes = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

function optionalUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

consoleRoutes.get("/capabilities", async (c) => c.json({
  billing: c.get("deployment").mode === "cloud",
  registrationOpen: await registrationOpen(c.get("deployment"), c.env),
  googleAuth: googleAuthEnabled(c.env),
  // Legal documents are deployment-specific. The console shows the sign-up
  // consent line only when the operator configured both links.
  termsOfServiceUrl: optionalUrl(c.env.TERMS_OF_SERVICE_URL),
  privacyPolicyUrl: optionalUrl(c.env.PRIVACY_POLICY_URL),
  // Present only where the deployment publishes a separate host for application
  // clients; otherwise the console builds client URLs from its own origin.
  apiBaseUrl: publicApiOrigin(c.env),
} satisfies ConsoleCapabilitiesResponse));

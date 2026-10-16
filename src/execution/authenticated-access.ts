import { assertAccountAccess } from "../core/account-lifecycle";
import { authenticateRequest } from "../client-auth/client-auth";
import { assertAppActive, loadApp } from "../core/app-records";
import { GatewayError } from "../core/errors";
import { organizationProviders } from "../providers/provider-store";
import type { AppRecord, GatewayIdentity } from "../core/types";
import type { Deployment } from "../policy/deployment";
import type { ServedTimings } from "./timing";

/**
 * Everything up to and including the credential: whose request this is. Shared
 * by served HTTP requests and by realtime sessions, which run it once at their
 * handshake and again whenever they revalidate.
 */
export async function authenticatedAccess(input: {
  env: Env;
  deployment: Deployment;
  appId: string | undefined;
  request: Request;
  body: () => Promise<Uint8Array>;
  providerSlug?: string | undefined;
  timings?: ServedTimings;
  /** See `authenticateRequest`: only a realtime session's revalidation sets it. */
  proofVerified?: boolean;
}): Promise<{
  app: AppRecord;
  identity: GatewayIdentity;
  credentialHeader: string;
  assertionCounter: number | null;
}> {
  const start = performance.now();
  const { env, deployment, appId } = input;
  if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
  const app = await loadApp(env, appId);
  const providers = organizationProviders(env, app.organizationId);
  // A rejection nobody awaits yet — the request may still be refused for its
  // account or its credential first — must not surface as an unhandled one.
  providers.catch(() => {});
  // Only a hosted deployment writes an account deadline, so only one can refuse
  // here. It decides before the app, the credential or any limit the
  // organization set on its own users is consulted: an account that may not be
  // served has no claim on them.
  if (deployment.rules.accountDeadlines) {
    await assertAccountAccess(deployment, env, app.organizationId, "proxy");
  }
  assertAppActive(app);
  const { identity, credential, assertionCounter } = await authenticateRequest({
    env,
    app,
    request: input.request,
    body: input.body,
    providerSlug: input.providerSlug,
    providers,
    proofVerified: input.proofVerified,
  });
  if (input.timings) input.timings.authMs = performance.now() - start;
  if (identity.credentialType === "gateway_token" && !input.request.headers.get("x-app-version")) {
    throw new GatewayError(400, "invalid_request", "X-App-Version header is required");
  }
  return { app, identity, credentialHeader: credential.headerName, assertionCounter };
}

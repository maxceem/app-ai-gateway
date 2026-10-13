/**
 * One served client request — a proxied provider call or a custom endpoint —
 * from its application to the provider's answer, as one function.
 *
 * The steps run in the order the gateway decides in, and each hands its result
 * to the next as a value:
 *
 *   1. load the application, and start reading its organization's provider rows;
 *   2. the account's own access, on a hosted deployment, before anything else is
 *      spent on a request that may not be served;
 *   3. the application being active, then the client's credential;
 *   4. the plan: every attempt resolved, validated and prepared;
 *   5. admission, the one place the request is counted;
 *   6. execution.
 *
 * The body is read at most once, by whichever step first needs it — the App
 * Attest proof, which signs it, or the plan — and both see the same bytes,
 * before anything rewrites them.
 *
 * The provider rows are the one read that overlaps the others. It starts in
 * step 1 because every served request needs them, and it is awaited inside
 * step 3 beside the credential, so the rows are cached by the time step 4 reads
 * them; its failure is left to step 4, which reports it against the instance it
 * was asked for. Everything that refuses earlier — the account, the app, the
 * credential — is still the error the client sees.
 */

import type { Context, Handler } from "hono";
import { assertAccountAccess } from "../core/account-lifecycle";
import { authenticateRequest } from "../client-auth/client-auth";
import { assertAppActive, loadApp } from "../core/app-records";
import { GatewayError } from "../core/errors";
import { organizationProviders } from "../providers/provider-store";
import { readBodyLimited } from "../providers/request-body";
import type { AppRecord, GatewayIdentity } from "../core/types";
import type { RequestVariables } from "../middleware/request-scope";
import { admitRequest } from "./admission";
import { execute } from "./execute";
import type { ExecutionPlan } from "./plan";
import { prepareEndpointPlan, prepareProxyPlan, type PrepareInput } from "./prepare";
import type { ServedTimings } from "./timing";

export interface ServedVariables extends RequestVariables {
  /**
   * Set as soon as a served request starts, and filled in as it goes, so the
   * entry module's error handler can report the timings of a refused request
   * too. Absent on every other route.
   */
  servedTimings: ServedTimings;
}

type ServedContext = Context<{ Bindings: Env; Variables: ServedVariables }>;

/** The request body, read the first time it is asked for and shared after. */
function bodyOnce(request: Request): () => Promise<Uint8Array<ArrayBuffer>> {
  let read: Promise<Uint8Array<ArrayBuffer>> | undefined;
  return () => (read ??= readBodyLimited(request));
}

/** Everything up to and including the credential: whose request this is. */
async function authenticated(
  c: ServedContext,
  timings: ServedTimings,
  providerSlug: string | undefined,
  body: () => Promise<Uint8Array<ArrayBuffer>>,
): Promise<{
  app: AppRecord;
  identity: GatewayIdentity;
  credentialHeader: string;
  assertionCounter: number | null;
  responseHeaders: Record<string, string>;
}> {
  const start = performance.now();
  const appId = c.req.param("app");
  if (!appId) throw new GatewayError(400, "invalid_request", "App id is required");
  const app = await loadApp(c.env, appId);
  const providers = organizationProviders(c.env, app.organizationId);
  // A rejection nobody awaits yet — the request may still be refused for its
  // account or its credential first — must not surface as an unhandled one.
  providers.catch(() => {});
  // Only a hosted deployment writes an account deadline, so only one can refuse
  // here. It decides before the app, the credential or any limit the
  // organization set on its own users is consulted: an account that may not be
  // served has no claim on them.
  const deployment = c.get("deployment");
  if (deployment.rules.accountDeadlines) {
    await assertAccountAccess(deployment, c.env, app.organizationId, "proxy");
  }
  assertAppActive(app);
  const { identity, credential, assertionCounter, responseHeaders } = await authenticateRequest({
    env: c.env,
    app,
    request: c.req.raw,
    body,
    providerSlug,
    providers,
  });
  timings.authMs = performance.now() - start;
  // From here on every answer, refusals included, carries what the request
  // was accepted under.
  if (Object.keys(responseHeaders).length > 0) c.set("responseHeaders", responseHeaders);
  if (identity.credentialType === "gateway_token" && !c.req.header("x-app-version")) {
    throw new GatewayError(400, "invalid_request", "X-App-Version header is required");
  }
  return { app, identity, credentialHeader: credential.headerName, assertionCounter, responseHeaders };
}

/** A response with `headers` added, its body passed through untouched. */
export function withResponseHeaders(response: Response, headers: Record<string, string>): Response {
  const entries = Object.entries(headers);
  if (entries.length === 0) return response;
  const answered = new Response(response.body, response);
  for (const [name, value] of entries) answered.headers.set(name, value);
  return answered;
}

async function serve(
  c: ServedContext,
  providerSlug: string | undefined,
  prepare: (input: PrepareInput) => Promise<ExecutionPlan>,
): Promise<Response> {
  const timings: ServedTimings = { authMs: 0, limiterMs: 0 };
  c.set("servedTimings", timings);
  const body = bodyOnce(c.req.raw);
  const { app, identity, credentialHeader, assertionCounter, responseHeaders } =
    await authenticated(c, timings, providerSlug, body);
  const plan = await prepare({ env: c.env, request: c.req.raw, body, app, identity, credentialHeader });
  const appVersion = c.req.header("x-app-version") ?? null;
  const waitUntil = (promise: Promise<unknown>) => c.executionCtx.waitUntil(promise);
  await admitRequest(
    {
      env: c.env,
      deployment: c.get("deployment"),
      billingCache: c.get("billingRequestCache"),
      app,
      identity,
      assertionCounter,
      plan,
      appVersion,
      waitUntil,
    },
    (durationMs) => {
      timings.limiterMs = durationMs;
    },
  );
  return withResponseHeaders(
    await execute(plan, { env: c.env, app, identity, appVersion, timings, waitUntil }),
    responseHeaders,
  );
}

/** `/v1/apps/:app/proxy/:provider/*`: the client names the provider and its path. */
export const serveProxy: Handler<{ Bindings: Env; Variables: ServedVariables }> = (c) => {
  const providerSlug = c.req.param("provider") ?? "";
  return serve(c, providerSlug, (input) =>
    prepareProxyPlan({ ...input, providerSlug, path: c.req.path }));
};

/** `/v1/apps/:app/endpoints/:slug`: the application's own configuration names everything. */
export const serveEndpoint: Handler<{ Bindings: Env; Variables: ServedVariables }> = (c) => {
  const slug = c.req.param("slug") ?? "";
  return serve(c, undefined, (input) => prepareEndpointPlan({ ...input, slug }));
};

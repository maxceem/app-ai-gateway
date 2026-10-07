import { authenticatedAccess } from "./authenticated-access";
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
 * The provider rows are the one read that overlaps the others. It starts in
 * step 1 because every served request needs them, and it is awaited inside
 * step 3 beside the credential, so the rows are cached by the time step 4 reads
 * them; its failure is left to step 4, which reports it against the instance it
 * was asked for. Everything that refuses earlier — the account, the app, the
 * credential — is still the error the client sees.
 */

import type { Context, Handler } from "hono";
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


async function serve(
  c: ServedContext,
  providerSlug: string | undefined,
  prepare: (input: PrepareInput) => Promise<ExecutionPlan>,
): Promise<Response> {
  const timings: ServedTimings = { authMs: 0, limiterMs: 0 };
  c.set("servedTimings", timings);
  const { app, identity, credentialHeader } = await authenticatedAccess({ env: c.env, deployment: c.get("deployment"), headers: c.req.raw.headers, appId: c.req.param("app"), providerSlug, timings });
  const plan = await prepare({ env: c.env, request: c.req.raw, app, identity, credentialHeader });
  const appVersion = c.req.header("x-app-version") ?? null;
  const waitUntil = (promise: Promise<unknown>) => c.executionCtx.waitUntil(promise);
  await admitRequest(
    {
      env: c.env,
      deployment: c.get("deployment"),
      billingCache: c.get("billingRequestCache"),
      app,
      identity,
      plan,
      appVersion,
      waitUntil,
    },
    (durationMs) => {
      timings.limiterMs = durationMs;
    },
  );
  return execute(plan, { env: c.env, app, identity, appVersion, timings, waitUntil });
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

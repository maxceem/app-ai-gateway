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
import { readBodyLimited } from "../providers/request-body";
import type { RequestVariables } from "../middleware/request-scope";
import { authenticatedAccess } from "./authenticated-access";
import { admitRequest } from "./admission";
import { execute } from "./execute";
import type { ExecutionPlan } from "./plan";
import { prepareEndpointPlan, prepareProxyPlan, type PrepareInput } from "./prepare";
import type { ServedTimings } from "./timing";
import { contained } from "../core/background";
import { readConversationHeaders } from "../conversations/client-headers";
import { planIncludes } from "../billing/features";
import { getBillingAccess } from "../billing/gateway";

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

async function serve(
  c: ServedContext,
  providerSlug: string | undefined,
  prepare: (input: PrepareInput) => Promise<ExecutionPlan>,
): Promise<Response> {
  const timings: ServedTimings = {};
  c.set("servedTimings", timings);
  const body = bodyOnce(c.req.raw);
  const { app, identity, credentialHeader, assertionCounter } = await authenticatedAccess({
    env: c.env,
    deployment: c.get("deployment"),
    appId: c.req.param("app"),
    request: c.req.raw,
    body,
    providerSlug,
    timings,
  });
  // Read after the credential, so an unauthenticated caller learns nothing
  // from a refusal of its headers; before the plan, so a malformed one is
  // refused before anything is spent on the request.
  const conversation = readConversationHeaders(c.req.raw.headers);
  // Timed whether it succeeds or refuses, as every step is.
  const prepareStart = performance.now();
  let plan: ExecutionPlan;
  try {
    plan = await prepare({ env: c.env, request: c.req.raw, body, app, identity, credentialHeader });
  } finally {
    timings.prepareMs = performance.now() - prepareStart;
  }
  const appVersion = c.req.header("x-app-version") ?? null;
  const waitUntil = (promise: Promise<unknown>) => c.executionCtx.waitUntil(contained("served_request", promise));
  const limiterStart = performance.now();
  try {
    await admitRequest({
      env: c.env,
      deployment: c.get("deployment"),
      billingCache: c.get("billingRequestCache"),
      app,
      identity,
      assertionCounter,
      plan,
      appVersion,
      waitUntil,
    });
  } finally {
    timings.limiterMs = performance.now() - limiterStart;
  }
  // Conversation storage needs the app to have turned it on, the deployment to
  // have somewhere to keep it, the client not to have opted this request out,
  // and the account's plan to include it: an app that turned it on under a plan
  // that did keeps its setting, and stores nothing while its plan does not.
  // Admission has just read the plan into the request's cache, so asking
  // again reads nothing.
  const capture = app.config.conversations.store
    && c.env.CONVERSATIONS !== undefined
    && !conversation.optedOut
    && planIncludes(
      await getBillingAccess(c.get("deployment"), app.organizationId, c.get("billingRequestCache")),
      "conversationStorage",
    )
    ? { contentType: c.req.header("content-type") ?? "", keep: app.config.conversations.keep, body }
    : null;
  return execute(plan, {
    env: c.env,
    app,
    identity,
    appVersion,
    timings,
    waitUntil,
    clientTraceId: conversation.clientTraceId,
    capture,
  });
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

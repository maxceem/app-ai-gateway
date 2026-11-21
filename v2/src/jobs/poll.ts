/**
 * Polling a job through the gateway (plan D9): `GET /v2/apps/{app}/jobs/{job}/status`
 * and `GET /v2/apps/{app}/jobs/{job}` for its result.
 *
 * - The caller is checked as for any request, but a poll is free: it is not
 *   admitted, so it uses no request limit and no plan allowance, and writes
 *   no charge.
 * - The job id is checked by its signature, then against the caller: the
 *   same app and the same end user. A job id that fails either is answered as
 *   unknown, so it says nothing about other apps' jobs.
 * - The upstream URL is built from the signed id, never from the path.
 * - A result call that is final settles the job, after the answer is sent.
 */
import { assertAppActive, loadApp } from "../apps/app-records.ts";
import { GatewayError } from "../core/errors.ts";
import { connectionDescription, loadConnection } from "../providers/connections.ts";
import { clientResponseHeaders } from "../proxy/headers.ts";
import { serveCaller, type ProxyContext } from "../proxy/serve.ts";
import { readJobId, userDigest, type JobClaims } from "./job-id.ts";
import { fetchJob, gatewayLinks, jobContext, settleJobFromResult, withGatewayLinks } from "./jobs.ts";

function unknownJob(): GatewayError {
  return new GatewayError(404, "job_not_found", "No such job for this app");
}

/** Whether the claims name this app and this caller's end user, compared by digest. */
async function ownedBy(claims: JobClaims, app: { readonly id: string; readonly accountId: string }, userId: string | null): Promise<boolean> {
  return claims.appId === app.id && claims.accountId === app.accountId && claims.userDigest === (await userDigest(userId));
}

/** The handler for one kind of poll. */
export function jobPollHandler(which: "status" | "result") {
  return async (c: ProxyContext): Promise<Response> => {
    const startedAt = Date.now();
    const appId = c.req.param("app");
    const jobId = c.req.param("job");
    if (!appId || !jobId) throw new GatewayError(400, "invalid_request", "App id and job id are required");
    const app = await loadApp(c.env, appId);
    assertAppActive(app);
    // The signature is checked before the caller, at no D1 cost, so a made-up
    // id loads nothing. Its answer waits until the caller is known.
    const claims = await readJobId(c.env.JWT_SECRET, jobId);
    const named = claims !== null && claims.appId === app.id ? await loadConnection(c.env, app.accountId, claims.slug) : null;
    const description = named === null ? null : connectionDescription(named);

    return serveCaller(
      c,
      {
        app,
        startedAt,
        providerSlug: claims?.slug ?? "",
        ...(description === null ? {} : { providerAuthHeader: description.auth.header }),
      },
      async (caller) => {
        if (claims === null || !(await ownedBy(claims, app, caller.identity.userId))) throw unknownJob();
        caller.facts.operation = claims.operation;
        caller.facts.model = claims.model;
        const context = await jobContext(c.env, claims);
        if (context === null) throw unknownJob();
        if (context.connection.status === "disabled") {
          throw new GatewayError(502, "provider_disabled", `Provider connection ${claims.slug} is disabled`);
        }
        const { response, keyHeader } = await fetchJob(c.env, context, which, claims, caller.identity.userId);
        const headers = clientResponseHeaders(response.headers, keyHeader);
        const text = await response.text();
        let body: unknown = null;
        try {
          body = text === "" ? null : (JSON.parse(text) as unknown);
        } catch {
          body = null;
        }
        if (which === "result") {
          const now = Date.now();
          c.executionCtx.waitUntil(
            settleJobFromResult(c.env, claims, jobId, context.spec, { status: response.status, headers: response.headers, body }, now),
          );
        }
        // A status answer's links point at the gateway, as the submit answer's do.
        if (which === "status" && typeof body === "object" && body !== null && !Array.isArray(body)) {
          const links = gatewayLinks(new URL(c.req.url).origin, app.id, jobId);
          headers.delete("content-length");
          headers.delete("content-encoding");
          headers.set("content-type", "application/json");
          return new Response(JSON.stringify(withGatewayLinks(body as Record<string, unknown>, context.spec, links, jobId)), {
            status: response.status,
            headers,
          });
        }
        headers.delete("content-length");
        headers.delete("content-encoding");
        return new Response(text, { status: response.status, headers });
      },
    );
  };
}

export const jobStatusHandler = jobPollHandler("status");
export const jobResultHandler = jobPollHandler("result");

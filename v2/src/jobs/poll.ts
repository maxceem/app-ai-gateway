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
 * - The provider's answer goes back as it came: binary bodies and bodiless
 *   answers too. Only a status answer's links are rewritten, and no cache may
 *   keep either answer (`Cache-Control: no-store`).
 */
import { assertAppActive, loadApp } from "../apps/app-records.ts";
import { GatewayError } from "../core/errors.ts";
import { connectionDescription, loadConnection } from "../providers/connections.ts";
import { clientResponseHeaders, noStore } from "../proxy/headers.ts";
import { serveCaller, type ProxyContext } from "../proxy/serve.ts";
import { readJobId, userDigest, type JobClaims } from "./job-id.ts";
import { applyFinalResult, boundedJson, countedBody, countNeedsBody, fetchJob, gatewayLinks, jobContext, jobResultFacts, withGatewayLinks } from "./jobs.ts";

/** Statuses whose answer can have no body. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

/** Bytes read as JSON, or null when they are not JSON. */
function jsonOf(bytes: ArrayBuffer): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

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
        headers.delete("content-length");
        headers.delete("content-encoding");
        // A job's answer is the caller's own: no cache may keep it.
        noStore(headers);
        const bodiless = NULL_BODY_STATUSES.has(response.status);
        if (which === "result") {
          if (context.spec.finalStatuses.includes(response.status)) {
            // When the operation counts outputs, a copy of the body is read to count
            // them, at most OUTPUTS_READ_LIMIT bytes, in the background: the app gets
            // the body itself, untouched, and never waits on the count.
            const copy = !bodiless && countNeedsBody(context.spec) ? response.clone() : null;
            const ref = { job: claims.job, accountId: claims.accountId, appId: claims.appId };
            const now = Date.now();
            c.executionCtx.waitUntil(
              (async () => {
                const read = copy === null ? null : await boundedJson(copy);
                // A copy cut off while reading counts nothing: the job's check stays, and the sweep reads it again.
                if (read?.kind === "read_error") return;
                const body = read === null ? null : countedBody(read);
                const facts = jobResultFacts(context.spec, { status: response.status, headers: response.headers, body });
                if (facts !== null) await applyFinalResult(c.env, ref, facts, now);
              })(),
            );
          }
          return new Response(bodiless ? null : response.body, { status: response.status, headers });
        }
        // A status answer's links point at the gateway, as the submit answer's do.
        const bytes = bodiless ? null : await response.arrayBuffer();
        const body = bytes === null ? null : jsonOf(bytes);
        if (typeof body === "object" && body !== null && !Array.isArray(body)) {
          const links = gatewayLinks(new URL(c.req.url).origin, app.id, jobId);
          headers.set("content-type", "application/json");
          return new Response(JSON.stringify(withGatewayLinks(body as Record<string, unknown>, context.spec, links, jobId)), {
            status: response.status,
            headers,
          });
        }
        return new Response(bytes, { status: response.status, headers });
      },
    );
  };
}

/**
 * Marks every poll answer `no-store`, refusals and errors included: a 404
 * kept by a shared cache for one caller could be served to the job's owner at
 * the same URL. A route middleware, so it also covers answers the error
 * handler writes.
 */
export const pollNoStore = async (c: { res: Response }, next: () => Promise<void>): Promise<void> => {
  await next();
  const headers = new Headers(c.res.headers);
  noStore(headers);
  c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
};

export const jobStatusHandler = jobPollHandler("status");
export const jobResultHandler = jobPollHandler("result");

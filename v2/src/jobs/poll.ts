/**
 * Polling a job through the gateway (plan D9): `GET /v2/apps/{app}/jobs/{job}/status`
 * and `GET /v2/apps/{app}/jobs/{job}` for its result, and cancelling it with
 * `PUT /v2/apps/{app}/jobs/{job}/cancel`.
 *
 * - The caller is checked as for any request, but a poll is free: it is not
 *   admitted, so it uses no request limit and no plan allowance, and writes
 *   no charge.
 * - The job id is checked by its signature, then against the caller: the
 *   same app and the same end user. A job id that fails either is answered as
 *   unknown, so it says nothing about other apps' jobs.
 * - The upstream URL is built from the signed id, never from the path.
 * - A result call that is final settles the job, after the answer is sent.
 * - A cancel is free too: it is only forwarded, writes nothing and settles
 *   nothing itself. The job settles on its status or result as any other. A
 *   result that confirms the cancel (`JobSpec.cancelled`) is final: billed
 *   units, when reported, settle it at the saved rate, and none means it cost
 *   nothing. A job cancelled while running usually finishes and is charged in
 *   full (T15).
 * - The provider's answer goes back as it came: binary bodies and bodiless
 *   answers too. Only a status answer's links are rewritten, and no cache may
 *   keep either answer (`Cache-Control: no-store`).
 * - A status answer too large to rewrite is never passed on as it came, since
 *   its links point at the provider: it is asked for again without the
 *   optional query fields (fal's `logs`), and if that is still too large, or
 *   its body stalls, the gateway answers with its own links only
 *   (`x-agw-status-trimmed`).
 * - A provider redirect is never passed on: one to this job's status or
 *   result becomes the gateway's own link, and any other is a provider error.
 */
import { assertAppActive, loadApp } from "../apps/app-records.ts";
import { parseJson, readBounded } from "../core/bounded-body.ts";
import { GatewayError } from "../core/errors.ts";
import { connectionDescription, loadConnection } from "../providers/connections.ts";
import { clientResponseHeaders, noStore } from "../proxy/headers.ts";
import { serveCaller, type ProxyContext } from "../proxy/serve.ts";
import { readJobId, userDigest, type JobClaims } from "./job-id.ts";
import {
  applyFinalResult,
  boundedJson,
  countsOutputs,
  fetchJob,
  gatewayLinks,
  gatewayRedirect,
  isFinalResult,
  JOB_BODY_READ_DEADLINE_MS,
  JOB_POLL_TIMEOUT_MS,
  jobContext,
  jobLocation,
  jobRedirectTargets,
  jobRequestFor,
  jobStatusQuery,
  readResultFacts,
  withGatewayLinks,
} from "./jobs.ts";

/** Statuses whose answer can have no body. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

function unknownJob(): GatewayError {
  return new GatewayError(404, "job_not_found", "No such job for this app");
}

/** Whether the claims name this app and this caller's end user, compared by digest. */
async function ownedBy(claims: JobClaims, app: { readonly id: string; readonly accountId: string }, userId: string | null): Promise<boolean> {
  return claims.appId === app.id && claims.accountId === app.accountId && claims.userDigest === (await userDigest(userId));
}

/** The handler for one kind of poll, or a cancel. */
export function jobPollHandler(which: "status" | "result" | "cancel") {
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
    // Every app's job ids are signed with the same secret: only an id this app's
    // account made may name a connection, here or in a refusal it records.
    const ours = claims !== null && claims.appId === app.id && claims.accountId === app.accountId;
    const named = ours ? await loadConnection(c.env, app.accountId, claims.slug) : null;
    const description = named === null ? null : connectionDescription(named);

    return serveCaller(
      c,
      {
        app,
        startedAt,
        providerSlug: ours ? claims.slug : null,
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
        jobRequestFor(context.spec, which);
        // Only the query fields the operation lists go upstream, and only on a status poll.
        const query = which === "status" ? jobStatusQuery(context.spec, new URL(c.req.url)) : "";
        const links = gatewayLinks(new URL(c.req.url).origin, app.id, jobId);
        // A cancel is only forwarded: the job settles on its status or result as any other.
        const { response, keyHeader, url } = await fetchJob(c.env, context, which, claims, caller.identity.userId, undefined, query);
        const headers = clientResponseHeaders(response.headers, keyHeader);
        jobLocation(headers, response.headers, url, jobRedirectTargets(context, claims), links);
        headers.delete("content-length");
        headers.delete("content-encoding");
        // A job's answer is the caller's own: no cache may keep it.
        noStore(headers);
        const redirect = redirectTo(response, url, context, claims, links, headers);
        if (redirect !== null) return redirect;
        const bodiless = NULL_BODY_STATUSES.has(response.status);
        if (which === "result") {
          if (isFinalResult(context.spec, response)) {
            // When the operation counts outputs, a copy of the body is read to count
            // them, at most BODY_READ_LIMIT bytes, in the background: the app gets
            // the body itself, untouched, and never waits on the count.
            const copy = !bodiless && countsOutputs(context.spec) ? response.clone() : null;
            const ref = { job: claims.job, accountId: claims.accountId, appId: claims.appId };
            const now = Date.now();
            c.executionCtx.waitUntil(
              (async () => {
                // The copy gets the sweep's body deadline: a body that stalls after a final
                // units header must not hold the count back, so the header is applied then.
                const read = copy === null ? null : await boundedJson(copy, { deadlineMs: JOB_BODY_READ_DEADLINE_MS });
                // The units header is applied even when the copy breaks. Whether the body is
                // still needed is decided with the estimate's rate; the job's check stays open.
                const facts = readResultFacts(context.spec, response, read);
                if (facts !== null) await applyFinalResult(c.env, ref, facts, now);
              })(),
            );
          }
          return new Response(bodiless ? null : response.body, { status: response.status, headers });
        }
        // A status answer's links point at the gateway, as the submit answer's do.
        let answer = response;
        let answerHeaders = headers;
        let read = bodiless || response.body === null ? null : await readBounded(response.body, { deadlineMs: JOB_POLL_TIMEOUT_MS });
        if (read !== null && read.kind === "too_large" && query !== "") {
          // Too large to rewrite, so never passed on with the provider's links in it.
          // Asked once more without the optional query fields (fal's `logs`).
          void read.stream.cancel().catch(() => undefined);
          const again = await fetchJob(c.env, context, "status", claims, caller.identity.userId);
          answer = again.response;
          answerHeaders = clientResponseHeaders(answer.headers, again.keyHeader);
          jobLocation(answerHeaders, answer.headers, again.url, jobRedirectTargets(context, claims), links);
          answerHeaders.delete("content-length");
          answerHeaders.delete("content-encoding");
          noStore(answerHeaders);
          const moved = redirectTo(answer, again.url, context, claims, links, answerHeaders);
          if (moved !== null) return moved;
          answerHeaders.set("x-agw-status-trimmed", "query");
          // A retry whose body stalls ends at the poll's own limit, never holding the app.
          read =
            NULL_BODY_STATUSES.has(answer.status) || answer.body === null
              ? null
              : await readBounded(answer.body, { deadlineMs: JOB_POLL_TIMEOUT_MS });
        }
        if (read !== null && (read.kind === "too_large" || read.kind === "stopped")) {
          // Still too large, or stalled: the gateway answers with its own links and the job id only.
          if (read.kind === "too_large") void read.stream.cancel().catch(() => undefined);
          answerHeaders.set("content-type", "application/json");
          answerHeaders.set("x-agw-status-trimmed", read.kind === "too_large" ? "body" : "stalled");
          const named = context.spec.links ?? {};
          const minimal: Record<string, unknown> = { [context.spec.requestIdField]: jobId };
          if (named.status !== undefined) minimal[named.status] = links.status;
          if (named.result !== undefined) minimal[named.result] = links.result;
          if (named.cancel !== undefined && context.spec.cancel !== undefined) minimal[named.cancel] = links.cancel;
          return new Response(JSON.stringify(minimal), { status: answer.status, headers: answerHeaders });
        }
        if (read !== null && read.kind === "read_error") throw read.error;
        const bytes = read !== null && read.kind === "whole" ? read.bytes : null;
        const body = bytes === null ? null : (parseJson(bytes) ?? null);
        if (typeof body === "object" && body !== null && !Array.isArray(body)) {
          answerHeaders.set("content-type", "application/json");
          return new Response(JSON.stringify(withGatewayLinks(body as Record<string, unknown>, context.spec, links, jobId)), {
            status: answer.status,
            headers: answerHeaders,
          });
        }
        return new Response(bytes, { status: answer.status, headers: answerHeaders });
      },
    );
  };
}

/**
 * A provider redirect turned into the gateway's own link, as an answer with
 * no body; null when the answer is not a redirect. A redirect anywhere other
 * than this job's status or result throws a provider error.
 */
function redirectTo(
  response: Response,
  requestUrl: string,
  context: Parameters<typeof gatewayRedirect>[2],
  claims: Parameters<typeof gatewayRedirect>[3],
  links: Parameters<typeof gatewayRedirect>[4],
  headers: Headers,
): Response | null {
  const location = gatewayRedirect(response, requestUrl, context, claims, links);
  if (location === null) return null;
  headers.set("location", location);
  headers.delete("content-type");
  return new Response(null, { status: response.status, headers });
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
export const jobCancelHandler = jobPollHandler("cancel");
export const jobResultHandler = jobPollHandler("result");

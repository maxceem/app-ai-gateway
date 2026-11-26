/**
 * The job lifecycle (plan D9, sections 4.2 and 4.3), the same for every
 * provider. A provider says only where its follow-up requests go and how its
 * answers read (`JobSpec` in `../providers/operation.ts`).
 *
 * 1. **Submit**, through the gateway like any call: auth, the app's limits
 *    and the plan allowance. The provider's answer gets a job id the gateway
 *    signs (`./job-id.ts`), and polling links that point at the gateway.
 * 2. **The estimate.** One `estimate` charge, priced from the request with the
 *    price file's or the customer's rates, counts at once. A job-check row
 *    with a due time is written in the same batch.
 * 3. **Polls** through the gateway are free and count toward no limit
 *    (`./poll.ts`). The upstream URL is built from the signed id.
 * 4. **Settlement**, from the final figure only: the billed units on the
 *    result call, priced with the rates stored on the estimate. One
 *    correction per job, with a stable id, so a client poll and the sweep
 *    never both add it, and only once the estimate is in the ledger.
 *    A figure that cannot settle yet is its own open-work row, written once
 *    and never changed (`figureWork`): nothing ever edits a saved figure, so
 *    no reader can act on a stale one.
 * 5. **The sweep** checks jobs no client polled, earliest due first, and
 *    settles the saved figures.
 *
 * A submission whose answer was lost is never sent again: it keeps its
 * estimate, marked `estimated`, and is logged (T15).
 */
import { chargeStore } from "../ledger/charge-store.ts";
import { withDeadline } from "../core/background.ts";
import { errorFacts } from "../core/error-facts.ts";
import { GatewayError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { timeOfOrderedId } from "../core/ids.ts";
import { bookingTooLate } from "../ledger/late-booking.ts";
import { jobEstimateCharge, jobSettled, settleJobFrom, type FinalFigure } from "../ledger/corrections.ts";
import type { ChargeStatus } from "../ledger/labels.ts";
import type { HandlerResult, OpenWorkHandler } from "../ledger/sweep.ts";
import { KEY_COPIES_FIELD, utcDay, writeOpenWork, type ChargeRow, type LedgerEntry, type OpenWorkRow } from "../ledger/write.ts";
import { listedUnitRate } from "../pricing/billability.ts";
import { scaledCount, UNIT_RATES } from "../pricing/units.ts";
import { parseJson, readBounded } from "../core/bounded-body.ts";
import { connectionDescription, loadConnection, readConnection, sealedCredentials, withStoredCopies, type ConnectionRecord, type SealedCredentials } from "../providers/connections.ts";
import { UNITS, type JobRequest, type JobSpec, type OperationDescription, type ProviderDescription, type Unit } from "../providers/operation.ts";
import { normalizePath } from "../providers/path.ts";
import { BUILT_IN_PROVIDERS } from "../providers/index.ts";
import { sealedUpstreamRequest, upstreamUrl } from "../providers/route.ts";
import { safeCharge, type CallAttempt } from "../proxy/call-charge.ts";
import { attemptUsage, headerNumber } from "../proxy/meter.ts";
import { jobSigningReady, readJobId, routeDigest, type JobClaims } from "./job-id.ts";
import { vault, type CopyRequest, type StoredCopies } from "../vault/client.ts";
import type { KeyShare } from "../vault/key-share.ts";

/** When the sweep first checks a job. fal keeps results for an hour, large ones for 6 minutes (T15). */
export const JOB_FIRST_CHECK_MS = 2 * 60 * 1000;

/** How often the sweep checks a job again, when its operation does not say. */
export const JOB_CHECK_EVERY_MS = 60 * 1000;
/** How many checks before the sweep gives up on a job, when its operation does not say. */
export const JOB_MAX_CHECKS = 60;

/** How long a poll of the provider may take. */
export const JOB_POLL_TIMEOUT_MS = 30_000;

/** A provider's request id the gateway will put in a URL: one plain segment, never `.` or `..`. */
const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/u;

/** The open-work row that checks one job. */
export function jobCheckId(job: string): string {
  return `job:${job}`;
}

/** The provider's request id in a submit answer, or null when it has none the gateway can use. */
export function providerRequestId(spec: JobSpec, body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>)[spec.requestIdField];
  if (typeof value !== "string" || !REQUEST_ID.test(value) || value === "." || value === "..") return null;
  // Every follow-up path it fills must pass the path rules, so the URL means what the gateway signed.
  for (const request of [spec.status, spec.result, ...(spec.cancel === undefined ? [] : [spec.cancel])]) {
    if (!normalizePath(jobRequestPath(request, { model: "m", requestId: value })).ok) return null;
  }
  return value;
}

/**
 * A job's estimate: one charge priced from the request, as a call whose
 * answer reported nothing is, and the open work written with it. With a
 * signed id, the sweep is asked to check the job; without one (the answer
 * was lost), the estimate stays.
 */
export function jobEstimate(
  attempt: CallAttempt,
  operation: OperationDescription,
  input: {
    readonly status: ChargeStatus;
    readonly httpStatus: number | null;
    readonly latencyMs: number | null;
    readonly signedId: string | null;
    readonly now: number;
  },
): LedgerEntry {
  const measured = attemptUsage(
    operation,
    { ...attempt, listedRate: (unit: Unit) => listedUnitRate(attempt.providerType, attempt.model, unit) },
    null,
    new Headers(),
  );
  // The request's measure is the estimate itself, not a report that went missing.
  const usage = measured === null ? null : (({ reportMissing: _missing, ...rest }) => rest)(measured);
  // Priced as any charge is: a pricing failure still writes it, unpriced and logged, never failing the job.
  const call = safeCharge(
    attempt,
    { status: input.status, httpStatus: input.httpStatus, errorCode: null, usage, cut: false, latencyMs: input.latencyMs },
    input.now,
  );
  const job = attempt.requestId;
  const charge: ChargeRow = {
    ...call.charge,
    kind: "estimate",
    ownerType: "job",
    ownerId: job,
    measured: "estimated",
    priceIsEstimate: call.charge.costNano !== null || call.charge.priceIsEstimate,
  };
  const openWork: OpenWorkRow[] = call.openWork.map((work) => ({ ...work, ownerType: "job", ownerId: job }));
  if (input.signedId !== null) {
    openWork.push({
      id: jobCheckId(job),
      kind: "job_check",
      accountId: attempt.accountId,
      appId: attempt.appId,
      ownerType: "job",
      ownerId: job,
      chargeId: charge.id,
      detail: { jobId: input.signedId, ...checkPace(operation.job) },
      dueAt: input.now + JOB_FIRST_CHECK_MS,
      createdAt: input.now,
    });
  }
  return { charge, openWork };
}

/**
 * How long a job's key copy opens: the sweep's whole schedule for a job
 * (first check, then a check a minute) and a few minutes over (plan step 8j:
 * about 62 minutes for fal).
 */
export const JOB_KEY_COPY_MS = JOB_FIRST_CHECK_MS + JOB_MAX_CHECKS * JOB_CHECK_EVERY_MS + 5 * 60_000;
/** How long making the copy may take: it runs after the answer is sent, and never fails the job. */
export const JOB_KEY_COPY_DEADLINE_MS = 5_000;

/**
 * For an account with split keys on, the sweep cannot open the job's key
 * later: no app request brings a credential then. So when the job is
 * submitted, the vault makes copies of its connection's credentials, sealed
 * with the KEK alone until `JOB_KEY_COPY_MS` from now, and they go on the
 * job's check row, which is deleted when the job is settled (plan step 8j,
 * "Keys needed with no app request"). If the copy cannot be made, the row
 * says so: the sweep then ends the check and the estimate stays. Nothing
 * changes for an account with split keys off.
 */
export async function withJobKeyCopies(env: Env, entry: LedgerEntry, credentials: SealedCredentials, now: number): Promise<LedgerEntry> {
  const credential = credentials.credential;
  const check = entry.openWork.find((work) => work.kind === "job_check");
  if (credential === undefined || check === undefined) return entry;
  let copies: StoredCopies | "missing";
  try {
    copies = await withDeadline(
      vault(env).storeCopy(
        {
          ...(credentials.providerKey === null ? {} : { providerKey: credentials.providerKey as CopyRequest["providerKey"] & object }),
          ...(credentials.cloudflareToken === null ? {} : { cloudflareToken: credentials.cloudflareToken as CopyRequest["cloudflareToken"] & object }),
          credential,
        },
        now + JOB_KEY_COPY_MS,
      ),
      JOB_KEY_COPY_DEADLINE_MS,
      "copying the job's key",
    );
  } catch (error) {
    log("warn", "job_key_copy_failed", { app: check.appId, job: check.ownerId, error: errorFacts(error) });
    copies = "missing";
  }
  const withCopies: OpenWorkRow = { ...check, detail: { ...check.detail, [KEY_COPIES_FIELD]: copies } };
  return { ...entry, openWork: entry.openWork.map((work) => (work === check ? withCopies : work)) };
}

/**
 * A check row's key copies: the copies; "missing" when they could not be made
 * or were removed (`removed`, past their expiry, `../ledger/sweep.ts`); or
 * null for an account with split keys off.
 */
function keyCopiesOf(detail: Record<string, unknown>): StoredCopies | "missing" | null {
  const value = detail[KEY_COPIES_FIELD];
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") return "missing";
  return value as StoredCopies;
}

/**
 * How often the sweep checks a job, and how many times: from the operation,
 * so a provider whose results expire soon is checked often. The sweep reads
 * these from the row (`retryEveryMs`, `maxTries`) for any kind of work.
 */
function checkPace(spec: JobSpec | undefined): { readonly retryEveryMs: number; readonly maxTries: number } {
  return { retryEveryMs: spec?.checkEveryMs ?? JOB_CHECK_EVERY_MS, maxTries: spec?.maxChecks ?? JOB_MAX_CHECKS };
}

/** The gateway's links for a job. */
export interface GatewayLinks {
  readonly status: string;
  readonly result: string;
  readonly cancel: string;
}

/** The gateway's links for a job id, under the app's own path. */
export function gatewayLinks(origin: string, appId: string, jobId: string): GatewayLinks {
  const base = `${origin}/v2/apps/${encodeURIComponent(appId)}/jobs/${jobId}`;
  return { status: `${base}/status`, result: base, cancel: `${base}/cancel` };
}

/**
 * A provider's answer with its links pointing at the gateway, and its request
 * id replaced by the gateway's job id. A cancel link is the gateway's own when
 * the operation can cancel, and removed when it cannot. Only fields already in
 * the answer are touched.
 */
export function withGatewayLinks(body: Record<string, unknown>, spec: JobSpec, links: GatewayLinks, jobId: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  const named = spec.links ?? {};
  if (named.status !== undefined && Object.hasOwn(out, named.status)) out[named.status] = links.status;
  if (named.result !== undefined && Object.hasOwn(out, named.result)) out[named.result] = links.result;
  if (named.cancel !== undefined && Object.hasOwn(out, named.cancel)) {
    if (spec.cancel === undefined) delete out[named.cancel];
    else out[named.cancel] = links.cancel;
  }
  if (Object.hasOwn(out, spec.requestIdField)) out[spec.requestIdField] = jobId;
  return out;
}

/** A job's own follow-up endpoints. */
export type JobEndpoint = "status" | "result" | "cancel";

/**
 * The follow-up request for one of a job's endpoints. The one check that a
 * job can be cancelled: an operation with no cancel request answers 404.
 */
export function jobRequestFor(spec: JobSpec, which: JobEndpoint): JobRequest {
  const request = which === "cancel" ? spec.cancel : spec[which];
  if (request === undefined) throw new GatewayError(404, "job_not_found", "This job cannot be cancelled");
  return request;
}

/**
 * The upstream URL of one of a job's endpoints, without a query: where
 * `fetchJob` sends that request, built from the signed claims alone.
 */
export function jobEndpointUrl(context: JobContext, which: JobEndpoint, claims: Pick<JobClaims, "model" | "requestId">): string {
  const request = jobRequestFor(context.spec, which);
  return upstreamUrl(context.connection, context.description, { hostKey: request.host ?? "main", path: jobRequestPath(request, claims), query: "" });
}

/**
 * The one rule for a provider's redirect on any job route (submit, status,
 * result). A provider's `Location` never reaches the app, for any 3xx status.
 * A redirect whose destination is exactly one of `allowed` (the same origin and
 * path) names that endpoint; any other redirect, a missing or unreadable
 * `Location` included, is logged as `event` and refused with a provider
 * error. Null when the answer is not a redirect.
 */
export function providerRedirect(
  response: Response,
  requestUrl: string,
  allowed: ReadonlyArray<readonly [JobEndpoint, string]>,
  event: "job_poll_redirect_refused" | "job_submit_redirect_refused",
  facts: Readonly<Record<string, unknown>>,
): JobEndpoint | null {
  if (response.status < 300 || response.status > 399) return null;
  void response.body?.cancel().catch(() => undefined);
  const which = endpointAt(response.headers.get("location"), requestUrl, allowed);
  if (which !== null) return which;
  log("warn", event, { ...facts, status: response.status });
  throw new GatewayError(502, "provider_error", "The provider answered with a redirect the gateway cannot follow");
}

/**
 * Which of `allowed` a provider's `Location` points at exactly (the same
 * origin and path); null for none, a missing or unreadable `Location`
 * included. A relative `Location` needs `requestUrl` to resolve; without one
 * it matches nothing.
 */
function endpointAt(location: string | null, requestUrl: string, allowed: ReadonlyArray<readonly [JobEndpoint, string]>): JobEndpoint | null {
  if (location === null) return null;
  let target: URL;
  try {
    target = requestUrl === "" ? new URL(location) : new URL(location, requestUrl);
  } catch {
    return null;
  }
  const where = `${target.origin}${target.pathname}`;
  for (const [which, url] of allowed) {
    const expected = new URL(url);
    if (where === `${expected.origin}${expected.pathname}`) return which;
  }
  return null;
}

/**
 * The `Location` a job answer that is not a redirect (a submit's 202, a
 * status or result answer) carries to the app. The provider's own never goes
 * on; when it pointed exactly at one of `allowed`, the gateway's link for that
 * endpoint takes its place.
 */
export function jobLocation(
  headers: Headers,
  upstream: Headers,
  requestUrl: string,
  allowed: ReadonlyArray<readonly [JobEndpoint, string]>,
  links: GatewayLinks,
): void {
  const which = endpointAt(upstream.get("location"), requestUrl, allowed);
  headers.delete("location");
  if (which !== null) headers.set("location", links[which]);
}

/** This job's status and result URLs, the only places a poll's redirect may point. */
export function jobRedirectTargets(context: JobContext, claims: Pick<JobClaims, "model" | "requestId">): ReadonlyArray<readonly [JobEndpoint, string]> {
  return (["status", "result"] as const).map((which) => [which, jobEndpointUrl(context, which, claims)] as const);
}

/**
 * A poll's provider redirect turned into the gateway's own link for the same
 * endpoint; null when the answer is not a redirect. Any other redirect throws.
 */
export function gatewayRedirect(response: Response, requestUrl: string, context: JobContext, claims: JobClaims, links: GatewayLinks): string | null {
  const which = providerRedirect(response, requestUrl, jobRedirectTargets(context, claims), "job_poll_redirect_refused", {
    app: claims.appId,
    providerSlug: claims.slug,
  });
  return which === null ? null : links[which];
}

/** The provider-relative path of a follow-up request, built from the signed claims alone. */
export function jobRequestPath(request: JobRequest, claims: Pick<JobClaims, "model" | "requestId">): string {
  const modelSegments = claims.model.split("/").map((segment) => encodeURIComponent(segment));
  const values: Record<string, string> = {
    request_id: encodeURIComponent(claims.requestId),
    model: modelSegments.join("/"),
    model_base: modelSegments.slice(0, 2).join("/"),
  };
  return request.path.replace(/\{(request_id|model_base|model)\}/gu, (_whole, name: string) => values[name]!);
}

/** What a job id stands for, loaded: its connection, provider and operation. */
export interface JobContext {
  readonly connection: ConnectionRecord;
  readonly description: ProviderDescription;
  readonly operation: OperationDescription;
  readonly spec: JobSpec;
}

/**
 * The connection and operation behind a job, or null when they are gone or
 * changed. With `fresh`, the connection is read from D1 now, not from this
 * isolate's cache (the sweep, which must see a status just changed); that read
 * throws when D1 cannot answer.
 */
export async function jobContext(env: Env, claims: JobClaims, options: { readonly fresh?: boolean } = {}): Promise<JobContext | null> {
  const connection = options.fresh === true ? await readConnection(env, claims.accountId, claims.slug) : await loadConnection(env, claims.accountId, claims.slug);
  // A connection made again under the same slug is another key: its jobs are not this one's.
  if (connection === null || connection.id !== claims.connectionId) return null;
  // A connection that now points somewhere else may have another job under the same request id.
  if ((await routeDigest(connection)) !== claims.route) return null;
  const description = connectionDescription(connection);
  const operation = description?.operations.find((one) => one.name === claims.operation);
  if (description === null || operation === undefined || operation.lifecycle !== "job" || operation.job === undefined) return null;
  return { connection, description, operation, spec: operation.job };
}

/**
 * What opens a job's key: for a client poll, the credential the poll brought
 * (`share`); for the sweep, which has no app request, the copies made when
 * the job was submitted (`copies`), for an account with split keys on (plan
 * step 8j). Neither, for an account with split keys off.
 */
export interface JobKeys {
  readonly share?: KeyShare | null | undefined;
  readonly copies?: StoredCopies | null | undefined;
}

/**
 * A follow-up request to the provider, with the connection's key, never
 * following a redirect. The vault adds the key and sends it (plan step 8i):
 * this Worker never opens it. `userId` is the polling caller's own end user,
 * or null from the sweep: a job id carries only its digest.
 */
export async function fetchJob(
  env: Env,
  context: JobContext,
  which: JobEndpoint,
  claims: JobClaims,
  userId: string | null,
  signal?: AbortSignal,
  query = "",
  keys: JobKeys = {},
): Promise<{ readonly response: Response; readonly keyHeader: string; readonly url: string }> {
  const request = jobRequestFor(context.spec, which);
  // Once the sweep's time for the item is up, no more provider calls start.
  signal?.throwIfAborted();
  const target = sealedUpstreamRequest(context.connection, context.description, {
    hostKey: request.host ?? "main",
    path: jobRequestPath(request, claims),
    query,
    credentials:
      keys.copies === undefined || keys.copies === null
        ? sealedCredentials(context.connection, keys.share)
        : withStoredCopies(sealedCredentials(context.connection), keys.copies),
    client: new Headers(),
    appId: claims.appId,
    userId,
  });
  // The caller's signal (the sweep item's time) stops the request only until its
  // headers arrive. After that the answer is in hand, and its body is bounded by
  // the reader's own deadline: an item that runs out of time never cuts off a
  // final result it already has.
  // So does the poll's own time limit: a slow body read is never cut off by it.
  const untilHeaders = new AbortController();
  const stop = () => untilHeaders.abort(signal?.reason);
  signal?.addEventListener("abort", stop, { once: true });
  const deadline = Date.now() + JOB_POLL_TIMEOUT_MS;
  const timer = setTimeout(() => untilHeaders.abort(new Error("job poll timed out")), JOB_POLL_TIMEOUT_MS);
  try {
    const response = await vault(env).call({
      url: target.url,
      method: request.method,
      headers: new Headers(target.headers),
      body: null,
      signal: untilHeaders.signal,
      deadline,
      credentials: target.credentials,
    });
    return { response, keyHeader: target.keyHeader, url: target.url };
  } catch (error) {
    // The vault's own refusal (the key does not open, or the address is not one it is sealed for) is already a 502.
    if (error instanceof GatewayError) throw error;
    log("warn", "job_poll_failed", { app: claims.appId, providerSlug: claims.slug, which, error: errorFacts(error) });
    throw new GatewayError(502, "provider_error", "Provider request failed");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

/**
 * The query a client's status poll may pass on to the provider: only the
 * fields the operation lists (`statusQuery`, such as fal's `logs`), as a
 * query string with its `?`, or "". Nothing else from the client's URL is
 * ever sent upstream.
 */
export function jobStatusQuery(spec: JobSpec, url: URL): string {
  const allowed = spec.statusQuery ?? [];
  const out = new URLSearchParams();
  for (const [name, value] of url.searchParams) if (allowed.includes(name)) out.append(name, value);
  const text = out.toString();
  return text === "" ? "" : `?${text}`;
}

/** The status answer says the job is done, so its result can be read. */
export function jobDone(spec: JobSpec, body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const value = (body as Record<string, unknown>)[spec.doneWhen.field];
  return typeof value === "string" && spec.doneWhen.values.includes(value);
}

/** Whether the operation counts the outputs of a result (`JobSpec.outputs`). */
export function countsOutputs(spec: JobSpec): boolean {
  return (spec.outputs ?? []).length > 0;
}

/** The units a result's outputs can count in: every unit a built-in job operation declares for its outputs (`JobSpec.outputs`). */
const OUTPUT_UNITS: ReadonlySet<Unit> = new Set<Unit>(
  Object.values(BUILT_IN_PROVIDERS).flatMap((provider) => provider.operations.flatMap((operation) => (operation.job?.outputs ?? []).map((output) => output.unit))),
);

/** A result's outputs, counted by unit: images, videos. */
export type OutputCounts = Readonly<Partial<Record<Unit, number>>>;

/**
 * The outputs a result names, counted in each unit: for each unit, the first
 * output field of that unit the result has (fal answers `video` or `videos`).
 * A result with `images: []` and two videos counts 0 images and 2 videos.
 * Null when it names none the gateway can count.
 */
function outputCounts(spec: JobSpec, body: unknown): OutputCounts | null {
  if (typeof body !== "object" || body === null) return null;
  const counts: Partial<Record<Unit, number>> = {};
  for (const { field, unit } of spec.outputs ?? []) {
    if (counts[unit] !== undefined) continue;
    const outputs = (body as Record<string, unknown>)[field];
    if (outputs === undefined || outputs === null) continue;
    counts[unit] = Array.isArray(outputs) ? outputs.length : 1;
  }
  return Object.keys(counts).length === 0 ? null : counts;
}

/** What a final result says, kept small so a figure row can hold it. */
export interface JobResultFacts {
  readonly status: number;
  /** The billed units the provider reported, or null when it reported none. */
  readonly units: number | null;
  /** The outputs in the result, counted by unit, or null when it names none the gateway can count. */
  readonly outputs: OutputCounts | null;
  /**
   * The result confirms the job was cancelled (`JobSpec.cancelled`). With no
   * billed units, it is the provider's final word that the cancel cost
   * nothing, so it is free. With billed units, they settle it, and a price per
   * request counts it as one job. A units header that cannot be read never
   * marks a cancel: the estimate stays.
   */
  readonly cancelled?: true;
  /**
   * True when the body had to be read to count outputs, but could not be: cut
   * off, empty, or not whole JSON. Then a missing output count says nothing.
   * Never saved on a figure row.
   */
  readonly unread?: true;
}

/**
 * How long the sweep reads a result body for counting: well under the
 * sweep's item time limit, so the decision that follows a slow body still
 * lands while the item runs.
 */
export const JOB_BODY_READ_DEADLINE_MS = 2_000;

/** A body read for counting: parsed, larger than the limit, cut off while reading, empty, or not whole JSON. */
export type BodyRead =
  | { readonly kind: "parsed"; readonly value: unknown }
  | { readonly kind: "too_large" }
  | { readonly kind: "read_error" }
  | { readonly kind: "empty" }
  | { readonly kind: "unparseable" };

/**
 * A body read as JSON, at most `limit` bytes (`BODY_READ_LIMIT` by default),
 * so counting never holds a large result in memory. A read error, an empty
 * body and one that is not whole JSON all leave the outputs unread.
 */
export async function boundedJson(
  response: Response,
  options: { readonly limit?: number; readonly deadlineMs?: number; readonly signal?: AbortSignal } = {},
): Promise<BodyRead> {
  if (response.body === null) return { kind: "empty" };
  const read = await readBounded(response.body, options);
  switch (read.kind) {
    case "whole": {
      if (read.bytes.byteLength === 0) return { kind: "empty" };
      const value = parseJson(read.bytes);
      return value === undefined ? { kind: "unparseable" } : { kind: "parsed", value };
    }
    case "too_large":
      void read.stream.cancel().catch(() => undefined);
      return { kind: "too_large" };
    default:
      return { kind: "read_error" };
  }
}

/**
 * The facts of a final result, or null when its status is not final: from
 * its status, its headers and the body read done to count outputs (null when
 * the body was not read). A body that could not be read marks the facts
 * `unread`; the units header is read either way, so a header that settles the
 * estimate's rate is never lost to a broken body.
 */
export function readResultFacts(spec: JobSpec, response: Pick<Response, "status" | "headers">, read: BodyRead | null): JobResultFacts | null {
  const rawUnits = spec.unitsHeader === undefined ? null : response.headers.get(spec.unitsHeader);
  const units = headerNumber(rawUnits);
  // A confirmed cancel is final, whoever sent it. Billed units, when reported,
  // settle it; a header that is there but cannot be read keeps the estimate,
  // since only a missing header means the provider billed nothing.
  if (confirmsCancel(spec, response)) {
    if (rawUnits !== null && units === null) {
      log("warn", "job_units_unreadable", { status: response.status, header: spec.unitsHeader, value: rawUnits.slice(0, 64) });
      return { status: response.status, units: null, outputs: null };
    }
    return { status: response.status, units, outputs: null, cancelled: true };
  }
  if (!spec.finalStatuses.includes(response.status)) return null;
  const facts: JobResultFacts = {
    status: response.status,
    units,
    outputs: read !== null && read.kind === "parsed" ? outputCounts(spec, read.value) : null,
  };
  const unread = read !== null && (read.kind === "read_error" || read.kind === "empty" || read.kind === "unparseable");
  return unread ? { ...facts, unread: true } : facts;
}

/** Whether a result confirms the job was cancelled (`JobSpec.cancelled`): its status and its header both. */
function confirmsCancel(spec: JobSpec, response: Pick<Response, "status" | "headers">): boolean {
  const cancelled = spec.cancelled;
  return cancelled !== undefined && response.status === cancelled.status && response.headers.get(cancelled.header.name) === cancelled.header.value;
}

/** Whether a result is final, so it can settle the job: what `readResultFacts` answers non-null for, without reading or logging anything. */
export function isFinalResult(spec: JobSpec, response: Pick<Response, "status" | "headers">): boolean {
  return confirmsCancel(spec, response) || spec.finalStatuses.includes(response.status);
}

const succeeded = (facts: JobResultFacts) => facts.status >= 200 && facts.status < 300;
/**
 * A result that gives some count: billed units, outputs, on a success the one
 * job itself (a price per request), or a confirmed cancel, which may be free.
 */
const counted = (facts: JobResultFacts) => facts.units !== null || facts.outputs !== null || succeeded(facts) || facts.cancelled === true;

/** Saved facts read back, or null when they are not facts. */
function factsOf(value: unknown): JobResultFacts | null {
  if (typeof value !== "object" || value === null) return null;
  const facts = value as Record<string, unknown>;
  const count = (one: unknown) => one === null || (typeof one === "number" && Number.isFinite(one) && one >= 0);
  if (typeof facts.status !== "number" || !count(facts.units)) return null;
  const outputs = savedOutputs(facts.outputs);
  if (outputs === undefined) return null;
  // A saved figure was read whole: `unread` is never kept.
  return { status: facts.status, units: facts.units as number | null, outputs, ...(facts.cancelled === true ? { cancelled: true as const } : {}) };
}

/** Saved output counts read back, by unit. Undefined when they are not counts. */
function savedOutputs(value: unknown): OutputCounts | null | undefined {
  if (value === null || value === undefined) return null;
  const unitName = (one: unknown): one is Unit => typeof one === "string" && (UNITS as readonly string[]).includes(one);
  const countOf = (one: unknown) => typeof one === "number" && Number.isFinite(one) && one >= 0;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const counts: Partial<Record<Unit, number>> = {};
  for (const [unit, count] of Object.entries(value as Record<string, unknown>)) {
    if (!unitName(unit) || !countOf(count)) return undefined;
    counts[unit] = count as number;
  }
  return Object.keys(counts).length === 0 ? null : counts;
}

/**
 * The counts a result gives, by unit. A success is one job (a price per
 * request), with its outputs in their unit. Any other final result the
 * provider billed (positive units) is one job too. A failure is free only
 * when the provider reports 0 billed units, and a confirmed cancel when it
 * reports none: then every count is 0.
 */
function countsOf(facts: JobResultFacts): Partial<Record<Unit, number>> {
  const counts: Partial<Record<Unit, number>> = {};
  if (facts.units !== null) {
    const scaled = scaledCount("model_units", facts.units);
    if (Number.isSafeInteger(scaled)) counts.model_units = scaled;
  }
  if (succeeded(facts)) {
    counts.requests = 1;
    for (const [unit, count] of Object.entries(facts.outputs ?? {})) counts[unit as Unit] = count;
  } else if (facts.units !== null && facts.units > 0) {
    // A final result the provider billed (a failure or a cancel) is one billable job, for a price per request.
    counts.requests = 1;
  } else if (facts.units === 0 || facts.cancelled === true) {
    // Free: the provider reported 0 billed units, or confirmed a cancel and billed none.
    counts.model_units = 0;
    counts.requests = 0;
    for (const unit of OUTPUT_UNITS) counts[unit] = 0;
  }
  return counts;
}

/** The estimate's rate fields with their counts, and the fields no count fills; null when it stored no rates. */
function rateBuckets(estimate: ChargeRow, counts: Partial<Record<Unit, number>>): { buckets: Record<string, number>; missing: string[] } | null {
  const rates = estimate.rates;
  if (rates === null || Object.keys(rates).length === 0) return null;
  const buckets: Record<string, number> = {};
  const missing: string[] = [];
  for (const field of Object.keys(rates)) {
    const unit = UNIT_RATES.find((one) => one.field === field)?.units.find((one) => counts[one] !== undefined);
    if (unit === undefined) missing.push(field);
    else buckets[field] = counts[unit]!;
  }
  return { buckets, missing };
}

/**
 * The final figure of a job from its result's facts, priced with the rates
 * stored on the estimate, or null when the result gives none and the estimate
 * stays. Every rate the estimate stored must get a count: billed units from
 * the units header (fal's megapixels), never a missing header read as 0; the
 * outputs in the result, for a rate per output, on a success only; a failure
 * is free only when the provider reports 0 billed units (T15: fal's units
 * expire).
 */
export function jobFinalFigure(estimate: ChargeRow, facts: JobResultFacts): FinalFigure | null {
  const counts = countsOf(facts);
  const parts = rateBuckets(estimate, counts);
  if (parts === null || parts.missing.length > 0) return null;
  const units = estimate.unit === null ? undefined : counts[estimate.unit as Unit];
  return { kind: "units", buckets: parts.buckets, ...(units !== undefined ? { units } : {}) };
}

/** What a result means for a job, given its estimate's rates. */
export type FigureDecision =
  /** Every rate gets a count: settle. */
  | { readonly kind: "settle"; readonly final: FinalFigure }
  /** A success that lacks only an output count: reading its body may settle it. */
  | { readonly kind: "needs_outputs" }
  /** Nothing this result can give settles it: the estimate stays. */
  | { readonly kind: "never" };

/**
 * The one decision over a job's estimate and a result's facts. A rate per
 * billed unit with no units header gets nothing from a body, so only a
 * success whose missing counts are all outputs is `needs_outputs`.
 */
export function decideFigure(estimate: ChargeRow, facts: JobResultFacts): FigureDecision {
  const final = jobFinalFigure(estimate, facts);
  if (final !== null) return { kind: "settle", final };
  if (!succeeded(facts) || facts.outputs !== null) return { kind: "never" };
  const parts = rateBuckets(estimate, countsOf(facts));
  const onlyOutputs =
    parts !== null && parts.missing.every((field) => UNIT_RATES.find((one) => one.field === field)?.units.some((unit) => OUTPUT_UNITS.has(unit)) === true);
  return onlyOutputs ? { kind: "needs_outputs" } : { kind: "never" };
}

/** A job as its rows know it: enough to save and settle a figure, with no key and no connection. */
export interface JobRef {
  readonly job: string;
  readonly accountId: string;
  readonly appId: string;
}

/** How many times the sweep tries a saved figure: on its default backoff, longer than the failed-write store keeps an estimate. */
export const FIGURE_MAX_TRIES = 40;

const figurePart = (value: number | null) => (value === null ? "-" : String(value));

/** The id of a figure row. The figure is part of the id, so a different figure is a different row: nothing to overwrite. */
export function figureWorkId(job: string, facts: JobResultFacts): string {
  const entries = Object.entries(facts.outputs ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const outputs = entries.length === 0 ? "-" : entries.map(([unit, count]) => `${count}${unit}`).join("+");
  return `job_figure:${job}:${facts.status}:${figurePart(facts.units)}:${outputs}`;
}

/**
 * A job's final figure as its own open-work row, written once with
 * `ON CONFLICT(id) DO NOTHING` and never changed. Kind `job_check`, which the
 * sweep routes by id.
 */
export function figureWork(ref: JobRef, facts: JobResultFacts, now: number): OpenWorkRow {
  return {
    id: figureWorkId(ref.job, facts),
    kind: "job_check",
    accountId: ref.accountId,
    appId: ref.appId,
    ownerType: "job",
    ownerId: ref.job,
    chargeId: null,
    detail: {
      result: { status: facts.status, units: facts.units, outputs: facts.outputs, ...(facts.cancelled === true ? { cancelled: true } : {}) },
      maxTries: FIGURE_MAX_TRIES,
    },
    dueAt: now,
    createdAt: now,
  };
}

export type FigureSettlement =
  /** The correction was written now, or had been already. */
  | "settled"
  /** The result gives no count the estimate's rates can use, and reading it again cannot help: the estimate stays. */
  | "estimate_kept"
  /** The estimate is not in the ledger yet, so its rate is not known: save the figure and decide later. */
  | "waiting"
  /** The estimate's rate needs the outputs, and the body could not be read: read the result again. */
  | "needs_body";

/** The estimate stays: logged, from this one place, so the monitor sees each job whose figure never came. */
function keepEstimate(ref: JobRef, facts: JobResultFacts): "estimate_kept" {
  log("warn", "job_units_missing", { app: ref.appId, job: ref.job, status: facts.status });
  return "estimate_kept";
}

/**
 * Settles a job from a final figure. The one settle function: a client poll,
 * the sweep's live check and the sweep's figure rows all call it, in any
 * order, at once or again. It reads only what never changes (the estimate
 * and the figure itself), and its only deletes come after the correction
 * exists, or remove its own figure row, which can never become usable. So no
 * caller can act on a stale read. `estimate` is the job's estimate already
 * read (null: not in the ledger); when left out it is read here. Throws when
 * D1 cannot answer.
 */
export async function settleFigure(ledger: D1Database, ref: JobRef, facts: JobResultFacts, now: number, estimate?: ChargeRow | null): Promise<FigureSettlement> {
  const known = estimate === undefined ? await jobEstimateCharge(ledger, ref.job) : estimate;
  // A whole result with no count at all settles nothing, whatever the rate: no need to wait for it.
  const countless = !counted(facts) && facts.unread !== true;
  if (known === null && !countless) {
    // No estimate, and the job is past the late-booking window: its estimate,
    // dated the day the job started, would never be taken now (retention may
    // have deleted it). Saving the figure would only retry for days.
    const started = timeOfOrderedId(ref.job);
    if (started !== null && bookingTooLate(utcDay(started), now)) {
      log("warn", "ledger_booking_too_late", { app: ref.appId, ownerType: "job", owner: ref.job, kind: "figure", usageDay: utcDay(started) });
      return "estimate_kept";
    }
    return "waiting";
  }
  const decision: FigureDecision = known === null ? { kind: "never" } : decideFigure(known, facts);
  // Only a result with a count has a figure row of its own.
  const dropFigure = async () => {
    if (counted(facts)) await ledger.prepare("DELETE FROM open_work WHERE id = ?").bind(figureWorkId(ref.job, facts)).run();
  };
  if (decision.kind === "settle" && known !== null) {
    const settled = await settleJobFrom(ledger, known, decision.final, now);
    if (settled.status !== "no_rate") return "settled";
    log("error", "job_settle_no_rate", { app: ref.appId, job: ref.job, bucket: settled.bucket });
    await dropFigure();
    return "estimate_kept";
  }
  // A job settled earlier (a result read again after its units header expired) is quietly done.
  if (await jobSettled(ledger, ref.job)) return "settled";
  if (decision.kind === "needs_outputs" && facts.unread === true) return "needs_body";
  // Never read as 0: the estimate stays, already labelled an estimate.
  await dropFigure();
  return keepEstimate(ref, facts);
}

/**
 * How long one D1 step of applying a final figure may take: the settlement
 * read and write, then the figure-row write. Short, so a slow D1 still leaves
 * time, inside a poll's `waitUntil` window, to keep the figure in the
 * failed-write store.
 */
export const FIGURE_D1_DEADLINE_MS = 3_000;

/**
 * Keeps a figure that could not settle yet, for the sweep: as its own row in
 * D1; while D1 cannot take it, in the failed-write store; when neither works,
 * logged in full, to be settled by hand. True when it was kept somewhere the
 * sweep will find it.
 */
export async function keepFigure(env: Env, ledger: D1Database, ref: JobRef, facts: JobResultFacts, now: number): Promise<boolean> {
  const row = figureWork(ref, facts, now);
  try {
    await withDeadline(writeOpenWork(ledger, [row]), FIGURE_D1_DEADLINE_MS, "saving the figure");
    return true;
  } catch (error) {
    log("warn", "job_figure_save_failed", { app: ref.appId, job: ref.job, error: errorFacts(error) });
  }
  try {
    await chargeStore(env, ref.appId).keepWork([row]);
    return true;
  } catch (error) {
    log("warn", "job_figure_store_failed", { app: ref.appId, job: ref.job, error: errorFacts(error) });
  }
  log("error", "job_result_unrecorded", { app: ref.appId, job: ref.job, result: facts as unknown as Record<string, unknown> });
  return false;
}

/** What applying a final result came to. */
export type FinalResultOutcome =
  /** Settled, or every usable count kept as a figure the sweep settles: the job needs no more checking. */
  | "done"
  /** The result gives no count the estimate's rate can use, and reading it again cannot help: the estimate stays. */
  | "estimate_kept"
  /** The result must be read again: its body was not read, and its outputs may be what the rate needs. */
  | "retry"
  /** A usable figure could be kept nowhere (logged in full). */
  | "not_kept";

/**
 * What a final result means, as a client poll and the sweep's live check both
 * apply it. The one place that decides between settling, keeping the
 * estimate, and reading the result again, always with the estimate's rate:
 *
 * - the count the rate bills is there: settle, whatever happened to the body
 *   (a units header is enough for a rate per billed unit, and for a failure
 *   that billed 0);
 * - a success whose rate bills outputs, and whose body was not read (cut off,
 *   empty, not whole JSON): read the result again;
 * - otherwise the estimate stays, and the job's check ends: a rate per billed
 *   unit with no units header gets nothing from a whole body either.
 *
 * While the estimate is not in the ledger, its rate is not known: every
 * usable count is kept as a figure row (a units header alone is usable), and
 * the check stays open while the body may still be needed, so the sweep
 * decides once the estimate lands. Never throws.
 */
export async function applyFinalResult(
  env: Env,
  ledger: D1Database,
  ref: JobRef,
  facts: JobResultFacts,
  now: number,
  estimate?: ChargeRow | null,
): Promise<FinalResultOutcome> {
  let settled: FigureSettlement | null = null;
  try {
    settled = await withDeadline(settleFigure(ledger, ref, facts, now, estimate), FIGURE_D1_DEADLINE_MS, "settling the figure");
  } catch (error) {
    log("warn", "job_settle_failed", { app: ref.appId, job: ref.job, error: errorFacts(error) });
  }
  if (settled === "settled") return "done";
  if (settled === "estimate_kept") return "estimate_kept";
  if (settled === "needs_body") return "retry";
  // The rate is not known yet: keep what was read, and keep checking while the body may matter.
  if (facts.unread === true && succeeded(facts)) {
    if (counted(facts)) await keepFigure(env, ledger, ref, facts, now);
    return "retry";
  }
  if (!counted(facts)) return keepEstimate(ref, facts);
  return (await keepFigure(env, ledger, ref, facts, now)) ? "done" : "not_kept";
}

const retry = (reason: string): HandlerResult => ({ done: false, reason });

/** Whether an open-work row is a saved figure, not a live check. */
export function isFigureWork(id: string): boolean {
  return id.startsWith("job_figure:");
}

/**
 * The sweep's job work. Every provider's jobs go through this one handler.
 *
 * - **A figure row** is settled from the row alone: no signing key and no
 *   connection, since the rates are on the estimate. It waits while the
 *   estimate is not in the ledger.
 * - **A check row** holds only the signed id and the pace. The job is checked
 *   live: status first, then, once done, the result. A final result is applied
 *   as a client poll applies it. A final result with no count, an id that
 *   does not read, or a connection gone or pointed elsewhere ends the check:
 *   the estimate stays, logged. Without a signing key the check waits; a
 *   paused connection's key is never opened. `signal` only stops the provider
 *   calls: every write here is safe whenever it lands. Once a final figure is
 *   read, applying it is handed to `keepAlive`, so the item's time limit
 *   cannot cut it off.
 */
export const checkJob: OpenWorkHandler = async (env, item, { ledger, now, signal, keepAlive }) => {
  const ref: JobRef = { job: item.ownerId, accountId: item.accountId, appId: item.appId };
  const detail = item.detail ?? {};
  if (isFigureWork(item.id)) {
    const facts = factsOf(detail.result);
    if (facts === null) {
      log("error", "job_figure_unreadable", { app: item.appId, work: item.id });
      return { done: true };
    }
    const settling = settleFigure(ledger, ref, facts, now);
    keepAlive?.(settling.catch(() => undefined));
    return (await settling) === "waiting" ? retry("estimate not in the ledger yet") : { done: true };
  }

  if (!jobSigningReady(env.JWT_SECRET)) return retry("JWT_SECRET cannot verify job ids");
  const jobId = typeof detail.jobId === "string" ? detail.jobId : null;
  const claims = jobId === null ? null : await readJobId(env.JWT_SECRET, jobId);
  if (claims === null || claims.job !== item.ownerId) {
    log("error", "job_check_unreadable", { app: item.appId, work: item.id });
    return { done: true };
  }
  const context = await jobContext(env, claims, { fresh: true });
  if (context === null) {
    // Gone, made again, or pointed at another backend or key: the estimate stays.
    log("warn", "job_check_connection_changed", { app: claims.appId, job: claims.job, providerSlug: claims.slug });
    return { done: true };
  }
  if (context.connection.status === "disabled") return retry("the job's connection is disabled");
  // Split keys: the copies made at submit open the key; without them the job cannot be checked.
  const copies = keyCopiesOf(detail);
  if (copies === "missing") {
    log("warn", "job_check_key_unavailable", { app: claims.appId, job: claims.job, providerSlug: claims.slug });
    return { done: true };
  }
  const keys = copies === null ? {} : { copies };
  const status = await fetchJob(env, context, "status", claims, null, signal, "", keys);
  // A status that redirects to this job's own result means the job is done; any
  // other redirect is refused (logged), and the job is checked again later.
  let moved: JobEndpoint | null;
  try {
    moved = providerRedirect(status.response, status.url, jobRedirectTargets(context, claims), "job_poll_redirect_refused", {
      app: claims.appId,
      providerSlug: claims.slug,
    });
  } catch {
    return retry(`status redirect refused (${status.response.status})`);
  }
  if (moved === "status") return retry(`job not done (${status.response.status})`);
  if (moved === null) {
    const statusRead = await boundedJson(status.response, { deadlineMs: JOB_BODY_READ_DEADLINE_MS, ...(signal ? { signal } : {}) });
    const statusBody = statusRead.kind === "parsed" ? statusRead.value : null;
    if (!status.response.ok || !jobDone(context.spec, statusBody)) return retry(`job not done (${status.response.status})`);
  }
  const result = await fetchJob(env, context, "result", claims, null, signal, "", keys);
  const headerFacts = readResultFacts(context.spec, result.response, null);
  if (headerFacts === null) {
    void result.response.body?.cancel().catch(() => undefined);
    return retry(`result not final (${result.response.status})`);
  }
  // From here the provider's final answer is in hand: finish deciding even if the item's time runs out.
  // A final decision also ends this check itself, so it holds even when the sweep has moved on.
  const applying = (async () => {
    // The estimate is read once: it decides whether the body is read at all, then settles.
    // Unknown (undefined) when D1 cannot answer in time: then the body is read, and settling reads it again.
    let estimate: ChargeRow | null | undefined;
    try {
      estimate = await withDeadline(jobEstimateCharge(ledger, ref.job), FIGURE_D1_DEADLINE_MS, "reading the estimate");
    } catch {
      estimate = undefined;
    }
    // The body is read only when the decision may need it, and never for longer than its deadline.
    const bodyNeeded = countsOutputs(context.spec) && (estimate == null || decideFigure(estimate, headerFacts).kind === "needs_outputs");
    let read: BodyRead | null = null;
    if (bodyNeeded) read = await boundedJson(result.response, { deadlineMs: JOB_BODY_READ_DEADLINE_MS });
    else void result.response.body?.cancel().catch(() => undefined);
    const facts = read === null ? headerFacts : readResultFacts(context.spec, result.response, read)!;
    const outcome = await applyFinalResult(env, ledger, ref, facts, now, estimate);
    if (outcome === "done" || outcome === "estimate_kept") {
      await ledger.prepare("DELETE FROM open_work WHERE id = ?").bind(item.id).run().catch(() => undefined);
    }
    return outcome;
  })();
  keepAlive?.(applying);
  const applied = await applying;
  // A body not read, when the rate needs its outputs or is not known yet: the result may read whole on the next check.
  if (applied === "retry") return retry("result body could not be read");
  return applied === "not_kept" ? retry("figure not kept") : { done: true };
};

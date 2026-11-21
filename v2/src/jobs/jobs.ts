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
 * 5. **The sweep** checks jobs no client polled, earliest due first.
 *
 * A submission whose answer was lost is never sent again: it keeps its
 * estimate, marked `estimated`, and is logged (T15).
 */
import { errorFacts } from "../core/error-facts.ts";
import { GatewayError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { settleJob, type FinalFigure } from "../ledger/corrections.ts";
import type { ChargeStatus } from "../ledger/labels.ts";
import type { HandlerResult, OpenWorkHandler } from "../ledger/sweep.ts";
import { chargeFromRow, type ChargeRow, type LedgerEntry, type OpenWorkRow } from "../ledger/write.ts";
import { listedUnitRate } from "../pricing/billability.ts";
import { scaledCount, UNIT_RATES } from "../pricing/units.ts";
import { connectionCredentials, connectionDescription, loadConnection, type ConnectionRecord } from "../providers/connections.ts";
import type { JobRequest, JobSpec, OperationDescription, ProviderDescription, Unit } from "../providers/operation.ts";
import { upstreamRequest } from "../providers/route.ts";
import { callCharge, type CallAttempt } from "../proxy/call-charge.ts";
import { attemptUsage, headerNumber } from "../proxy/meter.ts";
import { readJobId, type JobClaims } from "./job-id.ts";

/** When the sweep first checks a job. fal keeps results for an hour, large ones for 6 minutes (T15). */
export const JOB_FIRST_CHECK_MS = 2 * 60 * 1000;

/** How long a poll of the provider may take. */
export const JOB_POLL_TIMEOUT_MS = 30_000;

/** A provider's request id the gateway will put in a URL. */
const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/u;

/** The open-work row that checks one job. */
export function jobCheckId(job: string): string {
  return `job:${job}`;
}

/** The provider's request id in a submit answer, or null when it has none the gateway can use. */
export function providerRequestId(spec: JobSpec, body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>)[spec.requestIdField];
  return typeof value === "string" && REQUEST_ID.test(value) ? value : null;
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
  const call = callCharge(
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
      detail: { providerType: attempt.providerType, jobId: input.signedId },
      dueAt: input.now + JOB_FIRST_CHECK_MS,
      createdAt: input.now,
    });
  }
  return { charge, openWork };
}

/** The gateway's links for a job. */
export interface GatewayLinks {
  readonly status: string;
  readonly result: string;
}

/** The gateway's polling links for a job id, under the app's own path. */
export function gatewayLinks(origin: string, appId: string, jobId: string): GatewayLinks {
  const base = `${origin}/v2/apps/${encodeURIComponent(appId)}/jobs/${jobId}`;
  return { status: `${base}/status`, result: base };
}

/**
 * A provider's answer with its links pointing at the gateway, and its request
 * id replaced by the gateway's job id. A link the gateway does not serve yet
 * (cancel) is removed. Only fields already in the answer are touched.
 */
export function withGatewayLinks(body: Record<string, unknown>, spec: JobSpec, links: GatewayLinks, jobId: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  const named = spec.links ?? {};
  if (named.status !== undefined && Object.hasOwn(out, named.status)) out[named.status] = links.status;
  if (named.result !== undefined && Object.hasOwn(out, named.result)) out[named.result] = links.result;
  if (named.cancel !== undefined) delete out[named.cancel];
  if (Object.hasOwn(out, spec.requestIdField)) out[spec.requestIdField] = jobId;
  return out;
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

/** The connection and operation behind a job, or null when they are gone or changed. */
export async function jobContext(env: Env, claims: JobClaims): Promise<JobContext | null> {
  const connection = await loadConnection(env, claims.accountId, claims.slug);
  // A connection made again under the same slug is another key: its jobs are not this one's.
  if (connection === null || connection.id !== claims.connectionId) return null;
  const description = connectionDescription(connection);
  const operation = description?.operations.find((one) => one.name === claims.operation);
  if (description === null || operation === undefined || operation.lifecycle !== "job" || operation.job === undefined) return null;
  return { connection, description, operation, spec: operation.job };
}

/** A follow-up request to the provider, with the connection's key, never following a redirect. */
export async function fetchJob(
  env: Env,
  context: JobContext,
  which: "status" | "result",
  claims: JobClaims,
): Promise<{ readonly response: Response; readonly keyHeader: string }> {
  const request = context.spec[which];
  const credentials = await connectionCredentials(env, context.connection);
  const target = upstreamRequest(context.connection, context.description, {
    hostKey: request.host ?? "main",
    path: jobRequestPath(request, claims),
    query: "",
    credentials,
    client: new Headers(),
    appId: claims.appId,
    userId: claims.userId,
  });
  try {
    const response = await fetch(target.url, {
      method: request.method,
      headers: target.headers,
      redirect: "manual",
      signal: AbortSignal.timeout(JOB_POLL_TIMEOUT_MS),
    });
    return { response, keyHeader: target.keyHeader };
  } catch (error) {
    log("warn", "job_poll_failed", { app: claims.appId, providerSlug: claims.slug, which, error: errorFacts(error) });
    throw new GatewayError(502, "provider_error", "Provider request failed");
  }
}

/** The status answer says the job is done, so its result can be read. */
export function jobDone(spec: JobSpec, body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const value = (body as Record<string, unknown>)[spec.doneWhen.field];
  return typeof value === "string" && spec.doneWhen.values.includes(value);
}

/** What a result call answered, as settlement reads it. */
export interface JobResult {
  readonly status: number;
  readonly headers: Headers;
  /** The parsed JSON body, or null. */
  readonly body: unknown;
}

/** How many outputs a result names, or null when it names none the gateway can count. */
function outputCount(spec: JobSpec, body: unknown): number | null {
  if (spec.outputsField === undefined || typeof body !== "object" || body === null) return null;
  const outputs = (body as Record<string, unknown>)[spec.outputsField];
  if (outputs === undefined || outputs === null) return null;
  return Array.isArray(outputs) ? outputs.length : 1;
}

/**
 * The final figure of a job from its result, priced with the rates stored on
 * the estimate, or null when the result gives none. Only a final status
 * counts. Every rate the estimate stored must get a count:
 *
 * - billed units from the units header (fal's megapixels), never a missing
 *   header read as 0;
 * - the outputs in the result, for a rate per output: counted on a success,
 *   none on a failure.
 */
export function jobFinalFigure(estimate: ChargeRow, spec: JobSpec, result: JobResult): FinalFigure | null {
  if (!spec.finalStatuses.includes(result.status)) return null;
  const succeeded = result.status >= 200 && result.status < 300;
  const counts: Partial<Record<Unit, number>> = {};
  const header = spec.unitsHeader === undefined ? null : headerNumber(result.headers.get(spec.unitsHeader));
  if (header !== null) {
    const scaled = scaledCount("model_units", header);
    if (Number.isSafeInteger(scaled)) counts.model_units = scaled;
  }
  const outputs = succeeded ? outputCount(spec, result.body) : 0;
  if (outputs !== null) counts.images = outputs;
  const rates = estimate.rates;
  if (rates === null || Object.keys(rates).length === 0) return null;
  const buckets: Record<string, number> = {};
  for (const field of Object.keys(rates)) {
    const unitRate = UNIT_RATES.find((one) => one.field === field);
    const unit = unitRate?.units.find((one) => counts[one] !== undefined);
    if (unit === undefined) return null;
    buckets[field] = counts[unit]!;
  }
  const units = estimate.unit === null ? undefined : counts[estimate.unit as Unit];
  return { kind: "units", buckets, ...(units !== undefined ? { units } : {}) };
}

/** A job's estimate charge, or null while it is not in the ledger (the settlement barrier). */
async function jobEstimateCharge(db: D1Database, job: string): Promise<ChargeRow | null> {
  const row = await db
    .prepare("SELECT * FROM charge WHERE owner_type = 'job' AND owner_id = ? AND kind = 'estimate' ORDER BY seq LIMIT 1")
    .bind(job)
    .first<Record<string, unknown>>();
  return row === null ? null : chargeFromRow(row);
}

export type JobSettlement =
  /** The correction was written now, or had been already. */
  | "settled"
  /** The result is final but gives no count: the estimate stays, as it is labelled. */
  | "estimate_kept"
  /** The result is not final yet. */
  | "not_final"
  /** The estimate is not in the ledger yet: try again later. */
  | "waiting";

/**
 * Settles a job from a result call. Safe to call from a client poll and the
 * sweep at once: one correction results. Removes the job's check once done.
 * Never throws.
 */
export async function settleJobFromResult(env: Env, claims: JobClaims, spec: JobSpec, result: JobResult, now: number): Promise<JobSettlement> {
  const facts = { app: claims.appId, job: claims.job, providerSlug: claims.slug, model: claims.model };
  try {
    if (!spec.finalStatuses.includes(result.status)) return "not_final";
    const estimate = await jobEstimateCharge(env.DB, claims.job);
    if (estimate === null) return "waiting";
    const final = jobFinalFigure(estimate, spec, result);
    if (final === null) {
      // Never read as 0: the estimate stays, already labelled an estimate.
      log("warn", "job_units_missing", { ...facts, status: result.status });
      await env.DB.prepare("DELETE FROM open_work WHERE id = ?").bind(jobCheckId(claims.job)).run();
      return "estimate_kept";
    }
    const settled = await settleJob(env.DB, { jobId: claims.job, final, now, doneWork: jobCheckId(claims.job) });
    switch (settled.status) {
      case "settled":
        return "settled";
      case "already":
        await env.DB.prepare("DELETE FROM open_work WHERE id = ?").bind(jobCheckId(claims.job)).run();
        return "settled";
      case "charge_missing":
        return "waiting";
      case "no_rate":
        log("error", "job_settle_no_rate", { ...facts, bucket: settled.bucket });
        await env.DB.prepare("DELETE FROM open_work WHERE id = ?").bind(jobCheckId(claims.job)).run();
        return "estimate_kept";
    }
  } catch (error) {
    log("warn", "job_settle_failed", { ...facts, error: errorFacts(error) });
    return "waiting";
  }
}

/** The JSON body of an answer, or null. */
export async function jsonOf(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

const retry = (reason: string): HandlerResult => ({ done: false, reason });

/**
 * The sweep's check of one job: the status first, then, once done, the
 * result, settled as a client poll would. Every provider's jobs go through
 * this one handler.
 */
export const checkJob: OpenWorkHandler = async (env, item, { now }) => {
  const id = item.detail?.jobId;
  const claims = typeof id === "string" ? await readJobId(env.JWT_SECRET, id) : null;
  if (claims === null) {
    log("error", "job_check_unreadable", { app: item.appId, work: item.id });
    return { done: true };
  }
  const context = await jobContext(env, claims);
  if (context === null) return retry("the job's connection is gone");
  const status = await fetchJob(env, context, "status", claims);
  const statusBody = await jsonOf(status.response);
  if (!status.response.ok || !jobDone(context.spec, statusBody)) return retry(`job not done (${status.response.status})`);
  const result = await fetchJob(env, context, "result", claims);
  const body = await jsonOf(result.response);
  const settled = await settleJobFromResult(env, claims, context.spec, { status: result.response.status, headers: result.response.headers, body }, now);
  if (settled === "waiting") return retry("estimate not in the ledger yet");
  if (settled === "not_final") return retry(`result not final (${result.response.status})`);
  return { done: true };
};

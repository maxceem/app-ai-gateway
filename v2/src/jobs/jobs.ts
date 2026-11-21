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
import { connectionCredentials, connectionDescription, loadConnection, loadConnectionFresh, type ConnectionRecord } from "../providers/connections.ts";
import type { JobRequest, JobSpec, OperationDescription, ProviderDescription, Unit } from "../providers/operation.ts";
import { upstreamRequest } from "../providers/route.ts";
import { callCharge, type CallAttempt } from "../proxy/call-charge.ts";
import { attemptUsage, headerNumber } from "../proxy/meter.ts";
import { jobSigningReady, readJobId, routeDigest, type JobClaims } from "./job-id.ts";

/** When the sweep first checks a job. fal keeps results for an hour, large ones for 6 minutes (T15). */
export const JOB_FIRST_CHECK_MS = 2 * 60 * 1000;

/** How often the sweep checks a job again, when its operation does not say. */
export const JOB_CHECK_EVERY_MS = 60 * 1000;
/** How many checks before the sweep gives up on a job, when its operation does not say. */
export const JOB_MAX_CHECKS = 60;

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
      detail: { providerType: attempt.providerType, jobId: input.signedId, ...checkPace(operation.job) },
      dueAt: input.now + JOB_FIRST_CHECK_MS,
      createdAt: input.now,
    });
  }
  return { charge, openWork };
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

/**
 * The connection and operation behind a job, or null when they are gone or
 * changed. With `fresh`, the connection is read from D1 now, not from this
 * isolate's cache (the sweep, which must see a status just changed); that read
 * throws when D1 cannot answer.
 */
export async function jobContext(env: Env, claims: JobClaims, options: { readonly fresh?: boolean } = {}): Promise<JobContext | null> {
  const connection = options.fresh === true ? await loadConnectionFresh(env, claims.accountId, claims.slug) : await loadConnection(env, claims.accountId, claims.slug);
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
 * A follow-up request to the provider, with the connection's key, never
 * following a redirect. `userId` is the polling caller's own end user, or
 * null from the sweep: a job id carries only its digest.
 */
export async function fetchJob(
  env: Env,
  context: JobContext,
  which: "status" | "result",
  claims: JobClaims,
  userId: string | null,
  signal?: AbortSignal,
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
    userId,
  });
  try {
    const response = await fetch(target.url, {
      method: request.method,
      headers: target.headers,
      redirect: "manual",
      signal: signal === undefined ? AbortSignal.timeout(JOB_POLL_TIMEOUT_MS) : AbortSignal.any([signal, AbortSignal.timeout(JOB_POLL_TIMEOUT_MS)]),
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
 * What a final result says, kept small so it can be saved when the estimate
 * is not in the ledger yet, and settled later from the same facts.
 */
export interface JobResultFacts {
  readonly status: number;
  /** The billed units the provider reported, or null when it reported none. */
  readonly units: number | null;
  /** The outputs in the result, or null when it names none the gateway can count. */
  readonly outputs: number | null;
}

/** The facts of a result call, or null when its status is not final. */
export function jobResultFacts(spec: JobSpec, result: JobResult): JobResultFacts | null {
  if (!spec.finalStatuses.includes(result.status)) return null;
  return {
    status: result.status,
    units: spec.unitsHeader === undefined ? null : headerNumber(result.headers.get(spec.unitsHeader)),
    outputs: outputCount(spec, result.body),
  };
}

/** Saved facts read back, or null when they are not facts. */
function factsOf(value: unknown): JobResultFacts | null {
  if (typeof value !== "object" || value === null) return null;
  const facts = value as Record<string, unknown>;
  const count = (one: unknown) => one === null || (typeof one === "number" && Number.isFinite(one) && one >= 0);
  if (typeof facts.status !== "number" || !count(facts.units) || !count(facts.outputs)) return null;
  return { status: facts.status, units: facts.units as number | null, outputs: facts.outputs as number | null };
}

/**
 * The final figure of a job from its result's facts, priced with the rates
 * stored on the estimate, or null when the result gives none and the estimate
 * stays. Every rate the estimate stored must get a count:
 *
 * - billed units from the units header (fal's megapixels), never a missing
 *   header read as 0;
 * - the outputs in the result, for a rate per output, on a success only;
 * - a failure is free only when the provider reports 0 billed units. A failure
 *   with no units report keeps the estimate (T15: fal's units expire).
 */
export function jobFinalFigure(estimate: ChargeRow, facts: JobResultFacts): FinalFigure | null {
  const succeeded = facts.status >= 200 && facts.status < 300;
  const counts: Partial<Record<Unit, number>> = {};
  if (facts.units !== null) {
    const scaled = scaledCount("model_units", facts.units);
    if (Number.isSafeInteger(scaled)) counts.model_units = scaled;
  }
  if (succeeded) {
    if (facts.outputs !== null) counts.images = facts.outputs;
  } else if (facts.units === 0) {
    // The provider says the failure billed nothing: every count is 0.
    counts.images = 0;
  }
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
  | "waiting"
  /** The sweep's time for this item ran out before any write: try again later. */
  | "aborted";

/**
 * A job as its check row knows it. Settling a saved figure needs nothing
 * more: no signing key and no connection, since the rates are on the estimate.
 */
export interface JobRef {
  readonly job: string;
  readonly accountId: string;
  readonly appId: string;
  /** The signed job id, kept on the check row for a later live check. */
  readonly jobId: string;
  readonly retryEveryMs: number;
  readonly maxTries: number;
}

/** A job's reference from its signed claims. */
export function jobRefOf(claims: JobClaims, jobId: string, spec: JobSpec): JobRef {
  return { job: claims.job, accountId: claims.accountId, appId: claims.appId, jobId, ...checkPace(spec) };
}

/** The final figure saved on a job's check row, or null when it holds none. Throws when D1 cannot answer. */
async function savedJobFacts(db: D1Database, job: string): Promise<JobResultFacts | null> {
  const row = await db.prepare("SELECT detail_json FROM open_work WHERE id = ?").bind(jobCheckId(job)).first<{ detail_json: string | null }>();
  if (row === null || row.detail_json === null) return null;
  try {
    return factsOf((JSON.parse(row.detail_json) as Record<string, unknown>).result);
  } catch {
    return null;
  }
}

/**
 * Saves a job's final figure where its estimate is, so it is settled later
 * from the same facts with the same correction id. Append-only: the first
 * figure saved wins, and nothing here removes one. It goes on the job's check
 * row in D1; while D1 cannot take it, on the estimate's entry in the
 * failed-write store, which writes both together. Only when neither works is
 * it logged in full, to be settled by hand.
 */
async function saveJobResult(env: Env, ref: JobRef, facts: JobResultFacts, now: number): Promise<void> {
  const detail = JSON.stringify({ jobId: ref.jobId, result: facts, retryEveryMs: ref.retryEveryMs, maxTries: ref.maxTries });
  try {
    await env.DB.prepare(
      `INSERT INTO open_work (id, kind, account_id, app_id, owner_type, owner_id, charge_id, detail_json, due_at, tries, created_at)
       VALUES (?, 'job_check', ?, ?, 'job', ?, NULL, ?, ?, 0, ?)
       ON CONFLICT(id) DO UPDATE SET detail_json = json_set(COALESCE(open_work.detail_json, '{}'), '$.result', json(?)),
         due_at = MIN(open_work.due_at, excluded.due_at), gave_up_at = NULL
       WHERE json_extract(open_work.detail_json, '$.result') IS NULL`,
    )
      .bind(jobCheckId(ref.job), ref.accountId, ref.appId, ref.job, detail, now, now, JSON.stringify(facts))
      .run();
    return;
  } catch (error) {
    log("warn", "job_result_save_failed", { app: ref.appId, job: ref.job, error: errorFacts(error) });
  }
  try {
    if (await env.CHARGE_STORE.getByName(ref.appId).keepJobResult(ref.job, { ...facts })) return;
  } catch (error) {
    log("warn", "job_result_store_failed", { app: ref.appId, job: ref.job, error: errorFacts(error) });
  }
  log("error", "job_result_unrecorded", { app: ref.appId, job: ref.job, jobId: ref.jobId, result: facts as unknown as Record<string, unknown> });
}

/**
 * Settles a job. The first final figure wins: one already saved on the job's
 * check is used over the one given, so a later answer with fewer facts (an
 * expired units header) never replaces it. Safe to call from a client poll
 * and the sweep at once: one correction results, and it removes the check in
 * the same write. While the estimate is not in the ledger, the figure is
 * saved and the answer is `waiting`. With `signal`, nothing is written once
 * the sweep's time for the item ran out. Never throws.
 */
export async function settleJobFacts(env: Env, ref: JobRef, facts: JobResultFacts, now: number, signal?: AbortSignal): Promise<JobSettlement> {
  const tags = { app: ref.appId, job: ref.job };
  const checkDone = () => env.DB.prepare("DELETE FROM open_work WHERE id = ?").bind(jobCheckId(ref.job)).run();
  let saved: JobResultFacts | null = null;
  try {
    saved = await savedJobFacts(env.DB, ref.job);
    const first = saved ?? facts;
    const estimate = await jobEstimateCharge(env.DB, ref.job);
    if (signal?.aborted) return "aborted";
    if (estimate === null) {
      if (saved === null) await saveJobResult(env, ref, facts, now);
      return "waiting";
    }
    const final = jobFinalFigure(estimate, first);
    if (final === null) {
      // Never read as 0: the estimate stays, already labelled an estimate.
      log("warn", "job_units_missing", { ...tags, status: first.status });
      await checkDone();
      return "estimate_kept";
    }
    const settled = await settleJob(env.DB, { jobId: ref.job, final, now, doneWork: jobCheckId(ref.job) });
    switch (settled.status) {
      case "settled":
        return "settled";
      case "already":
        await checkDone();
        return "settled";
      case "charge_missing":
        if (saved === null) await saveJobResult(env, ref, facts, now);
        return "waiting";
      case "no_rate":
        log("error", "job_settle_no_rate", { ...tags, bucket: settled.bucket });
        await checkDone();
        return "estimate_kept";
    }
  } catch (error) {
    log("warn", "job_settle_failed", { ...tags, error: errorFacts(error) });
    if (saved === null && !signal?.aborted) await saveJobResult(env, ref, facts, now);
    return signal?.aborted ? "aborted" : "waiting";
  }
}

/** Settles a job from a final result's facts, as `settleJobFacts`. */
export function settleJobFromFacts(
  env: Env,
  claims: JobClaims,
  jobId: string,
  spec: JobSpec,
  facts: JobResultFacts,
  now: number,
  signal?: AbortSignal,
): Promise<JobSettlement> {
  return settleJobFacts(env, jobRefOf(claims, jobId, spec), facts, now, signal);
}

/** Settles a job from a result call: `not_final` when its status is not final, else as `settleJobFacts`. */
export async function settleJobFromResult(
  env: Env,
  claims: JobClaims,
  jobId: string,
  spec: JobSpec,
  result: JobResult,
  now: number,
  signal?: AbortSignal,
): Promise<JobSettlement> {
  const facts = jobResultFacts(spec, result);
  if (facts === null) return "not_final";
  return settleJobFromFacts(env, claims, jobId, spec, facts, now, signal);
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

/** What a settlement means for the sweep's row. */
function sweepResult(settled: JobSettlement, status?: number): HandlerResult {
  switch (settled) {
    case "waiting":
      return retry("estimate not in the ledger yet");
    case "aborted":
      return retry("timed out");
    case "not_final":
      return retry(`result not final (${status ?? "?"})`);
    default:
      return { done: true };
  }
}

/**
 * The sweep's check of one job. Every provider's jobs go through this one
 * handler.
 *
 * - A saved final figure is settled as it is, from the row alone: no signing
 *   key and no connection are needed, so a configuration problem never loses
 *   it.
 * - Else the job is checked live: status first, then, once done, the result,
 *   settled as a client poll would. That needs the signing key (without one,
 *   the check waits) and the connection read fresh (a paused one's key is
 *   never opened; one gone or pointed elsewhere leaves the estimate, logged).
 * - The item's time limit is checked after each read and before any write.
 */
export const checkJob: OpenWorkHandler = async (env, item, { now, signal }) => {
  const detail = item.detail ?? {};
  const jobId = typeof detail.jobId === "string" ? detail.jobId : null;
  const ref: JobRef = {
    job: item.ownerId,
    accountId: item.accountId,
    appId: item.appId,
    jobId: jobId ?? "",
    retryEveryMs: typeof detail.retryEveryMs === "number" ? detail.retryEveryMs : JOB_CHECK_EVERY_MS,
    maxTries: typeof detail.maxTries === "number" ? detail.maxTries : JOB_MAX_CHECKS,
  };
  const saved = factsOf(detail.result);
  if (saved !== null) return sweepResult(await settleJobFacts(env, ref, saved, now, signal));

  if (!jobSigningReady(env.JWT_SECRET)) return retry("JWT_SECRET cannot verify job ids");
  const claims = jobId === null ? null : await readJobId(env.JWT_SECRET, jobId);
  if (claims === null || claims.job !== item.ownerId) {
    log("error", "job_check_unreadable", { app: item.appId, work: item.id });
    return { done: true };
  }
  const context = await jobContext(env, claims, { fresh: true });
  if (signal?.aborted) return retry("timed out");
  if (context === null) {
    // Gone, made again, or pointed at another backend: the estimate stays.
    log("warn", "job_check_connection_changed", { app: claims.appId, job: claims.job, providerSlug: claims.slug });
    return { done: true };
  }
  if (context.connection.status === "disabled") return retry("the job's connection is disabled");
  const status = await fetchJob(env, context, "status", claims, null, signal);
  const statusBody = await jsonOf(status.response);
  if (!status.response.ok || !jobDone(context.spec, statusBody)) return retry(`job not done (${status.response.status})`);
  if (signal?.aborted) return retry("timed out");
  const result = await fetchJob(env, context, "result", claims, null, signal);
  const body = await jsonOf(result.response);
  if (signal?.aborted) return retry("timed out");
  const settled = await settleJobFromResult(env, claims, jobId!, context.spec, { status: result.response.status, headers: result.response.headers, body }, now, signal);
  return sweepResult(settled, result.response.status);
};

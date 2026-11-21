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
import { withDeadline } from "../core/background.ts";
import { errorFacts } from "../core/error-facts.ts";
import { GatewayError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { settleJob, type FinalFigure } from "../ledger/corrections.ts";
import type { ChargeStatus } from "../ledger/labels.ts";
import type { HandlerResult, OpenWorkHandler } from "../ledger/sweep.ts";
import { chargeFromRow, writeOpenWork, type ChargeRow, type LedgerEntry, type OpenWorkRow } from "../ledger/write.ts";
import { listedUnitRate } from "../pricing/billability.ts";
import { scaledCount, UNIT_RATES } from "../pricing/units.ts";
import { connectionCredentials, connectionDescription, loadConnection, loadConnectionFresh, type ConnectionRecord } from "../providers/connections.ts";
import type { JobRequest, JobSpec, OperationDescription, ProviderDescription, Unit } from "../providers/operation.ts";
import { normalizePath } from "../providers/path.ts";
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
  for (const request of [spec.status, spec.result]) {
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
  // Once the sweep's time for the item is up, no more provider calls start.
  signal?.throwIfAborted();
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

/** What a final result says, kept small so a figure row can hold it. */
export interface JobResultFacts {
  readonly status: number;
  /** The billed units the provider reported, or null when it reported none. */
  readonly units: number | null;
  /** The outputs in the result, or null when it names none the gateway can count. */
  readonly outputs: number | null;
  /**
   * True when the body had to be read to count outputs, but could not be: cut
   * off, or not whole JSON. Then a missing output count says nothing, and a
   * figure that needs it is tried again instead of ending as "no count". Never
   * saved on a figure row.
   */
  readonly unread?: true;
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

/** The most of a result body read to count its outputs. A bigger body is not counted: the estimate stays. */
export const OUTPUTS_READ_LIMIT = 1024 * 1024;

/**
 * Whether the result's body is read to count its outputs: whenever the
 * provider's operation counts them. The gateway does not know at fetch time
 * which unit the estimate bills, and an estimate per output needs the count
 * even when a units header is there (that header gives billed units, which a
 * rate per image cannot use). The read is bounded and never holds the app's
 * answer; an estimate per billed unit is settled from the header either way.
 */
export function countNeedsBody(spec: JobSpec): boolean {
  return spec.outputsField !== undefined;
}

/** A body read for counting: parsed (null when empty), larger than the limit, cut off while reading, or not whole JSON. */
export type BodyRead =
  | { readonly kind: "parsed"; readonly value: unknown }
  | { readonly kind: "too_large" }
  | { readonly kind: "read_error" }
  | { readonly kind: "unparseable" };

/**
 * A body read as JSON, at most `limit` bytes. Reading stops (and the stream
 * is cancelled) at the limit, so counting never holds a large result in
 * memory. An empty body is parsed as null. One that fails while it is read is
 * a read error, and one that is not whole JSON (truncated JSON that closed
 * normally, for one) is unparseable: both are tried again by the sweep.
 */
export async function boundedJson(response: Response, limit: number = OUTPUTS_READ_LIMIT): Promise<BodyRead> {
  if (response.body === null) return { kind: "parsed", value: null };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => undefined);
        return { kind: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: "read_error" };
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  if (size === 0) return { kind: "parsed", value: null };
  try {
    return { kind: "parsed", value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return { kind: "unparseable" };
  }
}

/**
 * The facts of a final result, from its status, its headers and the body read
 * done to count outputs (null when the body is not needed). A body that could
 * not be read marks the facts `unread`; the units header is read either way,
 * so a header that settles the estimate's rate is never lost to a broken body.
 */
export function readResultFacts(spec: JobSpec, response: Pick<Response, "status" | "headers">, read: BodyRead | null): JobResultFacts | null {
  const body = read !== null && read.kind === "parsed" ? read.value : null;
  const facts = jobResultFacts(spec, { status: response.status, headers: response.headers, body });
  if (facts === null) return null;
  return read !== null && (read.kind === "read_error" || read.kind === "unparseable") ? { ...facts, unread: true } : facts;
}

/**
 * Whether a figure still needs the body: it could not be read, and the result
 * succeeded, so its outputs may be what the estimate's rate counts. A failure's
 * outputs are never counted, so its body is never needed.
 */
function bodyStillNeeded(facts: JobResultFacts): boolean {
  return facts.unread === true && facts.status >= 200 && facts.status < 300;
}

/** Whether a result gives any count at all. One with none is never saved: it can never settle. */
export function hasCount(facts: JobResultFacts): boolean {
  return facts.units !== null || facts.outputs !== null;
}

/** Saved facts read back, or null when they are not facts. */
function factsOf(value: unknown): JobResultFacts | null {
  if (typeof value !== "object" || value === null) return null;
  const facts = value as Record<string, unknown>;
  const count = (one: unknown) => one === null || (typeof one === "number" && Number.isFinite(one) && one >= 0);
  if (typeof facts.status !== "number" || !count(facts.units) || !count(facts.outputs)) return null;
  // A saved figure was read whole: `unread` is never kept.
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
  return `job_figure:${job}:${facts.status}:${figurePart(facts.units)}:${figurePart(facts.outputs)}`;
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
    detail: { result: { status: facts.status, units: facts.units, outputs: facts.outputs }, maxTries: FIGURE_MAX_TRIES },
    dueAt: now,
    createdAt: now,
  };
}

export type FigureSettlement =
  /** The correction was written now, or had been already. */
  | "settled"
  /** The figure gives no count the estimate's rates can use: the estimate stays, as it is labelled. */
  | "estimate_kept"
  /** The estimate is not in the ledger yet: save the figure and try later. */
  | "waiting"
  /** The estimate's rate needs the outputs, and the body could not be read: read the result again. */
  | "needs_body";

/**
 * Settles a job from a final figure. The one settle function: a client poll,
 * the sweep's live check and the sweep's figure rows all call it, in any
 * order, at once or again. It reads only what never changes (the estimate
 * and the figure itself), and its only deletes come after the correction
 * exists, or remove its own figure row, which can never become usable. So no
 * caller can act on a stale read. Throws when D1 cannot answer.
 */
export async function settleFigure(env: Env, ref: JobRef, facts: JobResultFacts, now: number): Promise<FigureSettlement> {
  const tags = { app: ref.appId, job: ref.job };
  const estimate = await jobEstimateCharge(env.DB, ref.job);
  if (estimate === null) return "waiting";
  const dropFigure = () => env.DB.prepare("DELETE FROM open_work WHERE id = ?").bind(figureWorkId(ref.job, facts)).run();
  const final = jobFinalFigure(estimate, facts);
  if (final === null && bodyStillNeeded(facts)) return "needs_body";
  if (final === null) {
    // Never read as 0: the estimate stays, already labelled an estimate.
    log("warn", "job_units_missing", { ...tags, status: facts.status });
    await dropFigure();
    return "estimate_kept";
  }
  const settled = await settleJob(env.DB, { jobId: ref.job, final, now });
  switch (settled.status) {
    case "settled":
    case "already":
      return "settled";
    case "charge_missing":
      return "waiting";
    case "no_rate":
      log("error", "job_settle_no_rate", { ...tags, bucket: settled.bucket });
      await dropFigure();
      return "estimate_kept";
  }
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
export async function keepFigure(env: Env, ref: JobRef, facts: JobResultFacts, now: number): Promise<boolean> {
  const row = figureWork(ref, facts, now);
  try {
    await withDeadline(writeOpenWork(env.DB, [row]), FIGURE_D1_DEADLINE_MS, "saving the figure");
    return true;
  } catch (error) {
    log("warn", "job_figure_save_failed", { app: ref.appId, job: ref.job, error: errorFacts(error) });
  }
  try {
    await env.CHARGE_STORE.getByName(ref.appId).keepWork([row]);
    return true;
  } catch (error) {
    log("warn", "job_figure_store_failed", { app: ref.appId, job: ref.job, error: errorFacts(error) });
  }
  log("error", "job_result_unrecorded", { app: ref.appId, job: ref.job, result: facts as unknown as Record<string, unknown> });
  return false;
}

/**
 * What a final result means, as a client poll and the sweep's live check both
 * apply it. The one place that decides between settling, keeping the
 * estimate, and reading the result again:
 *
 * - a figure that settles the estimate's rate settles, whatever happened to
 *   the body (a units header is enough for a rate per billed unit, and for a
 *   failure that billed 0);
 * - a figure that cannot settle yet is kept for the sweep, unless its body
 *   still has to be read: such a figure is never saved, and the result is
 *   read again (`retry`);
 * - a result with no count, read whole, ends as `no_count`: the estimate stays.
 *
 * Never throws. `done` means the figure is settled or kept: the job needs no
 * more checking.
 */
export async function applyFinalResult(env: Env, ref: JobRef, facts: JobResultFacts, now: number): Promise<"done" | "no_count" | "retry" | "not_kept"> {
  if (!hasCount(facts)) {
    if (bodyStillNeeded(facts)) return "retry";
    log("warn", "job_units_missing", { app: ref.appId, job: ref.job, status: facts.status });
    return "no_count";
  }
  try {
    const settled = await withDeadline(settleFigure(env, ref, facts, now), FIGURE_D1_DEADLINE_MS, "settling the figure");
    if (settled === "needs_body") return "retry";
    if (settled !== "waiting") return "done";
  } catch (error) {
    log("warn", "job_settle_failed", { app: ref.appId, job: ref.job, error: errorFacts(error) });
  }
  // A figure whose body is still needed is never saved: it could only end as "estimate kept".
  if (bodyStillNeeded(facts)) return "retry";
  return (await keepFigure(env, ref, facts, now)) ? "done" : "not_kept";
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
export const checkJob: OpenWorkHandler = async (env, item, { now, signal, keepAlive }) => {
  const ref: JobRef = { job: item.ownerId, accountId: item.accountId, appId: item.appId };
  const detail = item.detail ?? {};
  if (isFigureWork(item.id)) {
    const facts = factsOf(detail.result);
    if (facts === null) {
      log("error", "job_figure_unreadable", { app: item.appId, work: item.id });
      return { done: true };
    }
    const settling = settleFigure(env, ref, facts, now);
    keepAlive?.(settling.catch(() => undefined));
    return (await settling) === "waiting" ? retry("estimate not in the ledger yet") : { done: true };
  }

  // A check whose job was settled meanwhile (by a poll, or a figure row) asks the provider nothing.
  const still = await env.DB.prepare("SELECT 1 FROM open_work WHERE id = ?").bind(item.id).first();
  if (still === null) return { done: true };
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
  const status = await fetchJob(env, context, "status", claims, null, signal);
  const statusBody = await jsonOf(status.response);
  if (!status.response.ok || !jobDone(context.spec, statusBody)) return retry(`job not done (${status.response.status})`);
  const result = await fetchJob(env, context, "result", claims, null, signal);
  let read: BodyRead | null = null;
  if (countNeedsBody(context.spec)) read = await boundedJson(result.response);
  else void result.response.body?.cancel().catch(() => undefined);
  const facts = readResultFacts(context.spec, result.response, read);
  if (facts === null) return retry(`result not final (${result.response.status})`);
  // From here the provider's figure is in hand: finish keeping it even if the item's time runs out.
  const applying = applyFinalResult(env, ref, facts, now);
  keepAlive?.(applying);
  const applied = await applying;
  // A body cut off or not whole JSON, when the rate needs its outputs: the result may read whole on the next check.
  if (applied === "retry") return retry("result body could not be read");
  return applied === "not_kept" ? retry("figure not kept") : { done: true };
};

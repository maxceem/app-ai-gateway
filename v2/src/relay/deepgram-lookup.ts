/**
 * Deepgram's request lookup after a stream (plan 4.2, "a session-level total"; step 10a): the sweep reads
 * Deepgram's own record of the stream, `GET v1/projects/{project}/requests/{request}`, and settles the
 * session to its dollar figure (`response.details.usd`), by the rules every provider's lookup follows
 * (`./session-lookup.ts`). The request id is the one Deepgram named when the stream opened
 * (`dg-request-id`, stored as the session's provider call id); the project is the key's own
 * (`GET v1/projects`).
 *
 * - A record is ready once `response.completed` is set. A record not there yet (404), or not complete, is
 *   tried again. The real record has `response` at the top level; a record wrapped in `request`, as one of
 *   Deepgram's reference pages shows, is read too.
 * - A complete record with a dollar figure above $0 settles the session. One of $0 or less is not trusted:
 *   the estimate stays, logged, rather than a refund.
 * - A complete record without a dollar figure keeps the estimate at once, logged at `info`. Deepgram leaves
 *   `usd` out for a key that can't read its billing, and the estimate already uses Deepgram's own minutes
 *   (a real run: 24.093 s on both sides).
 * - A key without `usage:read` won't gain it within the hour: a 401 or 403 keeps the estimate at once
 *   (Fable, #273 round 1).
 */
import { sessionLookup, type Figure } from "./session-lookup.ts";

/** An object's fields, or `undefined` for anything else. */
function fieldsOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * What a request record says: `pending` until Deepgram has completed it; then its dollar figure, whatever
 * its sign (the caller judges it), or `no_figure` when the record has none.
 */
export function recordFigure(record: unknown): { readonly kind: "final"; readonly usd: number } | { readonly kind: "no_figure" } | { readonly kind: "pending" } {
  const top = fieldsOf(record);
  const response = fieldsOf(top?.response) ?? fieldsOf(fieldsOf(top?.request)?.response);
  if (response === undefined || typeof response.completed !== "string" || response.completed === "") return { kind: "pending" };
  const usd = fieldsOf(response.details)?.usd;
  return typeof usd === "number" && Number.isFinite(usd) ? { kind: "final", usd } : { kind: "no_figure" };
}

/** The sweep's handler for a Deepgram stream's lookup (`PROVIDER_LOOKUPS.deepgram` in `../ledger/sweep.ts`). */
export const deepgramLookup = sessionLookup("deepgram", async (get, requestId): Promise<Figure> => {
  const projects = await get("v1/projects");
  if (projects.status === 401 || projects.status === 403) return { kind: "keep", message: "session_lookup_refused", facts: { status: projects.status } };
  if (projects.status !== 200) return { kind: "retry", reason: `projects answered ${projects.status}` };
  const list = (projects.body as { projects?: unknown } | null)?.projects;
  const project = Array.isArray(list) ? (list[0] as { project_id?: unknown } | undefined)?.project_id : undefined;
  // An answer cut short or unreadable may read on the next try.
  if (typeof project !== "string" || project === "") return { kind: "retry", reason: "no project in the answer" };
  const record = await get(`v1/projects/${encodeURIComponent(project)}/requests/${encodeURIComponent(requestId)}`);
  if (record.status === 401 || record.status === 403) return { kind: "keep", message: "session_lookup_refused", facts: { status: record.status } };
  // Not there yet: Deepgram writes the record after the stream ends. Any other answer is tried again within the window.
  if (record.status === 404) return { kind: "retry", reason: "record not ready" };
  if (record.status !== 200) return { kind: "retry", reason: `record answered ${record.status}` };
  const figure = recordFigure(record.body);
  if (figure.kind === "pending") return { kind: "retry", reason: "record not complete" };
  // Normal for a key that can't read Deepgram's billing: the estimate stays, without a warning.
  if (figure.kind === "no_figure") return { kind: "keep", message: "session_lookup_no_figure", level: "info" };
  return figure;
});

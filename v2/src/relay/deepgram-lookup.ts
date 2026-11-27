/**
 * Deepgram's request lookup after a stream (plan 4.2, "a session-level total"; step 10a): the sweep reads
 * Deepgram's own record of the stream, `GET v1/projects/{project}/requests/{request}`, and settles the
 * session to its dollar figure (`response.details.usd`), by the rules every provider's lookup follows
 * (`./session-lookup.ts`). The request id is the one Deepgram named when the stream opened
 * (`dg-request-id`, stored as the session's provider call id); the project is the key's own
 * (`GET v1/projects`).
 *
 * - Only a completed record, with its dollar figure, is final. A record not there yet (404), or not
 *   complete, is tried again. The record is wrapped in `request`, its result in `request.response`, as
 *   Deepgram's reference shows. A completed record that bills $0 or less is not trusted: its shape is not
 *   checked against a real record yet, so the estimate stays, logged, rather than a refund.
 * - A key without `usage:read` won't gain it within the hour: a 401 or 403 keeps the estimate at once
 *   (Fable, #273 round 1).
 */
import { sessionLookup, type Figure } from "./session-lookup.ts";

/**
 * What a request record says: its dollar figure once Deepgram has completed it, whatever its sign (the
 * caller judges it); `pending` while it has not (no `completed`, or no figure yet). Deepgram's reference
 * wraps the record in `request`, its result in `request.response` (Sol, #273 round 4).
 */
export function recordFigure(record: unknown): { readonly kind: "final"; readonly usd: number } | { readonly kind: "pending" } {
  const request = typeof record === "object" && record !== null ? (record as { request?: unknown }).request : undefined;
  const response = typeof request === "object" && request !== null ? (request as { response?: unknown }).response : undefined;
  if (typeof response !== "object" || response === null) return { kind: "pending" };
  const { completed, details } = response as { completed?: unknown; details?: unknown };
  const usd = typeof details === "object" && details !== null ? (details as { usd?: unknown }).usd : undefined;
  if (typeof completed !== "string" || completed === "" || typeof usd !== "number" || !Number.isFinite(usd)) return { kind: "pending" };
  return { kind: "final", usd };
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
  return figure.kind === "pending" ? { kind: "retry", reason: "record not complete" } : figure;
});

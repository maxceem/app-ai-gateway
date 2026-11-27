/**
 * Deepgram's request lookup after a stream (plan 4.2, "a session-level total"; step 10a): the sweep reads
 * Deepgram's own record of the stream, `GET v1/projects/{project}/requests/{request}`, and settles the
 * session to its dollar figure (`response.details.usd`), minus every slice already booked
 * (`settleSession`). The request id is the one Deepgram named when the stream opened (`dg-request-id`,
 * stored as the session's provider call id); the project is the key's own (`GET v1/projects`).
 *
 * - Only a final record settles: one Deepgram has `completed`, with its dollar figure. A record not there
 *   yet (404), or not complete, is tried again, at the sweep's own pace (a minute, then doubling). The
 *   record is wrapped in `request`, its result in `request.response`, as Deepgram's reference shows. A
 *   completed record that bills $0 or less is not trusted: its shape is not checked against a real
 *   record yet, so the estimate stays, logged, rather than a refund.
 * - At most `PROVIDER_LOOKUP_WINDOW_MS` after the stream ended (plan 8j): past it, or when the lookup can't
 *   be made at all (no request id, a key that may not read usage, a connection gone or pointed elsewhere,
 *   a key whose copy is known to be missing or removed), the slices' estimate stays, logged, and the
 *   session is marked so. Any other failure (the vault's, an answer cut short) is tried again within the
 *   window.
 * - The key: for an account with split keys on, the copies made when the app asked for the session
 *   (`./start-session.ts`); for one with them off, the connection's own. The vault adds it, as for any call.
 *
 * Every write is safe to repeat: the session's first stored total wins, and settling is one correction.
 */
import { errorFacts } from "../core/error-facts.ts";
import { log } from "../core/log.ts";
import { boundedJson } from "../jobs/jobs.ts";
import { PROVIDER_LOOKUP_WINDOW_MS, settleSession } from "../ledger/sessions.ts";
import type { HandlerResult, OpenWorkHandler } from "../ledger/sweep.ts";
import { fromDollars, MoneyError } from "../money.ts";
import { connectionDescription, readConnection, sealedCredentials, withStoredCopies, type ConnectionRecord } from "../providers/connections.ts";
import type { ProviderDescription } from "../providers/operation.ts";
import { sealedUpstreamRequest } from "../providers/route.ts";
import { vault, type StoredCopies } from "../vault/client.ts";
import { keyCopiesOf } from "../vault/key-copies.ts";

const DONE: HandlerResult = { done: true };
const retry = (reason: string): HandlerResult => ({ done: false, reason });

/** How long one call to Deepgram may take, its body included: well inside the sweep's time for an item. */
const LOOKUP_CALL_MS = 2_000;
/** The largest answer read: a request record is a few KB. */
const LOOKUP_BODY_LIMIT = 256 * 1024;

/** The session as the lookup reads it. */
interface LookedUpSession {
  readonly state: string;
  readonly settlement: string;
  readonly ended_at: number | null;
  readonly provider_call_id: string | null;
  readonly provider_connection_id: string | null;
  readonly app_id: string;
}

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


/** One GET to Deepgram through the vault, with the session's key: its status, and its JSON when it has any. */
async function deepgramGet(
  env: Env,
  connection: ConnectionRecord,
  description: ProviderDescription,
  path: string,
  copies: StoredCopies | null,
  signal: AbortSignal | undefined,
  appId: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  signal?.throwIfAborted();
  const target = sealedUpstreamRequest(connection, description, {
    hostKey: "main",
    path,
    query: "",
    credentials: copies === null ? sealedCredentials(connection) : withStoredCopies(sealedCredentials(connection), copies),
    client: new Headers(),
    appId,
    userId: null,
  });
  const deadline = Date.now() + LOOKUP_CALL_MS;
  const response = await vault(env).call({
    url: target.url,
    method: "GET",
    headers: new Headers(target.headers),
    body: null,
    signal: signal === undefined ? AbortSignal.timeout(LOOKUP_CALL_MS) : AbortSignal.any([signal, AbortSignal.timeout(LOOKUP_CALL_MS)]),
    deadline,
    credentials: target.credentials,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, body: null };
  }
  const read = await boundedJson(response, { limit: LOOKUP_BODY_LIMIT, deadlineMs: Math.max(0, deadline - Date.now()) });
  return { status: response.status, body: read.kind === "parsed" ? read.value : null };
}

/** The sweep's handler for a Deepgram stream's lookup (`PROVIDER_LOOKUPS.deepgram` in `../ledger/sweep.ts`). */
export const deepgramLookup: OpenWorkHandler = async (env, item, { ledger, now, lastTry, signal, keepAlive }) => {
  const sessionId = item.ownerId;
  const session = await ledger
    .prepare("SELECT state, settlement, ended_at, provider_call_id, provider_connection_id, app_id FROM session WHERE id = ?")
    .bind(sessionId)
    .first<LookedUpSession>();
  // Gone with retention, or settled already (the estimate kept, or a total applied): nothing to do.
  if (session === null || session.settlement !== "open") return DONE;
  // Not ended yet: `close`, or the stale-session sweep, ends it, and this row is due again then.
  if (session.state !== "ended" || session.ended_at === null) return retry("session not ended");
  const facts = { app: session.app_id, session: sessionId };
  /** No figure will come: the slices' estimate stays, and the session says so. */
  const keepEstimate = async (message: string, more: Record<string, unknown> = {}): Promise<HandlerResult> => {
    log("warn", message, { ...facts, ...more });
    await settleSession(ledger, { sessionId, now, lastTry: true });
    return DONE;
  };
  if (now - session.ended_at > PROVIDER_LOOKUP_WINDOW_MS || lastTry) return keepEstimate("session_lookup_expired");
  if (session.provider_call_id === null) return keepEstimate("session_lookup_no_request_id");
  const copies = keyCopiesOf(item.detail);
  if (copies === "missing") return keepEstimate("session_lookup_key_unavailable");
  if (session.provider_connection_id === null) return keepEstimate("session_lookup_connection_changed");

  // The connection, read fresh: one deleted, made again under its slug, or now another provider's is not the stream's.
  const slug = await env.DB.prepare("SELECT slug FROM provider_connection WHERE id = ?").bind(session.provider_connection_id).first<{ slug: string }>();
  const connection = slug === null ? null : await readConnection(env, item.accountId, slug.slug);
  const description = connection === null ? null : connectionDescription(connection);
  if (connection === null || description === null || connection.id !== session.provider_connection_id || connection.type !== "deepgram") {
    return keepEstimate("session_lookup_connection_changed");
  }
  // A paused connection's key is never opened: tried again later.
  if (connection.status === "disabled") return retry("the session's connection is disabled");

  let projects: { readonly status: number; readonly body: unknown };
  let record: { readonly status: number; readonly body: unknown };
  try {
    projects = await deepgramGet(env, connection, description, "v1/projects", copies, signal, session.app_id);
    // A key without `usage:read` won't gain it within the hour: the estimate stays at once (Fable, #273 round 1).
    if (projects.status === 401 || projects.status === 403) return keepEstimate("session_lookup_refused", { status: projects.status });
    if (projects.status !== 200) return retry(`projects answered ${projects.status}`);
    const list = (projects.body as { projects?: unknown } | null)?.projects;
    const project = Array.isArray(list) ? (list[0] as { project_id?: unknown } | undefined)?.project_id : undefined;
    // An answer cut short or unreadable may read on the next try.
    if (typeof project !== "string" || project === "") return retry("no project in the answer");
    record = await deepgramGet(env, connection, description, `v1/projects/${encodeURIComponent(project)}/requests/${encodeURIComponent(session.provider_call_id)}`, copies, signal, session.app_id);
  } catch (error) {
    // Anything else, the vault's refusal or a timeout included, may pass: tried again within the window.
    // Only a copy known to be missing or removed ends the lookup at once, above (Sol, #273 round 1).
    log("warn", "session_lookup_failed", { ...facts, error: errorFacts(error) });
    return retry("lookup failed");
  }
  if (record.status === 401 || record.status === 403) return keepEstimate("session_lookup_refused", { status: record.status });
  // Not there yet: Deepgram writes the record after the stream ends. Any other answer is tried again within the window.
  if (record.status === 404) return retry("record not ready");
  if (record.status !== 200) return retry(`record answered ${record.status}`);
  const figure = recordFigure(record.body);
  if (figure.kind === "pending") return retry("record not complete");
  // A free (or negative) stream is not trusted until real records show the shape: the estimate stays, whatever
  // was booked so far, since a late or unpriced slice can make that $0 too (Sol round 3, Gemini Neon round 1, #273).
  if (figure.usd <= 0) return keepEstimate("session_lookup_figure_doubtful");
  let total;
  try {
    total = fromDollars(figure.usd);
  } catch (error) {
    if (!(error instanceof MoneyError)) throw error;
    return keepEstimate("session_lookup_figure_unusable");
  }
  // Rounded to nothing (a figure below a nano-dollar): as doubtful as $0.
  if (total <= 0) return keepEstimate("session_lookup_figure_doubtful");
  // The final figure is in hand: it is applied even if the item's time runs out meanwhile.
  const applying = settleSession(ledger, { sessionId, providerTotal: total, now });
  keepAlive?.(applying.catch(() => undefined));
  const settled = await applying;
  log("info", "session_lookup_settled", { ...facts, settlement: settled });
  // Stored on the session even while a slice is still on its way: the session's own sweep row applies it.
  return DONE;
};

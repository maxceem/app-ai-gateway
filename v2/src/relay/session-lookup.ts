/**
 * A provider's own record of a session, read after it ends (plan 4.2, "a session-level total"): the sweep
 * settles the session to the provider's dollar figure, minus every slice already booked (`settleSession`).
 * One set of rules for every provider that has one: Deepgram's request record (10a, `./deepgram-lookup.ts`)
 * and ElevenLabs' conversation record (11a, `./elevenlabs-agent.ts`). Each provider says only how its
 * record is read (`ReadFigure`); everything else is here.
 *
 * - Only a final record settles. One not there yet, or not final, is tried again, at the sweep's own pace
 *   (a minute, then doubling).
 * - At most `PROVIDER_LOOKUP_WINDOW_MS` after the session ended (plan 8j): past it, or when the lookup can't
 *   be made at all (no call id, a key that may not read the record, a connection gone or pointed elsewhere,
 *   a key whose copy is known to be missing or removed, a record gone for good), the slices' estimate stays,
 *   logged, and the session is marked so. Any other failure (the vault's, an answer cut short) is tried
 *   again within the window.
 * - A final figure of $0 or less is not trusted: the estimate stays, logged, rather than a refund.
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
import { connectionDescription, readConnection, sealedCredentials, withStoredCopies } from "../providers/connections.ts";
import { sealedUpstreamRequest } from "../providers/route.ts";
import { vault } from "../vault/client.ts";
import { keyCopiesOf } from "../vault/key-copies.ts";

const DONE: HandlerResult = { done: true };
const retry = (reason: string): HandlerResult => ({ done: false, reason });

/** How long one call to the provider may take, its body included: well inside the sweep's time for an item. */
const LOOKUP_CALL_MS = 2_000;
/** The largest answer read: a record is a few KB, an ElevenLabs conversation with its transcript a little more. */
const LOOKUP_BODY_LIMIT = 1024 * 1024;

/** One GET to the provider with the session's key: its status, and its JSON when it has any. */
export type ProviderGet = (path: string) => Promise<{ readonly status: number; readonly body: unknown }>;

/**
 * What a provider's record says: its dollar figure once final (whatever its sign: it is judged here);
 * `retry` while it isn't, with why; `keep` when no figure will come (the estimate stays), with the log
 * line that says why. That line is a `warn`, unless `level` says it is a normal outcome (`info`).
 */
export type Figure =
  | { readonly kind: "final"; readonly usd: number }
  | { readonly kind: "retry"; readonly reason: string }
  | { readonly kind: "keep"; readonly message: string; readonly facts?: Readonly<Record<string, unknown>>; readonly level?: "info" };

/** How one provider reads its record, by the session's provider call id. */
export type ReadFigure = (get: ProviderGet, callId: string) => Promise<Figure>;

/** The session as the lookup reads it. */
interface LookedUpSession {
  readonly state: string;
  readonly settlement: string;
  readonly ended_at: number | null;
  readonly provider_call_id: string | null;
  readonly provider_connection_id: string | null;
  readonly app_id: string;
}

/** The sweep's handler for `providerType`'s lookup (`PROVIDER_LOOKUPS` in `../ledger/sweep.ts`). */
export function sessionLookup(providerType: string, readFigure: ReadFigure): OpenWorkHandler {
  return async (env, item, { ledger, now, lastTry, signal, keepAlive }) => {
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
    const keepEstimate = async (message: string, more: Readonly<Record<string, unknown>> = {}, level: "info" | "warn" = "warn"): Promise<HandlerResult> => {
      log(level, message, { ...facts, ...more });
      await settleSession(ledger, { sessionId, now, lastTry: true });
      return DONE;
    };
    if (now - session.ended_at > PROVIDER_LOOKUP_WINDOW_MS || lastTry) return keepEstimate("session_lookup_expired");
    if (session.provider_call_id === null) return keepEstimate("session_lookup_no_request_id");
    const copies = keyCopiesOf(item.detail);
    if (copies === "missing") return keepEstimate("session_lookup_key_unavailable");
    if (session.provider_connection_id === null) return keepEstimate("session_lookup_connection_changed");

    // The connection, read fresh: one deleted, made again under its slug, or now another provider's is not the session's.
    const slug = await env.DB.prepare("SELECT slug FROM provider_connection WHERE id = ?").bind(session.provider_connection_id).first<{ slug: string }>();
    const connection = slug === null ? null : await readConnection(env, item.accountId, slug.slug);
    const description = connection === null ? null : connectionDescription(connection);
    if (connection === null || description === null || connection.id !== session.provider_connection_id || connection.type !== providerType) {
      return keepEstimate("session_lookup_connection_changed");
    }
    // A paused connection's key is never opened: tried again later.
    if (connection.status === "disabled") return retry("the session's connection is disabled");

    const credentials = copies === null ? sealedCredentials(connection) : withStoredCopies(sealedCredentials(connection), copies);
    const get: ProviderGet = async (path) => {
      signal?.throwIfAborted();
      const target = sealedUpstreamRequest(connection, description, { hostKey: "main", path, query: "", credentials, client: new Headers(), appId: session.app_id, userId: null });
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
    };

    let figure: Figure;
    try {
      figure = await readFigure(get, session.provider_call_id);
    } catch (error) {
      // Anything else, the vault's refusal or a timeout included, may pass: tried again within the window.
      // Only a copy known to be missing or removed ends the lookup at once, above (Sol, #273 round 1).
      log("warn", "session_lookup_failed", { ...facts, error: errorFacts(error) });
      return retry("lookup failed");
    }
    if (figure.kind === "retry") return retry(figure.reason);
    if (figure.kind === "keep") return keepEstimate(figure.message, figure.facts, figure.level);
    // A free (or negative) session is not trusted: the estimate stays, whatever was booked so far, since a late
    // or unpriced slice can make that $0 too (Sol round 3, Gemini Neon round 1, #273).
    if (!Number.isFinite(figure.usd) || figure.usd <= 0) return keepEstimate("session_lookup_figure_doubtful");
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
}

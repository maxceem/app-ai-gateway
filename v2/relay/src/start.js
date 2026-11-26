// @ts-check
/**
 * A session's start and end, apart from any WebSocket (plan section 4.3; the
 * crash table, `v2-prep/relay-crash-table.md`). The session object
 * (`./index.js`) wires it to its storage, the vault, the main Worker and the
 * provider; the tests wire it to stand-ins, and "restart" it by making a new
 * one over the same storage.
 *
 * Start order (crash table, "Call order at start"):
 * 1. the vault opens the session's key from the ticket, and names the one
 *    address it may go to; nothing is stored before;
 * 2. `open` on the main Worker; nothing is stored before it succeeds;
 * 3. one write: the ticket, `open`'s settings and `starting`, with the alarm;
 * 4. "connecting" is stored, then the provider is called, once: an unknown
 *    outcome is never retried, since a retry could start a second paid call;
 * 5. one write: `active`, the call id and the reconnect secret's hash, with
 *    the alarm at the first tick.
 * Then the alarm ticks every `TICK_MS` until the session ends: the time cap,
 * a lost provider socket, and the liveness checks the session object gives
 * (`liveness`: the heartbeat and "client too slow", `./frames.js`). The
 * checkpoint joins the tick with the journal (step 9a part 2).
 *
 * The end: one write stores `ended`, the reason and the final slice, then
 * `close` is sent; the alarm retries it. Storage is deleted once `close` is
 * confirmed (or given up on) and the ticket has expired; until then the
 * `ended` marker refuses the ticket again (row 28).
 */
import { TICK_MS } from "./frames.js";
import { deadlineOf, parseTicket } from "./ticket.js";

/** How long an ended session keeps retrying `close` before it gives up and logs (crash table row 25). */
export const CLOSE_RETRY_MS = 30 * 60_000;
/** How soon the alarm tries `close` again. */
export const CLOSE_RETRY_EVERY_MS = 30_000;

/**
 * The close code a client gets for an end the relay decided about the client
 * itself: the same code whichever path found it (a tick, or a report). Other
 * ends close with 1000 and the reason.
 * @type {Record<string, number>}
 */
const CLIENT_END_CODES = { client_too_slow: 4000, heartbeat_timeout: 4000 };

/**
 * @typedef {{
 *   get(keys: string[]): Promise<Map<string, unknown>>,
 *   put(entries: Record<string, unknown>, alarmAt: number | null): Promise<void>,
 *   deleteAll(): Promise<void>,
 * }} Store
 * `put` writes the entries and sets the alarm in one write (crash table, "Alarm rule"); null keeps it.
 *
 * @typedef {{ key?: { value: string, header: string, format: string }, cloudflareToken?: string, target: string }} SessionKey
 * @typedef {{ sessionKey(ticket: string, options: { restart: boolean }): Promise<SessionKey> }} VaultPort
 * @typedef {{ deadline: number, mode: string, operation: string, checkpointIntervalMs: number, version: number }} Settings
 * @typedef {{
 *   open(ticket: string): Promise<Settings>,
 *   close(ticket: string, input: { finalSlice: number, endReason: string, endedAt: number, providerCallId: string | null }): Promise<unknown>,
 * }} MainPort
 * @typedef {{ callId: string | null, close?: (code: number, reason: string) => void }} ProviderCall
 * `close` hangs up the provider's side of a relayed session.
 * @typedef {{ connect(key: SessionKey): Promise<ProviderCall> }} ProviderPort
 * `connect` throws `ProviderRefused` for a known refusal; anything else is an unknown outcome.
 * @typedef {(event: Record<string, unknown>) => void} Logger
 * @typedef {{ close(code: number, reason: string): void }} Client the connection a session is started for
 * @typedef {(now: number) => string | null} Liveness the live session's own checks on each tick: an end reason, or null
 */

/** The provider said no, with an answer: nothing was started there (crash table row 12). */
export class ProviderRefused extends Error {
  /** @param {number} status */
  constructor(status) {
    super(`provider refused with ${status}`);
    this.name = "ProviderRefused";
    this.status = status;
  }
}

const KEYS = ["state", "ticket", "settings", "connecting", "callId", "end", "closed"];

/** @param {string} secret */
async function hashOf(secret) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function newSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/**
 * The code an error from the vault or the main Worker carries: their
 * refusals' messages are codes. Anything else is "unavailable", so a message
 * is never passed on.
 * @param {unknown} error
 */
function codeOf(error) {
  const message = error instanceof Error ? error.message : "";
  return /^[a-z_]{1,40}$/u.test(message) ? message : "unavailable";
}

export class SessionCore {
  /**
   * @param {{ store: Store, vault: VaultPort, main: MainPort, provider: ProviderPort, now?: () => number, log?: Logger, liveness?: Liveness }} parts
   */
  constructor(parts) {
    this.store = parts.store;
    this.vault = parts.vault;
    this.main = parts.main;
    this.provider = parts.provider;
    this.now = parts.now ?? (() => Date.now());
    this.log = parts.log ?? ((event) => console.log(JSON.stringify(event)));
    /** @type {Liveness} */
    this.liveness = parts.liveness ?? (() => null);
    /** A start is in flight in this instance: a second connection with the ticket gets an error (row 8). */
    this.starting = false;
    /**
     * The one connection the session belongs to: set when its start begins, cleared when it
     * hangs up or the session ends. Only its close ends the session; any other changes nothing.
     * @type {Client | undefined | null}
     */
    this.owner = null;
    /** @type {ProviderCall | null} The provider's side, while this instance holds it. A restart loses it. */
    this.call = null;
    /** For the logs. */
    this.sessionId = "";
    /** @type {Promise<void> | null} The end in flight: a second caller waits for it, so one reason is stored and one `close` sent. */
    this.ending = null;
    /** @type {Client | undefined | null} The client whose start ran last past the running-session check. */
    this.lastStarter = null;
  }

  /**
   * Starts the session for `client`, which brought `ticketText`. The relay's
   * entry has checked its signature and routed it to this object by its
   * session id; this checks the rest. Returns the reconnect secret, or a code
   * the client gets.
   * @param {string} ticketText
   * @param {import("./ticket.js").Ticket} ticket
   * @param {Client} [client]
   * @returns {Promise<{ ok: true, reconnectSecret: string, call: ProviderCall, deadline: number } | { ok: false, code: string }>}
   */
  async start(ticketText, ticket, client) {
    // Also while an end is in flight: a start never runs into the middle of one.
    if (this.starting || this.ending !== null) return { ok: false, code: "start_in_flight" };
    // A session already running in this instance is refused at once, before any wait: nothing a
    // second connection's start does (a storage error, say) can then touch the running one.
    if (this.call !== null || (this.owner !== null && this.owner !== undefined && this.owner !== client)) return { ok: false, code: "session_active" };
    // Set before the first wait, so a second connection that arrives meanwhile is refused.
    this.starting = true;
    this.owner = client;
    this.lastStarter = client;
    this.sessionId = ticket.sid;
    /** @type {ProviderCall | null} The call this start made, the only one its failure may hang up. */
    let ownCall = null;
    /** @param {string} code */
    const fail = (code) => {
      if (this.owner === client) this.owner = null;
      return /** @type {{ ok: false, code: string }} */ ({ ok: false, code });
    };
    /**
     * Ends the session from the start's own failure: the client is told by the
     * caller, with the start's code, not by `end` with a bare reason.
     * @param {string} reason
     * @param {{ log?: string, status?: number }} details
     */
    const endStart = (reason, details) => {
      if (this.owner === client) this.owner = null;
      return this.end(reason, details);
    };
    try {
      const stored = await this.store.get(KEYS);
      const state = stored.get("state");
      if (state === "ended") return fail("session_ended");
      if (state === "active") return fail("session_active");
      // A restart in `starting`: `open` is done. A retry with the same ticket goes on (row 9),
      // unless "connecting" was recorded: then the outcome is unknown, and it never connects again (rows 10, 11).
      const resumed = state === "starting";
      if (resumed && stored.get("connecting") === true) {
        await endStart("error", { log: "relay_start_outcome_unknown" });
        return fail("session_ended");
      }
      if (this.now() >= ticket.exp) return fail("ticket_expired");

      /** @type {SessionKey} */
      let key;
      try {
        key = await this.vault.sessionKey(ticketText, { restart: false });
      } catch (error) {
        // Nothing stored, nothing started: the client may retry with the same ticket (row 4).
        this.log({ level: "warn", message: "relay_vault_refused", session: ticket.sid, code: codeOf(error) });
        return fail("credential_unavailable");
      }

      // The client left while the vault answered: no `open`, so no open-then-close round trip.
      if (this.owner !== client) return fail("client_closed");

      /** @type {Settings} */
      let settings;
      if (resumed) {
        settings = /** @type {Settings} */ (stored.get("settings"));
      } else {
        try {
          settings = await this.main.open(ticketText);
        } catch (error) {
          // Nothing stored: the client may retry with the same ticket (rows 5, 6).
          const code = codeOf(error);
          this.log({ level: "warn", message: "relay_open_failed", session: ticket.sid, code });
          return fail(code === "ticket_expired" || code === "ticket_refused" ? code : "open_failed");
        }
        // `open` succeeded: only now is anything stored, with the alarm that closes the session
        // if no client starts it before the ticket expires (row 9).
        await this.store.put({ state: "starting", ticket: ticketText, settings }, ticket.exp);
      }

      // The waits above may have taken the ticket past its time, or the client may have gone.
      if (!(await this.mayGoOn(client, ticket))) return fail(await this.stop(client, ticket));
      await this.store.put({ connecting: true }, null);
      try {
        // Kept at once, so whatever happens next can hang it up.
        ownCall = await this.provider.connect(key);
        this.call = ownCall;
      } catch (error) {
        if (error instanceof ProviderRefused) {
          await endStart("error", { log: "relay_provider_refused", status: error.status });
        } else {
          // Sent, and no answer came back: never retried (4.3 step 4; row 10).
          await endStart("error", { log: "relay_start_outcome_unknown" });
        }
        return fail("provider_unavailable");
      }
      const call = this.call;
      const reconnectSecret = newSecret();
      const reconnect = await hashOf(reconnectSecret);
      const deadline = deadlineOf(ticket);
      // A slow handshake: the alarm may have ended the session, the client may have gone, or
      // the time run out. Then the provider's side is hung up, and an ended session stays ended.
      // Nothing waits between this check and the `active` write.
      if (!(await this.mayGoOn(client, ticket))) return fail(await this.stop(client, ticket));
      // The alarm's first tick: from then on it ticks every `TICK_MS` (plan section 5), so a
      // restarted object that lost its provider socket ends soon (row 13).
      await this.store.put({ state: "active", callId: call.callId, reconnect }, Math.min(deadline, this.now() + TICK_MS));
      // A hang-up during that write has ended the session (`clientGone`): nothing waits after this check.
      if (this.owner !== client) return fail("client_closed");
      // A write held past the deadline: the session's time is over before it began.
      if (this.now() >= deadline) {
        await endStart("time_cap", {});
        return fail("session_ended");
      }
      return { ok: true, reconnectSecret, call, deadline };
    } catch (error) {
      // Anything unexpected (a storage failure, say) never leaves this start's provider call
      // behind. Only what this start made is touched: never another client's call or owner.
      if (ownCall !== null && this.call === ownCall) {
        this.call = null;
        ownCall.close?.(1011, "relay error");
      }
      if (this.owner === client) this.owner = null;
      throw error;
    } finally {
      this.starting = false;
    }
  }

  /**
   * Whether the start may go on: `client` still owns the session, it is still
   * `starting`, and neither the ticket nor the session is past its time.
   * @param {Client | undefined} client
   * @param {import("./ticket.js").Ticket} ticket
   */
  async mayGoOn(client, ticket) {
    if (this.owner !== client) return false;
    const now = this.now();
    if (now >= ticket.exp || now >= deadlineOf(ticket)) return false;
    return (await this.store.get(["state"])).get("state") === "starting" && this.owner === client;
  }

  /**
   * A start that may not go on: the provider's side is hung up, and the session
   * ends if it is still starting. Returns the code the client gets.
   * @param {Client | undefined} client
   * @param {import("./ticket.js").Ticket} ticket
   */
  async stop(client, ticket) {
    const call = this.call;
    this.call = null;
    call?.close?.(1000, "session ended");
    // Ended meanwhile (the alarm, or the client's close): it stays ended, and the client is told why.
    const stored = await this.store.get(["state", "end"]);
    if (stored.get("state") !== "starting") {
      const reason = /** @type {{ reason?: string } | undefined} */ (stored.get("end"))?.reason;
      if (reason === "client_closed") return "client_closed";
      return this.now() >= ticket.exp ? "ticket_expired" : "session_ended";
    }
    if (this.owner !== client) {
      await this.end("client_closed");
      return "client_closed";
    }
    // The start's own failure: the caller tells the client, with this code.
    this.owner = null;
    await this.end("error", { log: "relay_start_too_late" });
    return this.now() >= ticket.exp ? "ticket_expired" : "session_ended";
  }

  /**
   * A connection closed. Only the session's owner counts: its close ends the
   * session, during the start too (the start stops at its next check). A
   * connection that was turned away changes nothing.
   * @param {Client} client
   */
  async clientGone(client) {
    if (client !== this.owner) return;
    this.owner = null;
    const state = (await this.store.get(["state"])).get("state");
    if (state === "active" || state === "starting") await this.end("client_closed");
  }

  /**
   * The provider's side of `call` closed. Only the current call counts: a close
   * the relay caused itself, after letting go of the call, changes nothing.
   * @param {ProviderCall} call
   */
  async providerGone(call) {
    if (call !== this.call) return;
    await this.end("provider_closed");
  }

  /** Whether `client` ran the last start that got past the running-session check: its failure may end the session. @param {Client} client */
  startedBy(client) {
    return this.lastStarter === client;
  }

  /**
   * Ends the session: closes both sides with the reason, stores the end in one
   * write, then sends `close` once. The alarm retries `close` until it is
   * confirmed, then cleans up. One end at a time: a caller that comes while one
   * is in flight waits for it.
   * @param {string} reason
   * @param {{ finalSlice?: number, log?: string, status?: number }} [details]
   */
  end(reason, details = {}) {
    if (this.ending !== null) return this.ending;
    // Started a step later, so `ending` is set before anything inside the end runs: a close
    // event that the end itself causes (the provider's socket) already finds it in flight.
    // Cleared when it settles, whether it ended a session or found nothing to end: a stale end
    // must never swallow a later session's ends. A real end leaves `ended` stored, which stops
    // a repeat on its own; a failed one (its write failed) can run again.
    /** @type {Promise<void>} */
    const ending = Promise.resolve().then(async () => {
      try {
        await this.endOnce(reason, details);
      } finally {
        if (this.ending === ending) this.ending = null;
      }
    });
    this.ending = ending;
    return ending;
  }

  /**
   * @param {string} reason
   * @param {{ finalSlice?: number, log?: string, status?: number }} details
   */
  async endOnce(reason, details) {
    const owner = this.owner;
    const call = this.call;
    this.owner = null;
    this.call = null;
    // Both sides are told, with the reason: the provider hung up, the client closed. A client
    // whose start is still in flight is told by that start, with its code (`4000`), when it
    // finds the session ended: never a bare `1000 "error"` from here.
    call?.close?.(1000, "session ended");
    if (!this.starting) owner?.close(CLIENT_END_CODES[reason] ?? 1000, reason);
    const stored = await this.store.get(KEYS);
    if (stored.get("state") === "ended" || typeof stored.get("ticket") !== "string") return;
    const at = this.now();
    if (details.log !== undefined) {
      this.log({ level: reason === "error" ? "error" : "info", message: details.log, session: this.sessionIdOf(stored), ...(details.status === undefined ? {} : { status: details.status }) });
    }
    await this.store.put({ state: "ended", end: { reason, at, finalSlice: details.finalSlice ?? 0 } }, at + CLOSE_RETRY_EVERY_MS);
    await this.sendClose();
  }

  /** The session id, for a log line. @param {Map<string, unknown>} stored */
  sessionIdOf(stored) {
    const ticket = stored.get("ticket");
    return (typeof ticket === "string" ? parseTicket(ticket)?.payload.sid : undefined) ?? this.sessionId;
  }

  /** Sends `close`; on success, the next alarm cleans up. @returns {Promise<boolean>} */
  async sendClose() {
    const stored = await this.store.get(KEYS);
    const ticket = stored.get("ticket");
    const end = /** @type {{ reason: string, at: number, finalSlice: number } | undefined} */ (stored.get("end"));
    if (typeof ticket !== "string" || end === undefined || stored.get("closed") === true) return true;
    try {
      await this.main.close(ticket, {
        finalSlice: end.finalSlice,
        endReason: end.reason,
        endedAt: end.at,
        providerCallId: typeof stored.get("callId") === "string" ? /** @type {string} */ (stored.get("callId")) : null,
      });
    } catch (error) {
      this.log({ level: "warn", message: "relay_close_failed", session: this.sessionIdOf(stored), code: codeOf(error) });
      return false;
    }
    await this.store.put({ closed: true }, this.cleanupAt(ticket));
    return true;
  }

  /** When storage may go: once the ticket has expired, so the `ended` marker refuses it until then. @param {string} ticketText */
  cleanupAt(ticketText) {
    return Math.max(this.now(), ticketExpiry(ticketText));
  }

  /** The alarm: the one place a session moves on by time (crash table rows 9–13, 25, 28). */
  async alarm() {
    const stored = await this.store.get(KEYS);
    const state = stored.get("state");
    const ticketText = stored.get("ticket");
    const now = this.now();
    // An empty object stays empty and sets no new alarm (row 28).
    if (state === undefined || typeof ticketText !== "string") return;
    const settings = /** @type {Settings | undefined} */ (stored.get("settings"));
    if (state === "starting") {
      // A start that recorded "connecting" and then lost its instance: the outcome is unknown (rows 10, 11).
      if (stored.get("connecting") === true && !this.starting) return this.end("error", { log: "relay_start_outcome_unknown" });
      const exp = ticketExpiry(ticketText);
      // No client started it before the ticket expired (row 9).
      if (now >= exp) return this.end("error", { log: "relay_start_never_finished" });
      return this.store.put({}, exp);
    }
    if (state === "active") {
      const deadline = settings?.deadline ?? now;
      if (now >= deadline) return this.end("time_cap");
      // The next tick is armed before anything that can fail (crash table row 29): a tick that
      // throws still leaves the session its next one.
      await this.store.put({}, Math.min(deadline, now + TICK_MS));
      // A relayed session lost its provider socket with its instance: it ends (row 13, relayed).
      // An observed session reattaches instead (part 3): until then it waits for its deadline.
      if (this.call === null && settings?.mode !== "observed") return this.end("error", { log: "relay_provider_lost" });
      // The live session's own checks: a silent client, a client too far behind.
      const reason = this.liveness(now);
      if (reason !== null) return this.end(reason);
      // Seam: the checkpoint joins the tick with the journal (step 9a part 2).
      return;
    }
    // Ended: retry `close` for a while, then give up and log; then clean up once the ticket has expired.
    const end = /** @type {{ at: number } | undefined} */ (stored.get("end"));
    if (stored.get("closed") !== true) {
      if (await this.sendClose()) return;
      if (now - (end?.at ?? now) < CLOSE_RETRY_MS) return this.store.put({}, now + CLOSE_RETRY_EVERY_MS);
      this.log({ level: "error", message: "relay_close_given_up", session: this.sessionIdOf(stored) });
      await this.store.put({ closed: true }, this.cleanupAt(ticketText));
      return;
    }
    if (now >= ticketExpiry(ticketText)) return this.store.deleteAll();
    return this.store.put({}, ticketExpiry(ticketText));
  }
}

/** A stored ticket's expiry. It was checked before it was stored. @param {string} ticketText */
function ticketExpiry(ticketText) {
  return parseTicket(ticketText)?.payload.exp ?? 0;
}

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
 * An observed session runs the same steps, with no socket: step 4 creates the
 * call from the app's offer, and the answer goes back only after step 5; its
 * side channel is attached after, and again whenever it is lost (`attachSide`).
 * Then the alarm ticks every `TICK_MS` until the session ends: the time cap,
 * a lost provider socket, the liveness checks the session object gives
 * (`liveness`: the heartbeat and "client too slow", `./frames.js`), and the
 * checkpoint when it is due.
 *
 * Usage goes to the journal (`./journal.js`) as it arrives, after its frame
 * was forwarded. A checkpoint freezes it into a slice, stores the slice, then
 * sends it; the slice stays until the main Worker says it is written
 * (crash table rows 14–18). Only one is unconfirmed at a time.
 *
 * The end: the client is told at once. If the provider is in the middle of an
 * answer, the relay waits for it to finish, up to `CLOSE_DRAIN_MS` and never
 * past the deadline, so the last answer's usage is counted (plan 5.1); nothing
 * more goes to the client or the provider meanwhile. There is no wait at the
 * time cap or when the provider hung up. An answer still open after the wait
 * was cut off: the final slice is booked `partial`. Then the provider is hung
 * up, and one write stores `ended`, the reason, the final slice and the
 * journal with the rest of the usage frozen; then the unsent slices are
 * delivered, as accounting only, and `close` is sent. The alarm retries both. Storage is deleted once both are
 * done (or given up on, with the slices logged) and the ticket has expired;
 * until then the `ended` marker refuses the ticket again (rows 25–28).
 *
 * The session's states (plan 4.3), the only ones there are. The object keeps
 * its state in its own storage:
 *
 * | State      | Entered when                              | Leaves for | Never      |
 * | ---------- | ----------------------------------------- | ---------- | ---------- |
 * | (none)     | nothing stored yet                        | `starting` |            |
 * | `starting` | `open` succeeded (start step 3)           | `active`, `ended` |     |
 * | `active`   | the provider's side is up (start step 5)  | `ended`    | `starting` |
 * | `ended`    | any end: a stop, the cap, a hang-up, …   | (cleanup)  | any other  |
 *
 * Only `active` sends checkpoints, and only `active` forwards frames. An ended
 * session never reopens: its ticket is refused until it expires, then its
 * storage is deleted. Takeover: a checkpoint's `replaced` stop ends the old
 * session like any other stop; the client gets `1000 replaced`, a normal
 * close, so it does not reconnect on its own (`PROTOCOL.md`).
 */
import { TICK_MS } from "./frames.js";
import { adapterFor, knownAdapter } from "./adapters.js";
import { carryOpen, carryTotals, confirm, countMeasure, finalSliceOf, freeze, JOURNAL_KEY, markActive, markAudio, markAttached, markDetached, newJournal, readJournal, addUsage } from "./journal.js";
import { deadlineOf, parseTicket } from "./ticket.js";

/** The contract version this relay speaks (`src/relay/contract.ts` in the gateway): 2 adds `checkpoint`. */
export const RELAY_CONTRACT_VERSION = 2;
/** How long a checkpoint may take: past it, the session goes on and the slice is sent again (plan 5.1). */
export const CHECKPOINT_TIMEOUT_MS = 5_000;

/**
 * The end reason a checkpoint's stop gives: its first reason. The ledger's
 * "ended" (it closed the session itself, say after a lost `close`) is not an
 * end reason of its own: the session ends with `error`, logged.
 * @param {readonly string[]} reasons
 */
function stopReason(reasons) {
  const first = reasons[0] ?? "error";
  return first === "ended" ? "error" : first;
}

/** How long an ending session waits for the usage writes in flight, on local storage, before it freezes its last slice. */
export const END_WRITES_MS = 2_000;

/** How long a closing session waits for the provider's answer in progress to finish (plan 5.1). */
export const CLOSE_DRAIN_MS = 10_000;

/** A side channel that closes sooner than this after it attached is attached again on the next tick, not at once. */
export const SIDE_CHANNEL_MIN_LIFE_MS = 5_000;

/**
 * How long a restarted instance waits for the vault's key, for a reattach or a hang-up: past it the
 * call stays detached, or the hang-up owed, and the next wakeup tries again. Short, so a stalled
 * vault never holds a tick's checkpoint, and a stop from the gateway still reaches the call.
 */
export const VAULT_KEY_WAIT_MS = 5_000;

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
 *   putJournal(journal: import("./journal.js").Journal): Promise<void>,
 *   deleteAll(): Promise<void>,
 * }} Store
 * `put` writes the entries and sets the alarm in one write (crash table, "Alarm rule"); null keeps it.
 * `putJournal` is the journal's one small write per usage event (plan 5.2 rule 3).
 *
 * @typedef {{ key?: { value: string, header: string, format: string }, cloudflareToken?: string, target: string }} SessionKey
 * @typedef {{ sessionKey(ticket: string, options: { restart: boolean }): Promise<SessionKey> }} VaultPort
 * @typedef {{ deadline: number, mode: string, operation: string, checkpointIntervalMs: number, version: number, adapter?: string, model?: string | null, backend?: import("./adapters.js").Backend }} Settings
 * @typedef {{ decision: "continue" | "stop", reasons: string[], written: boolean }} CheckpointReply
 * @typedef {{
 *   slice: import("./journal.js").Slice | null,
 *   connected: boolean,
 *   accounting: boolean,
 *   providerCallId: string | null,
 *   relayVersion: number,
 * }} CheckpointCall
 * @typedef {{
 *   open(ticket: string): Promise<Settings>,
 *   checkpoint(ticket: string, input: CheckpointCall): Promise<CheckpointReply>,
 *   close(ticket: string, input: { finalSlice: number, endReason: string, endedAt: number, providerCallId: string | null, relayVersion: number }): Promise<unknown>,
 * }} MainPort
 * @typedef {{ callId: string | null, close?: (code: number, reason: string) => void, estimate?: () => import("./journal.js").UsageEvent | null }} ProviderCall
 * `close` hangs up the provider's side of a relayed session, or closes an observed call's side channel.
 * `estimate`, for a provider whose cut answer never reports usage (Gemini Live, OpenAI Realtime): what the session's
 * own end bills for the answer it cuts, asked once before the final slice.
 * @typedef {{
 *   connect(key: SessionKey, settings: Settings): Promise<ProviderCall>,
 *   createCall?(key: SessionKey, offer: string): Promise<{ callId: string, answer: string }>,
 *   attach?(key: SessionKey, callId: string, adapter: string | undefined, limitMs: number): Promise<ProviderCall>,
 *   hangup?(key: SessionKey, callId: string): Promise<void>,
 * }} ProviderPort
 * `connect` (relayed) gets the session's settings, for its adapter and its locked model. It and
 * `createCall` (observed) throw `ProviderRefused` for a known refusal;
 * anything else is an unknown outcome. `attach` attaches an observed call's side channel, and
 * throws `ProviderRefused` with the status when it is refused (404: the call ended); it waits
 * at most `limitMs`, the time left before the deadline, and throws past it. `hangup`
 * ends an observed call: closing its side channel doesn't (plan, T1).
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

const KEYS = ["state", "ticket", "settings", "connecting", "callId", "end", "closed", "hangup", JOURNAL_KEY];

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
   * @param {{
   *   store: Store, vault: VaultPort, main: MainPort, provider: ProviderPort, now?: () => number, log?: Logger,
   *   liveness?: Liveness, proof?: () => boolean, checkpointTimeoutMs?: number,
   *   turnOpen?: () => boolean, unfinished?: () => boolean, wait?: (ms: number) => Promise<void>,
   * }} parts
   * `proof`: whether a client message came since the start (crash table row 20), for a live checkpoint.
   * `turnOpen`: whether the provider is in the middle of an answer (the adapter's `turn`), or its usage
   * is still being written: the closing wait waits for both.
   * `unfinished`: whether the provider left an answer without its completion event: the end's "cut".
   * By default `turnOpen`.
   * `wait`: a timer, for the closing wait; tests give their own.
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
    /** @type {() => boolean} */
    this.proof = parts.proof ?? (() => false);
    this.checkpointTimeoutMs = parts.checkpointTimeoutMs ?? CHECKPOINT_TIMEOUT_MS;
    /** @type {import("./journal.js").Journal | null} The journal in memory, loaded from storage after a restart. */
    this.journal = null;
    /** @type {Promise<unknown> | null} A checkpoint in flight: one at a time. */
    this.checkpointing = null;
    /** @type {() => boolean} */
    this.turnOpen = parts.turnOpen ?? (() => false);
    /** @type {() => boolean} */
    this.unfinished = parts.unfinished ?? this.turnOpen;
    /** @type {(ms: number) => Promise<void>} */
    this.wait = parts.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    /**
     * @type {(() => void) | null} Ends the closing wait when the answer is done. Set only
     * during the wait: the end is waiting for the provider's answer, and usage still counts.
     */
    this.turnWaiter = null;
    /** The last journal write failed: usage this instance saw may be missing from storage (`endOnce`). */
    this.unwritten = false;
    /** Usage writes in flight (`recordUsage`): the end waits for all of them, bounded, before it judges what is cut. */
    this.writes = new Set();
    /** The end is reading and freezing the journal: usage that comes now is too late for it. */
    this.finalizing = false;
    /** The session's deadline, kept by `start` for the closing wait: no storage read on the end path. */
    this.deadline = Infinity;
    /**
     * The reconnect secret's hash, kept by `start`: a client that lost its link proves it is the
     * same one with the secret (plan 5.1). Only while this instance holds the provider's side: a
     * restart loses both, and then a reconnect is a new session.
     * @type {string | null}
     */
    this.reconnectHash = null;
    /** @type {SessionKey | null} The session's key, in memory only (plan 5.1): an observed call reattaches and hangs up with it. */
    this.key = null;
    /** @type {string | null} The session's mode, once this instance started it or attached its side channel. */
    this.mode = null;
    /**
     * Whether this instance started the observed call or held its side channel. A restarted
     * instance did neither: the side channel went with the old one, so the time since the
     * journal's last write is a gap (crash table row 22).
     */
    this.held = false;
    /** @type {Promise<void> | null} An observed call's side-channel attach in flight: one at a time. */
    this.attaching = null;
    /** When the side channel last attached. */
    this.attachedAt = 0;
    /**
     * Set by an observed start, cleared by the first attach attempt: only a first attempt that
     * succeeds books no time from before it, as no side channel existed yet (`attachOnce`).
     */
    this.firstAttach = false;
    /**
     * Set once an end has stored `ended`, and never cleared: an observed call's attach or journal
     * write that finishes after the end (when `ending` is null again) changes nothing.
     */
    this.over = false;
  }

  /**
   * The session's client lost its link, and may come back with its reconnect
   * secret: the session goes on without one (plan 5.2, "Heartbeats and
   * reconnects"). The heartbeat still ends it if nothing comes back within
   * 90 s. Only the session's owner can detach.
   * @param {Client} client
   */
  detach(client) {
    if (client !== this.owner || this.call === null || this.ending !== null) return false;
    this.owner = null;
    return true;
  }

  /**
   * Whether `secret` is this session's reconnect secret. Only while this
   * instance holds the provider's side: the hash goes with it. Whether the
   * session can still take a client back is the caller's check, and `reattach`'s.
   * @param {unknown} secret
   */
  async mayReattach(secret) {
    if (typeof secret !== "string" || secret === "" || this.reconnectHash === null) return false;
    const encoder = new TextEncoder();
    const stored = encoder.encode(this.reconnectHash);
    const given = encoder.encode(await hashOf(secret));
    // Both are 64 hex characters; the length check only guards the call, which needs equal sizes.
    // `timingSafeEqual` is the Workers runtime's own, missing from the standard types.
    const subtle = /** @type {SubtleCrypto & { timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean }} */ (crypto.subtle);
    return given.byteLength === stored.byteLength && subtle.timingSafeEqual(given, stored);
  }

  /**
   * A client came back with the reconnect secret: it owns the session now,
   * whether the old one is detached or still seen as open (a phone that moved
   * from Wi-Fi to mobile data). The caller checked `mayReattach`; an end that
   * began while the secret was hashed wins here.
   * @param {Client} client
   */
  reattach(client) {
    if (this.call === null || this.ending !== null) return false;
    this.owner = client;
    return true;
  }

  /** The provider finished an answer: a closing wait for it ends now. */
  turnDone() {
    this.turnWaiter?.();
  }

  /**
   * Waits for the provider's answer in progress to finish, so its usage is
   * counted before the provider is hung up: up to `CLOSE_DRAIN_MS`, and never
   * past the session's deadline, so the paid connection never outlives its
   * cap. It ends early when the answer is done or the provider hangs up.
   */
  async drainTurn() {
    if (!this.turnOpen()) return;
    const limit = Math.min(CLOSE_DRAIN_MS, this.deadline - this.now());
    if (limit <= 0) return;
    try {
      await new Promise((resolve) => {
        this.turnWaiter = () => resolve(undefined);
        void this.wait(limit).then(() => resolve(undefined));
      });
    } finally {
      this.turnWaiter = null;
    }
  }

  /**
   * Waits for the usage writes in flight (`writes`), and those they start, for at most
   * `END_WRITES_MS`: local storage only. Returns whether they all landed.
   */
  async settleWrites() {
    const until = this.now() + END_WRITES_MS;
    while (this.writes.size > 0) {
      const left = until - this.now();
      if (left <= 0) return false;
      const timedOut = await Promise.race([Promise.all([...this.writes]).then(() => false), this.wait(left).then(() => true)]);
      if (timedOut) return this.writes.size === 0;
    }
    return true;
  }

  /**
   * Starts the session for `client`, which brought `ticketText`. The relay's
   * entry has checked its signature and routed it to this object by its
   * session id; this checks the rest. Returns the reconnect secret, or a code
   * the client gets.
   *
   * An observed session (no client socket, ever) starts the same way, from
   * the app's `offer`: the provider creates the call, the call id is stored
   * with `active`, and only then is the provider's answer returned
   * (4.3 step 4). The caller attaches the side channel after (`attachSide`).
   * @param {string} ticketText
   * @param {import("./ticket.js").Ticket} ticket
   * @param {Client} [client]
   * @param {string} [offer] an observed session's offer
   * @returns {Promise<{ ok: true, reconnectSecret: string | null, call: ProviderCall | null, answer: string | null, deadline: number, adapter: string | undefined } | { ok: false, code: string }>}
   */
  async start(ticketText, ticket, client, offer) {
    // Also while an end is in flight: a start never runs into the middle of one.
    // An end in flight: this session can't start or be joined again, and the client needs a new one.
    if (this.ending !== null) return { ok: false, code: "session_ended" };
    if (this.starting) return { ok: false, code: "start_in_flight" };
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
     * @param {{ log?: string, status?: number, gap?: boolean }} details
     */
    const endStart = (reason, details) => {
      if (this.owner === client) this.owner = null;
      return this.end(reason, details);
    };
    try {
      const stored = await this.store.get(KEYS);
      const state = stored.get("state");
      if (state === "ended") return fail("session_ended");
      if (state === "active") {
        // A restarted instance holds no provider socket: the session is gone. It is ended now, as
        // the alarm would at its next tick, so its slot frees up for the client's new session;
        // the accounting finishes in the background (crash table row 22).
        if (this.lost(/** @type {Settings | undefined} */ (stored.get("settings")))) {
          // Never unhandled: the session object waits for it too (`begin`), after answering.
          endStart("error", { log: "relay_provider_lost", gap: true }).catch(() => undefined);
          return fail("session_ended");
        }
        return fail("session_active");
      }
      // A restart in `starting`: `open` is done. A retry with the same ticket goes on (row 9),
      // unless "connecting" was recorded: then the outcome is unknown, and it never connects again (rows 10, 11).
      const resumed = state === "starting";
      if (resumed && stored.get("connecting") === true) {
        await endStart("error", { log: "relay_start_outcome_unknown" });
        return fail("session_ended");
      }
      if (this.now() >= ticket.exp) return fail("ticket_expired");
      // How long each step of the start took, logged once it succeeded (9c, T10).
      const startedAt = this.now();

      /** @type {SessionKey} */
      let key;
      try {
        key = await this.vault.sessionKey(ticketText, { restart: false });
      } catch (error) {
        // Nothing stored, nothing started: the client may retry with the same ticket (row 4).
        this.log({ level: "warn", message: "relay_vault_refused", session: ticket.sid, code: codeOf(error) });
        return fail("credential_unavailable");
      }

      const vaultAt = this.now();
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

      const openAt = this.now();
      // An adapter this relay doesn't know (a newer gateway, this relay not deployed yet): the session
      // would run unread, its model unlocked and its usage uncounted. It ends before the provider is called.
      if (settings.adapter !== undefined && !knownAdapter(settings.adapter)) {
        await endStart("error", { log: "relay_adapter_unknown" });
        return fail("adapter_unknown");
      }
      // The waits above may have taken the ticket past its time, or the client may have gone.
      if (!(await this.mayGoOn(client, ticket))) return fail(await this.stop(client, ticket));
      await this.store.put({ connecting: true }, null);
      const connectFrom = this.now();
      // Known before the provider is called, so an end that comes in the window below still
      // caps its closing wait by the deadline.
      const deadline = deadlineOf(ticket);
      this.deadline = deadline;
      const observed = ticket.mode === "observed";
      /** @type {{ callId: string, answer: string } | null} An observed call: its id and the provider's answer. */
      let created = null;
      try {
        if (observed) {
          // No socket to keep: if the start stops after this, the app never gets the answer, and the
          // provider ends the call by itself (crash table row 11).
          if (this.provider.createCall === undefined) throw new ProviderRefused(501);
          created = await this.provider.createCall(key, offer ?? "");
        } else {
          // Kept at once, so whatever happens next can hang it up.
          ownCall = await this.provider.connect(key, settings);
          this.call = ownCall;
        }
      } catch (error) {
        if (error instanceof ProviderRefused) {
          await endStart("error", { log: "relay_provider_refused", status: error.status });
        } else {
          // Sent, and no answer came back: never retried (4.3 step 4; row 10).
          await endStart("error", { log: "relay_start_outcome_unknown" });
        }
        return fail("provider_unavailable");
      }
      const connectedAt = this.now();
      const call = this.call;
      const callId = created?.callId ?? call?.callId ?? null;
      // Only a relayed session has a client link that can drop and come back (plan 5.1).
      const reconnectSecret = observed ? null : newSecret();
      const reconnect = reconnectSecret === null ? null : await hashOf(reconnectSecret);
      // A slow handshake: the alarm may have ended the session, the client may have gone, or
      // the time run out. Then the provider's side is hung up, and an ended session stays ended.
      // Nothing waits between this check and the `active` write.
      if (!(await this.mayGoOn(client, ticket))) return fail(await this.stop(client, ticket));
      // The alarm's first tick: from then on it ticks every `TICK_MS` (plan section 5), so a
      // restarted object that lost its provider socket ends soon (row 13).
      // The journal starts when the provider connected: the session's connection time counts from then (Sol, #274 round 1).
      // A provider that bills from the first activity (xAI): the time until then is free.
      const journal = newJournal(connectedAt, { idle: adapterFor(settings.adapter).clock === "first_activity" });
      // An observed session has no side channel yet: until its first attach, no time is
      // connection time (`attachOnce`).
      if (observed) markDetached(journal, journal.from);
      // An observed call's id is stored here, before its answer goes back to the app (4.3 step 4).
      await this.store.put({ state: "active", callId, reconnect, [JOURNAL_KEY]: journal }, Math.min(deadline, this.now() + TICK_MS));
      this.journal = journal;
      this.reconnectHash = reconnect;
      this.mode = ticket.mode;
      if (observed) {
        this.key = key;
        this.held = true;
        this.firstAttach = true;
      }
      // A hang-up during that write has ended the session (`clientGone`): nothing waits after this check.
      if (this.owner !== client) return fail("client_closed");
      // A write held past the deadline: the session's time is over before it began.
      if (this.now() >= deadline) {
        await endStart("time_cap", {});
        return fail("session_ended");
      }
      const now = this.now();
      this.log({
        level: "info",
        message: "relay_start_timing",
        session: ticket.sid,
        vaultMs: vaultAt - startedAt,
        openMs: openAt - vaultAt,
        connectMs: connectedAt - connectFrom,
        totalMs: now - startedAt,
      });
      return { ok: true, reconnectSecret, call, answer: created?.answer ?? null, deadline, adapter: settings.adapter };
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
    // A session with its provider call: the end starts now, before any wait, so a reconnect that
    // comes during a storage read can't join a session that is about to end.
    if (this.call !== null) return this.end("client_closed");
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
    // A closing wait ends now too.
    this.turnWaiter?.();
    await this.end("provider_closed");
  }

  /**
   * An observed call's side channel closed. That says nothing about the call
   * itself (it closes with 1006 whatever the reason, T18), so the session goes
   * on: the time without it is a gap, and it is attached again at once, with
   * the alarm as the backup (plan section 5; crash table row 23). One that
   * lived less than `SIDE_CHANNEL_MIN_LIFE_MS` waits for the next tick.
   * @param {ProviderCall} call
   */
  async sideGone(call) {
    if (call !== this.call) return;
    this.call = null;
    // A closing wait ends now: its answer can't arrive any more.
    this.turnWaiter?.();
    if (this.ending !== null) return;
    // An attach still finishing (its journal write) is let finish first, so this one really runs.
    await this.attaching;
    await this.noteDetached();
    // A side channel that closed soon after it attached is not attached again at once, or a provider
    // that accepts and drops it would get attaches with no pause: the next tick tries again.
    if (this.now() - this.attachedAt >= SIDE_CHANNEL_MIN_LIFE_MS) await this.attachSide();
  }

  /** The side channel is down from now: the time is a gap until it is back (`markDetached`). */
  async noteDetached() {
    const journal = await this.loadJournal();
    if (journal === null || journal.detachedFrom !== undefined) return;
    markDetached(journal, this.now());
    await this.writeJournal(journal);
  }

  /** The journal's own small write, logged when it fails: the next write carries the change. @param {import("./journal.js").Journal} journal */
  async writeJournal(journal) {
    // The session ended: its journal is the end's, and may be cleaned up already.
    if (this.over) return;
    try {
      await this.store.putJournal(journal);
      // Each write holds the whole journal: one that lands covers any that failed before it.
      this.unwritten = false;
    } catch {
      this.unwritten = true;
      this.log({ level: "warn", message: "relay_journal_write_failed", session: this.sessionId });
    }
  }

  /**
   * Attaches an observed call's side channel (plan section 5): after the
   * start, at once when it closes, and on each tick while it is down, also in
   * a restarted instance, with the key from the vault and no call to the main
   * Worker (crash table rows 22–24). One attach at a time.
   * - It attaches: usage flows again, and the time it was down stays a gap.
   * - 404: the call ended. The session ends with `provider_closed`.
   * - Anything else (503, the vault or the network failing): the call is kept
   *   (owner, 2026-11-18), the time is a gap, and the next tick tries again.
   *   The session then ends only on a 404, an explicit stop or the cap.
   */
  attachSide() {
    if (this.attaching !== null) return this.attaching;
    // Never rejects: a storage failure here is logged, and the next tick tries again.
    const running = this.attachOnce()
      .catch(() => this.log({ level: "warn", message: "relay_side_channel_attach_failed", session: this.sessionId }))
      .finally(() => {
        if (this.attaching === running) this.attaching = null;
      });
    this.attaching = running;
    return running;
  }

  async attachOnce() {
    if (this.ending !== null || this.over || this.call !== null) return;
    const stored = await this.store.get(["state", "ticket", "callId", "settings"]);
    const ticket = stored.get("ticket");
    const callId = stored.get("callId");
    const settings = /** @type {Settings | undefined} */ (stored.get("settings"));
    if (stored.get("state") !== "active" || settings?.mode !== "observed" || typeof ticket !== "string" || typeof callId !== "string") return;
    this.mode = "observed";
    this.sessionId ||= this.sessionIdOf(stored);
    // Kept in memory after a restart too, so the closing wait never goes past it.
    this.deadline = settings.deadline;
    // At the deadline nothing is attached: the session ends, and the call is hung up.
    if (this.now() >= settings.deadline) return this.end("time_cap");
    // A restarted instance: the side channel went with the old one, and so did any usage since the
    // journal's last write. That time is a gap (crash table row 22).
    await this.loadJournal();
    const first = this.firstAttach;
    this.firstAttach = false;
    let key = this.key;
    if (key === null) {
      try {
        // Never long, and never past the deadline: a stalled vault can't hold the tick, or the session past its cap.
        key = await this.restartKey(ticket, Math.max(0, Math.min(VAULT_KEY_WAIT_MS, settings.deadline - this.now())));
      } catch (error) {
        this.log({ level: "warn", message: "relay_vault_refused", session: this.sessionId, code: codeOf(error) });
        return this.noteDetached();
      }
      if (key !== null) this.key = key;
      if (key === null) {
        this.log({ level: "warn", message: "relay_vault_refused", session: this.sessionId, code: "timeout" });
        return this.noteDetached();
      }
    }
    if (this.provider.attach === undefined) return this.noteDetached();
    /** @type {ProviderCall} */
    let call;
    try {
      // Never waits past the deadline: a slow attach can't keep the call past its cap.
      call = await this.provider.attach(key, callId, settings.adapter, Math.max(0, settings.deadline - this.now()));
    } catch (error) {
      if (error instanceof ProviderRefused && error.status === 404) return this.end("provider_closed");
      this.log({ level: "warn", message: "relay_side_channel_unavailable", session: this.sessionId, ...(error instanceof ProviderRefused ? { status: error.status } : {}) });
      return this.noteDetached();
    }
    // The session ended meanwhile, or the attach came past the deadline: this side channel is let go,
    // and the alarm, armed at the deadline, ends the session.
    if (this.ending !== null || this.over || this.now() >= settings.deadline) {
      call.close?.(1000, "session ended");
      return;
    }
    this.call = call;
    this.held = true;
    this.attachedAt = this.now();
    const journal = await this.loadJournal();
    if (journal !== null) {
      const now = this.now();
      // The first attach attempt of the call this instance made, and it succeeded: the time before is
      // neither connection time nor a gap, as no side channel existed yet. Any other attach ends a
      // gap (row 23).
      if (first) {
        journal.from = now;
        delete journal.detachedFrom;
      } else markAttached(journal, now);
      // The restart rule's gap runs from `savedAt`: moved here, so a later restart never counts it again.
      journal.savedAt = now;
      await this.writeJournal(journal);
    }
    this.log({ level: "info", message: "relay_side_channel_attached", session: this.sessionId });
  }

  /**
   * The session's key from the vault, as for a restart (8j), or null when the
   * vault has not answered within `limitMs`: the caller goes on without it.
   * @param {string} ticket
   * @param {number} limitMs
   * @returns {Promise<SessionKey | null>}
   */
  restartKey(ticket, limitMs) {
    return Promise.race([this.vault.sessionKey(ticket, { restart: true }), this.wait(limitMs).then(() => null)]);
  }

  /**
   * Hangs up an ended observed call: one attempt now, and one on each wakeup
   * while it is owed (crash table rows 23–25, 28), with the key in memory or
   * from the vault, until the session's seal expires. The slices and `close`
   * never wait for it. Returns whether no hang-up is owed any more.
   */
  async hangUp() {
    const stored = await this.store.get(["hangup", "ticket", "callId"]);
    const ticket = stored.get("ticket");
    const callId = stored.get("callId");
    if (stored.get("hangup") !== true || typeof ticket !== "string" || typeof callId !== "string") return true;
    // Past the seal's expiry the key is never used again, not even one in memory (crash table row 28):
    // the call runs on at the provider to its own limit, logged at `error`.
    if (this.now() >= sealExpiry(ticket)) {
      this.log({ level: "error", message: "relay_hangup_given_up", session: this.sessionIdOf(stored) });
      await this.store.put({ hangup: false }, null);
      return true;
    }
    try {
      // Bounded too, so a stalled vault never holds the end: the next wakeup tries again.
      this.key ??= await this.restartKey(ticket, VAULT_KEY_WAIT_MS);
      if (this.key === null) throw new Error("vault_timeout");
      if (this.provider.hangup === undefined) throw new Error("no hang-up");
      await this.provider.hangup(this.key, callId);
    } catch (error) {
      this.log({ level: "warn", message: "relay_hangup_failed", session: this.sessionIdOf(stored), ...(error instanceof ProviderRefused ? { status: error.status } : { code: codeOf(error) }) });
      return false;
    }
    await this.store.put({ hangup: false }, null);
    return true;
  }

  /** Whether `client` ran the last start that got past the running-session check: its failure may end the session. @param {Client} client */
  startedBy(client) {
    return this.lastStarter === client;
  }

  /**
   * Ends the session: closes both sides with the reason, stores the end and
   * the final slice in one write, then delivers the unsent slices and sends
   * `close`. The alarm retries both until they are done, then cleans up. One
   * end at a time: a caller that comes while one is in flight waits for it.
   * @param {string} reason
   * @param {{ log?: string, status?: number, gap?: boolean }} [details]
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
        // An end that found nothing to end, or failed before `over`, leaves no session behind it: a
        // retry on this instance must record its usage (Sol, Gemini Neon, #270 round 6).
        this.finalizing = false;
      }
    });
    this.ending = ending;
    return ending;
  }

  /**
   * @param {string} reason
   * @param {{ log?: string, status?: number, gap?: boolean }} details
   * `gap`: the instance that ran the session is gone, so the time since the journal's last
   * write is an "unknown cost" gap, not connection time (crash table row 14).
   */
  async endOnce(reason, details) {
    const owner = this.owner;
    this.owner = null;
    // The client is told at once, with the reason. A client whose start is still in flight is
    // told by that start, with its code (`4000`), when it finds the session ended: never a bare
    // `1000 "error"` from here.
    if (!this.starting) owner?.close(CLIENT_END_CODES[reason] ?? 1000, reason);
    // An answer in progress is let finish, so its usage counts (plan 5.1). Not when the provider
    // hung up itself, not at the time cap, and not for a start that never got its call.
    const hadCall = this.call !== null;
    if (hadCall && reason !== "provider_closed" && reason !== "time_cap") await this.drainTurn();
    const call = this.call;
    this.call = null;
    this.reconnectHash = null;
    // The session's time ends at the hang-up, in the same tick as a provider's own hang-up or
    // the end of the wait: the storage reads after it are not connection time (Sol rounds 2, 3).
    const endedAt = this.now();
    // Hung up first, so no new frame comes; then the usage writes already in flight land, bounded, so a
    // write that never settles never holds the end (Sol, Gemini Neon, #270 round 5).
    call?.close?.(1000, "session ended");
    const written = await this.settleWrites();
    this.finalizing = true;
    // An answer the provider never finished was cut off: its usage is missing. Also when an observed
    // call's side channel dropped during the wait: the answer never finished where the relay could see
    // it. A finished answer whose write ran past the limit is not cut: it is partial below (`written`).
    const cut = hadCall && this.unfinished();
    // An answer this end cuts, for a provider that never reports a cut answer's usage (Gemini, OpenAI): estimated.
    const estimate = call?.estimate?.() ?? null;
    const stored = await this.store.get(KEYS);
    if (stored.get("state") === "ended" || typeof stored.get("ticket") !== "string") return;
    if (details.log !== undefined) {
      this.log({ level: reason === "error" ? "error" : "info", message: details.log, session: this.sessionIdOf(stored), ...(details.status === undefined ? {} : { status: details.status }) });
    }
    // The rest of the usage is frozen into the final slice, in the same write as the end (rows 25, 26).
    const settings = /** @type {Settings | undefined} */ (stored.get("settings"));
    const journal = this.restartGap(readJournal(stored.get(JOURNAL_KEY)), settings);
    // A journal write that failed must not lose what this instance saw: xAI's audio total, the clock's start,
    // and the open usage's counts when both journals agree where it starts (Sol, #270 round 4).
    let carried = false;
    if (journal !== null && this.journal !== null && this.journal !== journal) {
      carryTotals(journal, this.journal);
      carried = carryOpen(journal, this.journal);
    }
    // Never past the deadline: an instance that wakes late bills nothing after the cap.
    const deadline = settings?.deadline;
    const sliceEnd = Math.min(endedAt, deadline ?? Infinity);
    if (journal !== null && cut) {
      // The cut answer's usage is unknown: the final slice is booked with a gap, so it is
      // `partial`, keeping the cost that is known (plan 4.2).
      journal.droppedFrom ??= sliceEnd;
      this.log({ level: "warn", message: "relay_answer_cut", session: this.sessionIdOf(stored), reason });
    }
    // The last journal write failed, so usage this instance saw may be missing from what storage holds:
    // the final slice is partial, never complete without it (Sol, #270 round 3).
    if (journal !== null && this.unwritten && !carried) journal.droppedFrom ??= sliceEnd;
    // A usage write still in flight at the wait's limit: its usage may be missing, so the slice is partial.
    if (journal !== null && !written) journal.droppedFrom ??= sliceEnd;
    if (journal !== null && estimate !== null) addUsage(journal, estimate, "per_turn", sliceEnd);
    if (journal !== null) freeze(journal, sliceEnd, details.gap === true ? { gapFrom: journal.savedAt } : {});
    this.journal = journal;
    /** @type {Record<string, unknown>} */
    const entries = { state: "ended", end: { reason, at: endedAt, finalSlice: finalSliceOf(journal) } };
    if (journal !== null) entries[JOURNAL_KEY] = journal;
    // An observed call goes on at the provider until it is hung up, except when it ended there
    // (`provider_closed`). The hang-up is owed in the same write as the end (rows 23, 25).
    const owed = settings?.mode === "observed" && typeof stored.get("callId") === "string" && reason !== "provider_closed";
    if (owed) entries.hangup = true;
    await this.store.put(entries, this.now() + CLOSE_RETRY_EVERY_MS);
    // From here the session is over for good; until here, `ending` stood for it.
    this.over = true;
    await Promise.all([this.flushEnded(), owed ? this.hangUp() : null]);
  }

  /**
   * The journal, from memory or, after a restart, from storage. Null when the
   * session has none (it never became active, or its storage was cleaned up).
   * @returns {Promise<import("./journal.js").Journal | null>}
   */
  async loadJournal() {
    if (this.journal === null) {
      const stored = await this.store.get([JOURNAL_KEY, "settings"]);
      this.journal = this.restartGap(readJournal(stored.get(JOURNAL_KEY)), /** @type {Settings | undefined} */ (stored.get("settings")));
    }
    return this.journal;
  }

  /**
   * An observed session's journal as a restarted instance finds it: the side
   * channel went with the old instance, so the time since the journal's last
   * write is a gap until it is attached again (crash table row 22).
   * @param {import("./journal.js").Journal | null} journal
   * @param {Settings | undefined} settings
   */
  restartGap(journal, settings) {
    if (journal !== null && settings?.mode === "observed" && !this.held) markDetached(journal, journal.savedAt);
    return journal;
  }

  /**
   * One usage event, after its frame was forwarded: added to the journal in
   * one small write (plan 5.2 rule 3). A repeated event changes nothing. A
   * write that fails is logged: the event may be lost, and the gap rules cover
   * a restart.
   * `written` runs once the write is done (or nothing was to be written), before anything awaiting
   * the write goes on: the end waits for every write in flight (`writes`) before it judges what is cut.
   * @param {import("./journal.js").UsageEvent} event
   * @param {"per_turn" | "running_total"} shape
   * @param {() => void} [written]
   * @returns {Promise<void>}
   */
  recordUsage(event, shape, written) {
    const run = this.recordUsageNow(event, shape).finally(() => written?.());
    const tracked = run.catch(() => undefined);
    this.writes.add(tracked);
    void tracked.then(() => this.writes.delete(tracked));
    return run;
  }

  /**
   * `recordUsage`'s work.
   * @param {import("./journal.js").UsageEvent} event
   * @param {"per_turn" | "running_total"} shape
   */
  async recordUsageNow(event, shape) {
    // Usage that arrives while the call is open, or while the end waits for its writes, always counts.
    if (this.over || this.finalizing || (this.call === null && this.ending === null)) return;
    const journal = await this.loadJournal();
    const now = this.now();
    if (journal === null) return;
    // A provider's own total of the audio it bills (xAI): kept, since a slice bills the larger of it
    // and the relay's clock (plan 5.2 rule 3). Written only when it grows.
    if (event.audioSeconds !== undefined && markAudio(journal, Math.round(event.audioSeconds * 1000))) {
      journal.savedAt = now;
      await this.writeJournal(journal);
    }
    // Keyterms Deepgram confirmed mid-stream: every later slice says so. Written once.
    if (event.keyterms === true && journal.keyterms !== true) {
      journal.keyterms = true;
      journal.savedAt = now;
      await this.writeJournal(journal);
    }
    if (Object.keys(event.measures).length === 0) return;
    if (!addUsage(journal, event, shape, now)) return;
    // An observed session is real once usage came on its side channel (crash table row 20). Sticky.
    if (this.mode === "observed") journal.connected = true;
    journal.savedAt = now;
    await this.writeJournal(journal);
  }

  /** Whether the session's clock waits for its first activity (`activity`). No storage read: for the audio path. */
  get idle() {
    return this.journal?.idle === true;
  }

  /**
   * The session's first activity, after its frame went to the provider: the
   * provider's clock starts (xAI, plan 5.2 rule 3), and the time is stored in
   * one small write, so a restart keeps it. Only the first call writes.
   */
  async activity() {
    if (!this.idle || this.call === null || this.over || this.ending !== null) return;
    const journal = await this.loadJournal();
    const now = this.now();
    if (journal === null || !markActive(journal, now)) return;
    journal.savedAt = now;
    await this.writeJournal(journal);
  }

  /**
   * One text message from the client, after it went to the provider: counted
   * as its own measure (xAI bills each one), in one small write.
   */
  countText() {
    return this.count({ text_messages: 1 });
  }

  /**
   * Counts the provider bills from a client frame, after it went to the provider (xAI's text messages,
   * ElevenLabs' characters), in one small write. Tracked as a usage write is (`writes`): an end waits for
   * it, bounded, so the client's last text before it hangs up is in the final slice.
   * @param {Record<string, number>} counts
   * @returns {Promise<void>}
   */
  count(counts) {
    const run = this.countNow(counts);
    const tracked = run.catch(() => undefined);
    this.writes.add(tracked);
    void tracked.then(() => this.writes.delete(tracked));
    return run;
  }

  /** `count`'s work. @param {Record<string, number>} counts */
  async countNow(counts) {
    if (this.call === null || this.over || this.ending !== null) return;
    const journal = await this.loadJournal();
    const now = this.now();
    if (journal === null) return;
    for (const [name, value] of Object.entries(counts)) if (Number.isSafeInteger(value) && value > 0) countMeasure(journal, name, value);
    journal.savedAt = now;
    await this.writeJournal(journal);
  }

  /**
   * Sends one checkpoint, with its timeout: a late or failed answer is null,
   * and the session goes on (plan 5.1).
   * @param {string} ticket
   * @param {CheckpointCall} input
   * @returns {Promise<CheckpointReply | null>}
   */
  async sendCheckpoint(ticket, input) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), this.checkpointTimeoutMs);
    });
    try {
      const reply = await Promise.race([this.main.checkpoint(ticket, input), late]);
      if (reply === null) this.log({ level: "warn", message: "relay_checkpoint_late", session: this.sessionId });
      return /** @type {CheckpointReply | null} */ (reply);
    } catch (error) {
      this.log({ level: "warn", message: "relay_checkpoint_failed", session: this.sessionId, code: codeOf(error) });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A live checkpoint (crash table rows 16–20). It sends the unconfirmed slice
   * again if there is one; else it freezes the open usage into the next slice
   * and stores it before sending, or sends an empty checkpoint when there is
   * nothing. It books, and answers continue or stop. An explicit stop ends the
   * session even when the slice was not written; the slice then goes in the
   * final delivery. Forwarding never waits for it.
   */
  checkpoint() {
    if (this.checkpointing !== null) return this.checkpointing;
    const running = this.checkpointOnce().finally(() => {
      if (this.checkpointing === running) this.checkpointing = null;
    });
    this.checkpointing = running;
    return running;
  }

  async checkpointOnce() {
    if (this.ending !== null) return;
    const stored = await this.store.get(["state", "ticket", "callId", "settings"]);
    const ticket = stored.get("ticket");
    // No checkpoint before `active`, and none from a session that has ended (crash table, "Checkpoints").
    if (stored.get("state") !== "active" || typeof ticket !== "string") return;
    const journal = await this.loadJournal();
    if (journal === null) return;
    const now = this.now();
    // The proof is sticky: once a client message came, every later checkpoint carries it (row 20).
    if (!journal.connected && this.proof()) journal.connected = true;
    let slice = journal.unsent[0] ?? null;
    if (slice === null) {
      // The end owns the journal once it starts: nothing here writes over it.
      if (this.ending !== null || this.journal !== journal) return;
      // Never past the deadline: a checkpoint that crosses it while waiting bills nothing after the cap.
      const deadline = /** @type {Settings | undefined} */ (stored.get("settings"))?.deadline;
      slice = freeze(journal, deadline === undefined ? now : Math.min(now, deadline));
      // The slice's boundary is stored before it is sent: usage after it goes to the next one (row 16).
      if (slice !== null) {
        journal.savedAt = now;
        await this.store.putJournal(journal);
      }
    }
    const reply = await this.sendCheckpoint(ticket, {
      slice,
      connected: journal.connected,
      accounting: false,
      providerCallId: typeof stored.get("callId") === "string" ? /** @type {string} */ (stored.get("callId")) : null,
      relayVersion: RELAY_CONTRACT_VERSION,
    });
    // An explicit stop comes first, whatever was written: the end stores the final journal, with
    // this slice still in it when it is unconfirmed, for the final delivery (row 16).
    if (reply !== null && reply.decision === "stop") {
      const reason = stopReason(reply.reasons);
      await this.end(reason, reply.reasons[0] === "ended" ? { log: "relay_session_ended_by_ledger" } : {});
      return;
    }
    // A reply that comes after the end began is not written: the end's journal is newer (Sol round 1).
    if (this.ending !== null || this.journal !== journal) return;
    journal.lastCheckpointAt = now;
    if (reply !== null && reply.written && slice !== null) confirm(journal, slice.seq);
    // A failed write leaves the slice unconfirmed in memory, and it is sent again; a restart sends it from storage.
    await this.writeJournal(journal);
  }

  /**
   * Whether a live checkpoint is due on this tick: a slice waits to be sent
   * again, or the interval has passed since the last one.
   * @param {number} now
   */
  async checkpointDue(now) {
    const journal = await this.loadJournal();
    if (journal === null) return false;
    const stored = await this.store.get(["settings"]);
    const interval = /** @type {Settings | undefined} */ (stored.get("settings"))?.checkpointIntervalMs ?? 60_000;
    return journal.unsent.length > 0 || now - journal.lastCheckpointAt >= interval;
  }

  /**
   * After the end: delivers the unsent slices in order, as accounting only
   * (they ask no limiter, and "ended" is no news), then sends `close`. A slice
   * that is not written stops the delivery until the next try; `close` is sent
   * either way, and the settlement barrier waits for the final slice (S6).
   * Returns whether both are done.
   * @returns {Promise<boolean>}
   */
  async flushEnded() {
    const stored = await this.store.get(KEYS);
    const ticket = stored.get("ticket");
    if (typeof ticket !== "string") return true;
    const journal = readJournal(stored.get(JOURNAL_KEY));
    if (journal !== null) {
      while (journal.unsent.length > 0) {
        const slice = /** @type {import("./journal.js").Slice} */ (journal.unsent[0]);
        const reply = await this.sendCheckpoint(ticket, {
          slice,
          connected: journal.connected,
          accounting: true,
          providerCallId: typeof stored.get("callId") === "string" ? /** @type {string} */ (stored.get("callId")) : null,
          relayVersion: RELAY_CONTRACT_VERSION,
        });
        if (reply === null || !reply.written) break;
        confirm(journal, slice.seq);
        try {
          await this.store.putJournal(journal);
        } catch {
          // Booked all the same: a later try sends it again, and the main Worker books it once.
          this.log({ level: "warn", message: "relay_journal_write_failed", session: this.sessionIdOf(stored) });
        }
      }
      this.journal = journal;
    }
    const closed = await this.sendClose(journal !== null && journal.unsent.length > 0);
    return closed && (journal === null || journal.unsent.length === 0);
  }

  /** The session id, for a log line. @param {Map<string, unknown>} stored */
  sessionIdOf(stored) {
    const ticket = stored.get("ticket");
    return (typeof ticket === "string" ? parseTicket(ticket)?.payload.sid : undefined) ?? this.sessionId;
  }

  /**
   * Sends `close`; on success, the next alarm cleans up, unless slices still
   * wait to be delivered (`slicesLeft`): the alarm then keeps retrying them.
   * @param {boolean} [slicesLeft]
   * @returns {Promise<boolean>}
   */
  async sendClose(slicesLeft = false) {
    const stored = await this.store.get(KEYS);
    const ticket = stored.get("ticket");
    const end = /** @type {{ reason: string, at: number, finalSlice: number } | undefined} */ (stored.get("end"));
    if (typeof ticket !== "string" || end === undefined) return true;
    if (stored.get("closed") === true) {
      // A retry delivered the last slice after `close` was already sent: clean up once the ticket expires.
      if (!slicesLeft) await this.store.put({}, this.cleanupAt(ticket));
      return true;
    }
    try {
      await this.main.close(ticket, {
        finalSlice: end.finalSlice,
        endReason: end.reason,
        endedAt: end.at,
        providerCallId: typeof stored.get("callId") === "string" ? /** @type {string} */ (stored.get("callId")) : null,
        relayVersion: RELAY_CONTRACT_VERSION,
      });
    } catch (error) {
      this.log({ level: "warn", message: "relay_close_failed", session: this.sessionIdOf(stored), code: codeOf(error) });
      return false;
    }
    await this.store.put({ closed: true }, slicesLeft ? null : this.cleanupAt(ticket));
    return true;
  }

  /** When storage may go: once the ticket has expired, so the `ended` marker refuses it until then. @param {string} ticketText */
  cleanupAt(ticketText) {
    return Math.max(this.now(), ticketExpiry(ticketText));
  }

  /**
   * Whether an `active` session lost its provider socket with its instance: a relayed one did
   * (rows 13, 14, 22). An observed session reattaches instead (part 3).
   * @param {Settings | undefined} settings
   */
  lost(settings) {
    return this.call === null && settings?.mode !== "observed";
  }

  /** The alarm: the one place a session moves on by time (crash table rows 9–13, 25, 28). */
  async alarm() {
    // An end still in progress (its close may be waiting on the main Worker) finishes first, and
    // storage is read after it: a second close, or a cleanup under a late reply, never runs.
    if (this.ending !== null) await this.ending.catch(() => undefined);
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
      // A relayed session whose instance is gone lost its provider socket too: the time since the
      // journal's last write is a gap even at the cap (rows 13 and 14).
      const lost = this.lost(settings);
      if (now >= deadline) return this.end("time_cap", lost ? { log: "relay_provider_lost", gap: true } : {});
      // The next tick is armed before anything that can fail (crash table row 29): a tick that
      // throws still leaves the session its next one.
      await this.store.put({}, Math.min(deadline, now + TICK_MS));
      // A relayed session lost its provider socket with its instance: it ends, and the time since
      // its journal's last write is a gap (rows 13 and 14, relayed). An observed session reattaches
      // instead (part 3): until then it waits for its deadline.
      if (lost) return this.end("error", { log: "relay_provider_lost", gap: true });
      // An observed call whose side channel is down (a close, a 503, a restarted instance): one
      // attach per tick. The tick's checkpoint runs whatever it found, so an explicit stop still
      // reaches a detached call (row 23); a 404 has ended the session, and the checkpoint is skipped.
      const detached = settings?.mode === "observed" && this.call === null;
      if (detached) await this.attachSide();
      // The vault or the attach may have taken the tick to the cap: it ends there, before any checkpoint.
      if (detached && this.now() >= deadline) return this.end("time_cap");
      // The live session's own checks: a silent client, a client too far behind.
      const reason = this.liveness(now);
      if (reason !== null) return this.end(reason);
      // A tick that found the side channel down always asks the gateway, so a stop reaches it (row 23).
      if (detached || (await this.checkpointDue(now))) await this.checkpoint();
      return;
    }
    // Ended: deliver the slices and `close` for a while; then give up, with the slices logged; then
    // clean up once the ticket has expired.
    const end = /** @type {{ at: number } | undefined} */ (stored.get("end"));
    const journal = readJournal(stored.get(JOURNAL_KEY));
    const owed = stored.get("hangup") === true;
    const accounting = stored.get("closed") !== true || (journal !== null && journal.unsent.length > 0);
    // Two retries with their own limits: the slices and `close` for `CLOSE_RETRY_MS`, an owed
    // hang-up until the seal expires (`hangUp`). Storage stays while either is owed.
    const [flushed, hungUp] = await Promise.all([accounting ? this.flushEnded() : true, owed ? this.hangUp() : true]);
    if (!flushed) {
      if (now - (end?.at ?? now) < CLOSE_RETRY_MS) return this.store.put({}, now + CLOSE_RETRY_EVERY_MS);
      // Given up: the slices are logged at `error`, the one miscount the plan accepts (4.2; row 25).
      const left = this.journal?.unsent ?? journal?.unsent ?? [];
      this.log({
        level: "error",
        message: "relay_close_given_up",
        session: this.sessionIdOf(stored),
        slices: left.map((slice) => ({
          seq: slice.seq,
          measures: slice.measures,
          sessionMs: slice.sessionMs,
          gapMs: slice.gapMs,
          ...(slice.billedMs === undefined ? {} : { billedMs: slice.billedMs }),
          ...(slice.transcriptions === undefined ? {} : { transcriptions: slice.transcriptions }),
        })),
      });
      /** @type {Record<string, unknown>} */
      const entries = { closed: true };
      if (journal !== null) entries[JOURNAL_KEY] = { ...journal, unsent: [] };
      await this.store.put(entries, hungUp ? this.cleanupAt(ticketText) : now + CLOSE_RETRY_EVERY_MS);
      return;
    }
    if (!hungUp) return this.store.put({}, now + CLOSE_RETRY_EVERY_MS);
    // Just delivered: `close` set the cleanup alarm.
    if (accounting) return;
    if (now >= ticketExpiry(ticketText)) return this.store.deleteAll();
    return this.store.put({}, ticketExpiry(ticketText));
  }
}

/**
 * When a session's sealed key expires: the ticket's expiry, its cap and a grace, as the gateway
 * seals it (`SEAL_GRACE_MS` in `src/relay/tickets.ts`; a test keeps them the same). The vault
 * refuses the seal after it.
 */
export const SEAL_GRACE_MS = 5 * 60_000;

/** @param {string} ticketText */
function sealExpiry(ticketText) {
  const ticket = parseTicket(ticketText)?.payload;
  return ticket === undefined ? 0 : ticket.exp + ticket.cap + SEAL_GRACE_MS;
}

/** A stored ticket's expiry. It was checked before it was stored. @param {string} ticketText */
function ticketExpiry(ticketText) {
  return parseTicket(ticketText)?.payload.exp ?? 0;
}

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
 *    the alarm at the deadline.
 * The first checkpoint comes with the journal (step 9a part 2).
 *
 * The end: one write stores `ended`, the reason and the final slice, then
 * `close` is sent; the alarm retries it. Storage is deleted once `close` is
 * confirmed (or given up on) and the ticket has expired; until then the
 * `ended` marker refuses the ticket again (row 28).
 */
import { deadlineOf, parseTicket } from "./ticket.js";

/** How long an ended session keeps retrying `close` before it gives up and logs (crash table row 25). */
export const CLOSE_RETRY_MS = 30 * 60_000;
/** How soon the alarm tries `close` again. */
export const CLOSE_RETRY_EVERY_MS = 30_000;

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
 * @typedef {{ callId: string | null }} ProviderCall
 * @typedef {{ connect(key: SessionKey): Promise<ProviderCall> }} ProviderPort
 * `connect` throws `ProviderRefused` for a known refusal; anything else is an unknown outcome.
 * @typedef {(event: Record<string, unknown>) => void} Logger
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
   * @param {{ name: string, store: Store, vault: VaultPort, main: MainPort, provider: ProviderPort, now?: () => number, log?: Logger }} parts
   */
  constructor(parts) {
    this.name = parts.name;
    this.store = parts.store;
    this.vault = parts.vault;
    this.main = parts.main;
    this.provider = parts.provider;
    this.now = parts.now ?? (() => Date.now());
    this.log = parts.log ?? ((event) => console.log(JSON.stringify(event)));
    /** A start is in flight in this instance: a second connection with the ticket gets an error (row 8). */
    this.starting = false;
    /** The provider connection is live in this instance's memory. A restart loses it. */
    this.connected = false;
  }

  /**
   * Starts the session for a connection that brought `ticketText`. The relay's
   * entry has checked its signature; this checks the rest. Returns the
   * reconnect secret, or a code the client gets.
   * @param {string} ticketText
   * @param {import("./ticket.js").Ticket} ticket
   * @returns {Promise<{ ok: true, reconnectSecret: string, call: ProviderCall, deadline: number } | { ok: false, code: string }>}
   */
  async start(ticketText, ticket) {
    if (this.starting) return { ok: false, code: "start_in_flight" };
    // Set before the first wait, so a second connection that arrives meanwhile is refused.
    this.starting = true;
    try {
      if (ticket.sid !== this.name) return { ok: false, code: "ticket_refused" };
      const stored = await this.store.get(KEYS);
      const state = stored.get("state");
      if (state === "ended") return { ok: false, code: "session_ended" };
      if (state === "active") return { ok: false, code: "session_active" };
      // A restart in `starting`: `open` is done. A retry with the same ticket goes on (row 9),
      // unless "connecting" was recorded: then the outcome is unknown, and it never connects again (rows 10, 11).
      const resumed = state === "starting";
      if (resumed && stored.get("connecting") === true) {
        await this.end("error", { log: "relay_start_outcome_unknown" });
        return { ok: false, code: "session_ended" };
      }
      if (this.now() >= ticket.exp) return { ok: false, code: "ticket_expired" };

      /** @type {SessionKey} */
      let key;
      try {
        key = await this.vault.sessionKey(ticketText, { restart: false });
      } catch (error) {
        // Nothing stored, nothing started: the client may retry with the same ticket (row 4).
        this.log({ level: "warn", message: "relay_vault_refused", session: this.name, code: codeOf(error) });
        return { ok: false, code: "credential_unavailable" };
      }

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
          this.log({ level: "warn", message: "relay_open_failed", session: this.name, code });
          return { ok: false, code: code === "ticket_expired" || code === "ticket_refused" ? code : "open_failed" };
        }
        // `open` succeeded: only now is anything stored, with the alarm that closes the session
        // if no client starts it before the ticket expires (row 9).
        await this.store.put({ state: "starting", ticket: ticketText, settings }, ticket.exp);
      }

      await this.store.put({ connecting: true }, null);
      /** @type {ProviderCall} */
      let call;
      try {
        call = await this.provider.connect(key);
      } catch (error) {
        if (error instanceof ProviderRefused) {
          await this.end("error", { log: "relay_provider_refused", status: error.status });
        } else {
          // Sent, and no answer came back: never retried (4.3 step 4; row 10).
          await this.end("error", { log: "relay_start_outcome_unknown" });
        }
        return { ok: false, code: "provider_unavailable" };
      }
      this.connected = true;
      const reconnectSecret = newSecret();
      const deadline = deadlineOf(ticket);
      await this.store.put({ state: "active", callId: call.callId, reconnect: await hashOf(reconnectSecret) }, deadline);
      return { ok: true, reconnectSecret, call, deadline };
    } finally {
      this.starting = false;
    }
  }

  /**
   * Ends the session: stores the end in one write, then sends `close` once.
   * The alarm retries `close` until it is confirmed, then cleans up.
   * @param {string} reason
   * @param {{ finalSlice?: number, log?: string, status?: number }} [details]
   */
  async end(reason, details = {}) {
    const stored = await this.store.get(KEYS);
    if (stored.get("state") === "ended" || typeof stored.get("ticket") !== "string") return;
    const at = this.now();
    if (details.log !== undefined) {
      this.log({ level: reason === "error" ? "error" : "info", message: details.log, session: this.name, ...(details.status === undefined ? {} : { status: details.status }) });
    }
    this.connected = false;
    await this.store.put({ state: "ended", end: { reason, at, finalSlice: details.finalSlice ?? 0 } }, at + CLOSE_RETRY_EVERY_MS);
    await this.sendClose();
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
      this.log({ level: "warn", message: "relay_close_failed", session: this.name, code: codeOf(error) });
      return false;
    }
    await this.store.put({ closed: true }, this.cleanupAt(ticket));
    return true;
  }

  /** When storage may go: once the ticket has expired, so the `ended` marker refuses it until then. @param {string} ticketText */
  cleanupAt(ticketText) {
    const exp = ticketExpiry(ticketText);
    return Math.max(this.now(), exp);
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
      // A relayed session lost its provider socket with its instance: it ends (row 13, relayed).
      // An observed session reattaches instead (part 3): until then it waits for its deadline.
      if (!this.connected && settings?.mode !== "observed") return this.end("error", { log: "relay_provider_lost" });
      return this.store.put({}, deadline);
    }
    // Ended: retry `close` for a while, then give up and log; then clean up once the ticket has expired.
    const end = /** @type {{ at: number } | undefined} */ (stored.get("end"));
    if (stored.get("closed") !== true) {
      if (await this.sendClose()) return;
      if (now - (end?.at ?? now) < CLOSE_RETRY_MS) return this.store.put({}, now + CLOSE_RETRY_EVERY_MS);
      this.log({ level: "error", message: "relay_close_given_up", session: this.name });
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

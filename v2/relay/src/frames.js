// @ts-check
/**
 * What a live session does with its frames, apart from any WebSocket (plan
 * section 5.2, "Frames" and "Heartbeats and reconnects"; step 9a part 1,
 * fourth review). The session object (`./index.js`) calls it for each frame
 * and on each alarm tick; the tests call it directly.
 *
 * Nothing here writes storage or waits: forwarding is the audio path, and a
 * storage write in the same step would hold outgoing frames (plan 5.2). It
 * keeps a few counters in memory, which a restart loses; a restarted relayed
 * session ends anyway (crash table row 13).
 *
 * The relay's own messages (`agw.*`) go only to a client that asked for them
 * in its opening handshake, with `RELAY_MESSAGES_HEADER: 1` (our SDK does).
 * Official provider SDKs get none, and their frames are never read for them.
 */

/** The opening handshake header a client sends to get the relay's own messages. */
export const RELAY_MESSAGES_HEADER = "x-agw-relay-messages";
/** The relay's own messages start with this, so one cheap check finds them. */
const RELAY_MESSAGE_PREFIX = '{"type":"agw.';

/** The fixed alarm tick of every session object (plan section 5): checkpoint, time cap, liveness. */
export const TICK_MS = 30_000;
/** A client that sends nothing for this long is gone (plan 5.2: any client message counts as alive). */
export const HEARTBEAT_TIMEOUT_MS = 90_000;
/**
 * How far behind a client that sends received-byte reports may fall before the
 * session ends with "client too slow": about 10 s of audio (plan 5.2). Provisional:
 * 9c sets it on a phone.
 */
export const SLOW_CLIENT_MS = 10_000;
/** The largest client frame forwarded (plan 5.2: a maximum frame size from the client). */
export const MAX_CLIENT_FRAME = 256 * 1024;
/** The most client frames in one second (plan 5.2: a maximum message rate, generous). */
export const MAX_CLIENT_FRAMES_PER_SECOND = 200;
/** Frames held while the session starts, on each side, before the session gives up on them. */
export const START_QUEUE_FRAMES = 512;

/** A frame's size, as both sides count it: a text frame's length in characters, a binary frame's bytes. @param {string | ArrayBuffer} data */
export function frameSize(data) {
  return typeof data === "string" ? data.length : data.byteLength;
}

/**
 * @typedef {(data: string | ArrayBuffer) => string | null} ClientFrameHook
 * Reads a client frame before it goes upstream: null forwards it, a code
 * refuses it and ends the session. Adapters fill it in (plan 5.2: "the hook
 * for reading client frames exists from the first relay step").
 *
 * @typedef {{ kind: "forward" }
 *   | { kind: "answer", message: string }
 *   | { kind: "drop" }
 *   | { kind: "end", reason: string, closeCode: number, closeReason: string }} ClientVerdict
 */

export class SessionFrames {
  /**
   * @param {{ now?: () => number, relayMessages: boolean, clientHook?: ClientFrameHook }} options
   */
  constructor(options) {
    this.now = options.now ?? (() => Date.now());
    /** Whether the client asked for the relay's own messages. */
    this.relayMessages = options.relayMessages;
    this.clientHook = options.clientHook ?? (() => null);
    const now = this.now();
    this.lastClientAt = now;
    this.lastProviderAt = now;
    /** The frame rate window: when it started, and how many frames came in it. */
    this.windowStart = now;
    this.windowFrames = 0;
    /** Characters and bytes sent to the client so far. */
    this.sent = 0;
    /** What the client last reported it got, or null before its first report. */
    this.reported = /** @type {number | null} */ (null);
    /**
     * Points along what was sent, about one a second: [total sent, when]. The
     * oldest point the client has not reported yet tells how far behind it is.
     * @type {[number, number][]}
     */
    this.marks = [];
  }

  /**
   * A frame from the client. Counts it as a sign of life, checks its size and
   * the rate, answers the relay's own messages, and runs the adapter's hook.
   * @param {string | ArrayBuffer} data
   * @returns {ClientVerdict}
   */
  fromClient(data) {
    const now = this.now();
    this.lastClientAt = now;
    if (now - this.windowStart >= 1_000) {
      this.windowStart = now;
      this.windowFrames = 0;
    }
    this.windowFrames += 1;
    if (this.windowFrames > MAX_CLIENT_FRAMES_PER_SECOND) return { kind: "end", reason: "error", closeCode: 1008, closeReason: "rate_limited" };
    if (frameSize(data) > MAX_CLIENT_FRAME) return { kind: "end", reason: "error", closeCode: 1009, closeReason: "frame_too_large" };
    if (this.relayMessages && typeof data === "string" && data.startsWith(RELAY_MESSAGE_PREFIX)) return this.relayMessage(data);
    const refused = this.clientHook(data);
    if (refused !== null) return { kind: "end", reason: "error", closeCode: 1008, closeReason: refused };
    return { kind: "forward" };
  }

  /**
   * One of the relay's own messages from a client that asked for them: never forwarded.
   * @param {string} data
   * @returns {ClientVerdict}
   */
  relayMessage(data) {
    /** @type {unknown} */
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return { kind: "drop" };
    }
    const fields = /** @type {{ type?: unknown, bytes?: unknown }} */ (message);
    if (fields.type === "agw.heartbeat") return { kind: "answer", message: JSON.stringify({ type: "agw.heartbeat" }) };
    if (fields.type === "agw.received" && typeof fields.bytes === "number" && Number.isFinite(fields.bytes) && fields.bytes >= 0) {
      this.received(fields.bytes);
      const slow = this.slow(this.now());
      if (slow !== null) return { kind: "end", reason: slow, closeCode: 4000, closeReason: slow };
    }
    return { kind: "drop" };
  }

  /** The client's report of what it got so far. Never goes back. @param {number} bytes */
  received(bytes) {
    this.reported = Math.max(this.reported ?? 0, bytes);
    while (this.marks.length > 0 && /** @type {[number, number]} */ (this.marks[0])[0] <= this.reported) this.marks.shift();
  }

  /**
   * A frame from the provider, forwarded to the client. Only counted: the
   * frame itself is passed on untouched (plan 5.2).
   * @param {string | ArrayBuffer} data
   */
  toClient(data) {
    const now = this.now();
    this.lastProviderAt = now;
    this.sent += frameSize(data);
    const last = this.marks.at(-1);
    if (last === undefined || now - last[1] >= 1_000) this.marks.push([this.sent, now]);
    else last[0] = this.sent;
  }

  /**
   * Whether the client fell too far behind: only for a client that sends
   * reports (ours). Official SDKs send none, and only the session's cap bounds them.
   * @param {number} now
   * @returns {"client_too_slow" | null}
   */
  slow(now) {
    if (this.reported === null) return null;
    const oldest = this.marks[0];
    return oldest !== undefined && now - oldest[1] > SLOW_CLIENT_MS ? "client_too_slow" : null;
  }

  /**
   * The tick's checks. A client that sent nothing for 90 s is gone; for a client
   * that did not ask for the relay's messages (so sends no heartbeat), the wait
   * does not count while the provider still sends to it (plan 5.2: a
   * receive-only client is not cut).
   * @param {number} now
   * @returns {"heartbeat_timeout" | "client_too_slow" | null}
   */
  check(now) {
    const quietClient = now - this.lastClientAt >= HEARTBEAT_TIMEOUT_MS;
    const quietProvider = now - this.lastProviderAt >= HEARTBEAT_TIMEOUT_MS;
    if (quietClient && (this.relayMessages || quietProvider)) return "heartbeat_timeout";
    return this.slow(now);
  }
}

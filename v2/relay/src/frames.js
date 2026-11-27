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
export const RELAY_MESSAGE_PREFIX = '{"type":"agw.';

/** The fixed alarm tick of every session object (plan section 5): checkpoint, time cap, liveness. */
export const TICK_MS = 30_000;
/** A client that sends nothing for this long is gone (plan 5.2: any client message counts as alive). */
export const HEARTBEAT_TIMEOUT_MS = 90_000;
/**
 * How far behind a client that sends received-byte reports may fall before the
 * session ends with "client too slow" (plan 5.2). Set on a phone in 9c (T37):
 * xAI sends a one-minute answer, 3–5 MB, within about 3 s, so a phone on a slow
 * mobile link needs 25–40 s to receive it while still far ahead of playback.
 * 30 s keeps that phone, and still ends a client that stopped reading.
 */
export const SLOW_CLIENT_MS = 30_000;
/** The largest client frame forwarded (plan 5.2: a maximum frame size from the client). */
export const MAX_CLIENT_FRAME = 256 * 1024;
/**
 * The most client frames in one rate window (plan 5.2: a maximum message rate,
 * generous). Counted over 10 s, not 1 s: a phone that sends 50 frames a second
 * and catches up after a few seconds' stall delivers 200 and more in one
 * second, and must not be ended for it. A flood still is.
 */
export const MAX_CLIENT_FRAMES_PER_WINDOW = 2_000;
/** The rate window. */
export const RATE_WINDOW_MS = 10_000;
/**
 * Frames held while the session starts, on each side, and for a client that is
 * away, before the session gives up on them.
 */
export const START_QUEUE_FRAMES = 512;
/**
 * Bytes held in the same places. Set on a phone in 9c (T37): one xAI audio frame
 * is about 68,000 characters (1.1 s of audio), and an answer of 46–83 s arrives
 * within about 3 s, often while the client is away. 8 MB holds about 120 such
 * frames, about 2 minutes of audio, and stays small next to the 128 MB an
 * isolate has, which several session objects may share.
 */
export const START_QUEUE_BYTES = 8 * 1024 * 1024;

/**
 * A frame's size, as both sides count it: a text frame's length in UTF-16 code
 * units (what JavaScript's `length` gives), a binary frame's bytes. Our SDK
 * counts the same way in its received-byte reports (`../PROTOCOL.md`).
 * @param {string | ArrayBuffer} data
 */
export function frameSize(data) {
  return typeof data === "string" ? data.length : data.byteLength;
}

/**
 * Frames held, in order, while a session starts: bounded by count and by
 * size, so a client or provider that sends a lot during the start can't fill
 * the isolate's memory. `push` answers false once either bound is passed, and
 * the queue then holds nothing more.
 */
export class StartQueue {
  constructor() {
    /** @type {(string | ArrayBuffer)[]} */
    this.frames = [];
    this.bytes = 0;
    this.overflowed = false;
  }

  /**
   * A text frame is charged one byte per character: provider frames are JSON
   * with base64 audio, which is ASCII, and the runtime keeps an ASCII string at
   * one byte per character. Its length costs nothing to read. A frame with
   * other characters takes up to twice that, bounded by the frame size and
   * rate limits.
   * @param {string | ArrayBuffer} data
   */
  push(data) {
    if (this.overflowed) return false;
    const size = frameSize(data);
    if (this.frames.length >= START_QUEUE_FRAMES || this.bytes + size > START_QUEUE_BYTES) {
      this.overflowed = true;
      this.frames = [];
      this.bytes = 0;
      return false;
    }
    this.frames.push(data);
    this.bytes += size;
    return true;
  }

  /** Hands over what was held, in order, and empties the queue. */
  drain() {
    const frames = this.frames;
    this.frames = [];
    this.bytes = 0;
    return frames;
  }
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
 *   | { kind: "end", reason: string, closeCode?: number, closeReason?: string }} ClientVerdict
 * An end with a close code closes the client with it first. One without (a client
 * too slow) is closed by the session's end, with the code the core gives its reason.
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
    /** Whether any message came from the client since the start: the relayed proof that the session is real (crash table row 20). */
    this.clientSpoke = false;
    /** The frame rate window: when it started, and how many frames came in it. */
    this.windowStart = now;
    this.windowFrames = 0;
    /** Characters and bytes of provider frames sent to the client so far. The relay's own messages don't count. */
    this.sent = 0;
    /**
     * Points along what was sent, about one a second: [total sent, when]. The
     * oldest point the client has not reported yet tells how far behind it is.
     * Kept only for a client that sends reports (ours), from the first provider
     * frame on, so one that stalls before its first report is still caught.
     * @type {[number, number][]}
     */
    this.marks = [];
    /**
     * The client's link is down and it may come back (`./index.js`, a reconnect to the same
     * session): only the heartbeat counts then. Nothing is being sent to it, so "too slow" can't be judged.
     */
    this.detached = false;
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
    this.clientSpoke = true;
    if (now - this.windowStart >= RATE_WINDOW_MS) {
      this.windowStart = now;
      this.windowFrames = 0;
    }
    this.windowFrames += 1;
    if (this.windowFrames > MAX_CLIENT_FRAMES_PER_WINDOW) return { kind: "end", reason: "error", closeCode: 1008, closeReason: "rate_limited" };
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
    // A report counts only as a whole number no larger than what was sent: a wrong or
    // too-high one is ignored, so it can't switch the check off.
    if (fields.type === "agw.received" && typeof fields.bytes === "number" && Number.isSafeInteger(fields.bytes) && fields.bytes >= 0 && fields.bytes <= this.sent) {
      this.received(fields.bytes);
      const slow = this.slow(this.now());
      if (slow !== null) return { kind: "end", reason: slow };
    }
    return { kind: "drop" };
  }

  /**
   * Our SDK came back on a new link with its reconnect secret (`./index.js`). The received-byte
   * counts start again from zero; the rate window and the client hook go on as they were. The
   * secret proves the client is there, for the next checkpoint (crash table row 20).
   */
  reattached() {
    this.sent = 0;
    this.marks = [];
    this.detached = false;
    this.lastClientAt = this.now();
    this.clientSpoke = true;
  }

  /** The client's report of what it got so far: the marks it has passed go. @param {number} bytes */
  received(bytes) {
    while (this.marks.length > 0 && /** @type {[number, number]} */ (this.marks[0])[0] <= bytes) this.marks.shift();
  }

  /**
   * A frame from the provider, forwarded to the client. Only counted: the
   * frame itself is passed on untouched (plan 5.2). A `keepalive` frame (xAI's
   * `ping`) is not the provider sending: a client that is gone is still ended
   * by the 90 s rule.
   * @param {string | ArrayBuffer} data
   * @param {boolean} [keepalive]
   */
  toClient(data, keepalive = false) {
    const now = this.now();
    if (!keepalive) this.lastProviderAt = now;
    this.sent += frameSize(data);
    if (!this.relayMessages) return;
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
    if (!this.relayMessages) return null;
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
    return this.detached ? null : this.slow(now);
  }
}

/**
 * A provider frame: forwarded once the session started, held before that.
 * Never closes anything: on overflow the queue drops what it held and holds
 * nothing more, and the owning start ends the session with
 * `4000 start_queue_full` (`./index.js`, `begin`). A close here could end the
 * session first, with another reason (Sol, #260 round 2).
 * @param {{ forward: ((data: string | ArrayBuffer) => void) | null, pending: StartQueue }} call
 * @param {string | ArrayBuffer} data
 */
export function providerFrame(call, data) {
  if (call.forward !== null) call.forward(data);
  else call.pending.push(data);
}

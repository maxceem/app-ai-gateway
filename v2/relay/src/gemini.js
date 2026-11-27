// @ts-check
/**
 * A Gemini Live session's upstream connection (plan step 9d; T19). The relay
 * owns resumption: it turns on session resumption and context compression in
 * the client's `setup`, keeps the latest resumption handle, and swaps the
 * upstream connection itself, so the client keeps one link and notices
 * nothing.
 *
 * - **The setup.** The client's first `setup` gets the session's locked model,
 *   context compression (unless the app set its own), and an empty
 *   `sessionResumption`, in place of any resumption fields the app set. A
 *   later `setup` is dropped: Gemini takes one per connection.
 * - **Hidden from the client:** `sessionResumptionUpdate`, `goAway`, and the
 *   `setupComplete` of a resumed connection.
 * - **A swap** happens after `goAway`, at a quiet moment: nobody speaking, and
 *   no answer running or on its way (from the end of the user's turn to the
 *   answer's `turnComplete`). It waits no later than `timeLeft` less
 *   `GOAWAY_MARGIN_MS`, then swaps anyway. It also happens when the live
 *   connection closes without warning (`gemini-3.8-live` once did, T19).
 * - **How it swaps:** client frames wait from then on; the old connection is
 *   closed first, since Gemini refuses a resume while it is open; then a new
 *   one resumes with the handle, retried every `RESUME_RETRY_MS`. Once it is
 *   set up, the waiting frames go to it in order. Nothing that already went to
 *   the old connection is sent again.
 * - **A swap that fails** within `RESUME_LIMIT_MS`, or a connection that ends
 *   with no handle to resume, ends the session as the provider's close.
 * - **An answer cut** by a swap or a close never reports its usage (T19). It is
 *   billed from the audio the relay forwarded, about 25 tokens a second,
 *   marked as an estimate (plan 9d; AGENTS.md: never as free).
 */
import { geminiMeasures, geminiMessage } from "./adapters.js";
import { frameSize, StartQueue } from "./frames.js";

/** How long before Gemini's own close a swap that waited for a quiet moment happens anyway (T19: "about `timeLeft` minus 10 s"). */
export const GOAWAY_MARGIN_MS = 10_000;
/** How soon a refused resume is tried again (T19: `gemini-3.8-live` refused for 300–650 ms after the old close). */
export const RESUME_RETRY_MS = 250;
/** How long a swap may take, from its start to the new connection's `setupComplete`, before the session ends (T19: 0.3–2 s). */
export const RESUME_LIMIT_MS = 10_000;
/** How long a swap waits for the old connection's close before it opens the new one anyway. */
export const OLD_CLOSE_WAIT_MS = 3_000;
/**
 * Bytes of a forwarded answer per estimated output token: base64 PCM at 24 kHz
 * (48,000 bytes a second, 4 base64 characters per 3 bytes) at Google's 25 audio
 * tokens a second (`research/…/a1-openai-gemini-xai.md`): 64,000 / 25.
 */
export const BYTES_PER_ESTIMATED_TOKEN = 2_560;

/** A client frame's start, as text, to tell what it is. @param {string | ArrayBuffer} data @param {number} length */
function headOf(data, length) {
  if (typeof data === "string") return data.slice(0, length);
  return new TextDecoder().decode(new Uint8Array(data, 0, Math.min(length, data.byteLength)));
}

/** A later client `setup` message: `{"setup": …}`. Gemini takes one per connection, so a later one is dropped. */
const SETUP_START = /^\s*\{\s*"setup"\s*:/u;
/** A client message that may ask for an answer: a text turn, or a tool's result. */
const TURN_START = /^\s*\{\s*"(clientContent|toolResponse)"\s*:/u;
const TURN_COMPLETE = /"turnComplete"\s*:\s*true/u;
/** A realtime text input: Gemini answers it as it answers a turn. */
const REALTIME_TEXT = /^\s*\{\s*"realtimeInput"\s*:\s*\{\s*"text"\s*:/u;
/** Realtime audio from the client. */
const REALTIME_AUDIO = /^\s*\{\s*"realtimeInput"\s*:\s*\{\s*"(audio|mediaChunks)"\s*:/u;
/**
 * Models that send no `voiceActivity` markers (T19: Gemini 2.5 native audio). On them the relay
 * can't see when speech ends, so audio since the last `turnComplete` counts as an answer on its way.
 */
const NO_VOICE_MARKERS = /gemini-2\.5/u;
/** The longest client frame read for a speech signal: `activityStart` and `activityEnd` frames are tiny. */
const SIGNAL_MAX = 256;

/**
 * What a client frame says about the conversation, read cheaply: an answer is
 * asked for (`"turn"`), a tool's result (`"tool"`), the user starts or stops
 * speaking, or nothing.
 * @param {string | ArrayBuffer} data
 * @returns {"turn" | "tool" | "start" | "end" | "audio" | null}
 */
function clientSignal(data) {
  const head = headOf(data, 96);
  if (TURN_START.test(head)) {
    if (/"toolResponse"/u.test(head.slice(0, 32))) return "tool";
    return TURN_COMPLETE.test(typeof data === "string" ? data : new TextDecoder().decode(new Uint8Array(data))) ? "turn" : null;
  }
  if (REALTIME_TEXT.test(head)) return "turn";
  if (REALTIME_AUDIO.test(head)) return "audio";
  if (frameSize(data) > SIGNAL_MAX) return null;
  const signal = headOf(data, SIGNAL_MAX);
  if (signal.includes('"activityStart"')) return "start";
  if (signal.includes('"activityEnd"')) return "end";
  return null;
}

/** `"50s"` as milliseconds, or null. @param {unknown} value */
function durationMs(value) {
  if (typeof value !== "string" || !value.endsWith("s")) return null;
  const seconds = Number(value.slice(0, -1));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

/**
 * @typedef {{
 *   addEventListener(type: "message", listener: (event: { data: string | ArrayBuffer }) => void): void,
 *   addEventListener(type: "close", listener: (event: { code: number, reason?: string }) => void): void,
 *   send(data: string | ArrayBuffer): void,
 *   close(code?: number, reason?: string): void,
 * }} Socket
 * @typedef {{
 *   frame(data: string | ArrayBuffer): boolean | void,
 *   usage(event: import("./journal.js").UsageEvent): void,
 *   cut(): void,
 *   gone(): void,
 *   capped(): void,
 *   refuse(code: string): void,
 *   log(event: Record<string, unknown>): void,
 * }} Events
 * What the session object does with the upstream's news: a frame for the
 * client, a usage event (an estimate, or usage from a closing connection),
 * an answer cut, the end of the provider's side, the session's deadline
 * reached during a swap, and a client whose first message was not a setup.
 */

export class GeminiUpstream {
  /**
   * @param {{
   *   socket: Socket,
   *   open: () => Promise<Socket>,
   *   model: string | null | undefined,
   *   deadline?: number,
   *   events: Events,
   *   now?: () => number,
   *   wait?: (ms: number) => Promise<void>,
   * }} parts
   * `open` connects a new upstream with the session's key; `wait` is a timer, the tests give their own.
   */
  constructor(parts) {
    this.open = parts.open;
    this.model = parts.model ?? null;
    /** The session's deadline: no swap goes on past it. */
    this.deadline = parts.deadline ?? Infinity;
    this.events = parts.events;
    this.now = parts.now ?? (() => Date.now());
    this.wait = parts.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    /** @type {Socket | null} The connection frames go to; null during a swap. */
    this.socket = null;
    /** @type {Socket | null} A swap's new connection, until its `setupComplete`. */
    this.next = null;
    /** @type {Socket | null} A swap's old connection, until its close. */
    this.retiring = null;
    /** @type {(() => void) | null} */
    this.retired = null;
    /** @type {Record<string, unknown> | null} The setup sent, for a resume. */
    this.setup = null;
    /** @type {string | null} The latest resumable handle. */
    this.handle = null;
    /** @type {StartQueue | null} Client frames that wait during a swap. */
    this.waiting = null;
    /** A swap's number: a timer or a close from an earlier swap changes nothing. */
    this.swaps = 0;
    /** When the swap in progress must be done. */
    this.swapBy = 0;
    /** An answer is running, and how many bytes of it went to the client. */
    this.answering = false;
    this.answerBytes = 0;
    /** Answers asked for (a finished turn, a tool's result, the end of speech) and not yet complete. */
    this.awaiting = 0;
    /** The user is speaking: a voice activity start with no end yet. */
    this.speaking = false;
    /** A model with no voice markers (`NO_VOICE_MARKERS`): audio came since the last `turnComplete`. */
    this.noMarkers = this.model !== null && NO_VOICE_MARKERS.test(this.model);
    this.heardAudio = false;
    /**
     * @type {import("./journal.js").UsageEvent | null} A cut answer's estimate, held while its old
     * connection closes: that connection may still report the answer's real usage, which wins.
     */
    this.heldEstimate = null;
    /** @type {number | null} After `goAway`: when the swap happens at the latest. */
    this.goAwayBy = null;
    /** The session let go of this upstream: nothing is resumed any more. */
    this.closed = false;
    this.attach(parts.socket);
    this.socket = parts.socket;
  }

  /** @param {Socket} socket */
  attach(socket) {
    socket.addEventListener("message", (event) => this.fromUpstream(socket, event.data));
    socket.addEventListener("close", (event) => this.upstreamClosed(socket, event.code, event.reason));
  }

  /**
   * A client frame, past the relay's own checks. The first message must be a
   * setup: it is rewritten, and anything else ends the session (the model
   * lock). A later setup is dropped. During a swap a frame waits.
   * @param {string | ArrayBuffer} data
   */
  send(data) {
    if (this.closed) return;
    if (this.setup === null) return this.firstMessage(data);
    if (SETUP_START.test(headOf(data, 32))) {
      this.events.log({ level: "warn", message: "relay_gemini_setup_dropped" });
      return;
    }
    if (this.waiting !== null) {
      if (!this.waiting.push(data)) this.fail("relay_gemini_swap_queue_full");
      return;
    }
    this.deliver(data);
  }

  /**
   * The client's first message, read whole: only a valid setup goes upstream,
   * with the session's model.
   * @param {string | ArrayBuffer} data
   */
  firstMessage(data) {
    const setup = this.ownSetup(data);
    if (setup === null) {
      this.events.log({ level: "warn", message: "relay_gemini_setup_required" });
      this.events.refuse("setup_required");
      return;
    }
    this.setup = setup;
    try {
      this.socket?.send(JSON.stringify({ setup: { ...setup, sessionResumption: {} } }));
    } catch {
      // Closed: its close event decides what happens next.
    }
  }

  /**
   * A frame goes to the current connection, and what it says is counted then:
   * the speech and the answers it asks for belong to the connection that got it.
   * @param {string | ArrayBuffer} data
   */
  deliver(data) {
    try {
      this.socket?.send(data);
    } catch {
      // Closed: its close event decides what happens next.
    }
    const signal = clientSignal(data);
    if (signal === "start") this.speaking = true;
    else if (signal === "end") {
      this.speaking = false;
      this.awaiting += 1;
    } else if (signal === "turn") this.awaiting += 1;
    // A tool's result continues the answer that called the tool, which ends with one `turnComplete`;
    // only a result that comes after that answer asks for a new one.
    else if (signal === "tool" && !this.answering) this.awaiting += 1;
    else if (signal === "audio" && this.noMarkers) this.heardAudio = true;
  }

  /**
   * The client's setup, as the relay sends it: the session's model, compression
   * on, and none of the app's resumption fields. Null when it is not JSON.
   * @param {string | ArrayBuffer} data
   * @returns {Record<string, unknown> | null}
   */
  ownSetup(data) {
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
    } catch {
      return null;
    }
    const setup = /** @type {{ setup?: unknown }} */ (parsed)?.setup;
    if (typeof setup !== "object" || setup === null || Array.isArray(setup)) return null;
    const own = /** @type {Record<string, unknown>} */ ({ ...setup });
    // Gemini reads both spellings of a field.
    delete own.sessionResumption;
    delete own.session_resumption;
    if (this.model !== null) own.model = this.model.startsWith("models/") ? this.model : `models/${this.model}`;
    if (own.contextWindowCompression === undefined && own.context_window_compression === undefined) own.contextWindowCompression = { slidingWindow: {} };
    return own;
  }

  /**
   * A frame from an upstream connection. Only the current one's frames reach the
   * client; an old one's usage still counts.
   * @param {Socket} socket
   * @param {string | ArrayBuffer} data
   */
  fromUpstream(socket, data) {
    const message = geminiMessage(data);
    if (socket === this.retiring) {
      // An old connection's last frames: its usage counts, and is the real figure for an answer the
      // swap cut, so its estimate goes. Nothing goes to the client.
      const usage = message?.usageMetadata;
      if (typeof usage === "object" && usage !== null) {
        this.heldEstimate = null;
        this.events.usage({ id: crypto.randomUUID(), measures: geminiMeasures(usage) });
      }
      return;
    }
    if (socket === this.next) {
      if (message?.setupComplete !== undefined) this.swapped();
      else if (message?.sessionResumptionUpdate !== undefined) this.keepHandle(message.sessionResumptionUpdate);
      return;
    }
    if (socket !== this.socket || this.closed) return;
    if (message?.sessionResumptionUpdate !== undefined) return this.keepHandle(message.sessionResumptionUpdate);
    if (message?.goAway !== undefined) return this.goAway(message.goAway);
    const content = message?.serverContent;
    const answer = content?.modelTurn !== undefined || message?.toolCall !== undefined;
    if (answer) this.answering = true;
    // Only an answer's audio is estimated if it is cut: a tool call's JSON is not audio.
    const audio = content?.modelTurn !== undefined;
    const activity = message?.voiceActivity?.type;
    if (activity === "ACTIVITY_START") this.speaking = true;
    // Only what reached the client (or waits for it) is estimated if the answer is cut: audio the
    // relay throws away while the session closes is not.
    const forwarded = this.events.frame(data);
    if (audio && forwarded !== false) this.answerBytes += frameSize(data);
    // The user stopped speaking: Gemini answers next, on this connection.
    if (activity === "ACTIVITY_END") {
      this.speaking = false;
      this.awaiting += 1;
    }
    if (content?.turnComplete === true) {
      this.answering = false;
      this.answerBytes = 0;
      this.awaiting = Math.max(0, this.awaiting - 1);
      this.heardAudio = false;
      this.quietNow();
    }
  }

  /** @param {{ newHandle?: unknown, resumable?: unknown }} update */
  keepHandle(update) {
    // `resumable` is absent while 2.5 generates, false when the session can't be resumed now (T19).
    if (typeof update.newHandle === "string" && update.newHandle !== "" && update.resumable !== false) this.handle = update.newHandle;
  }

  /**
   * Gemini will close this connection soon: swap at the next quiet moment, and
   * no later than `timeLeft` less the margin.
   * @param {{ timeLeft?: unknown }} notice
   */
  goAway(notice) {
    if (this.goAwayBy !== null) return;
    const left = durationMs(notice?.timeLeft) ?? GOAWAY_MARGIN_MS;
    const by = this.now() + Math.max(0, left - GOAWAY_MARGIN_MS);
    this.goAwayBy = by;
    this.events.log({ level: "info", message: "relay_gemini_go_away", leftMs: left });
    if (this.quietNow()) return;
    const socket = this.socket;
    void this.wait(by - this.now()).then(() => {
      if (this.socket === socket && this.goAwayBy === by) this.swap("go_away_deadline");
    });
  }

  /** After `goAway`, swaps once nobody is speaking, and no answer runs or is on its way. Returns whether it did. */
  quietNow() {
    if (this.goAwayBy === null || this.answering || this.awaiting > 0 || this.speaking || this.heardAudio || this.socket === null) return false;
    this.swap("go_away");
    return true;
  }

  /**
   * The current connection, or a swap's new one, closed.
   * @param {Socket} socket
   * @param {number} code
   * @param {string} [reason] Gemini's own words, cut short for the log
   */
  upstreamClosed(socket, code, reason) {
    if (socket === this.retiring) {
      this.retiring = null;
      this.retired?.();
      return;
    }
    if (this.closed) return;
    if (socket === this.next) {
      // Refused before it was set up: Gemini still sees the old connection (T19). Tried again soon.
      this.next = null;
      const swap = this.swaps;
      void this.wait(RESUME_RETRY_MS).then(() => {
        if (this.swaps === swap && this.waiting !== null) void this.resume(swap);
      });
      return;
    }
    if (socket !== this.socket) return;
    // The live connection closed without warning: resumed, as after `goAway` (T19).
    this.socket = null;
    this.events.log({ level: "warn", message: "relay_gemini_upstream_closed", code, reason: String(reason ?? "").slice(0, 120) });
    this.swap("upstream_closed", false);
  }

  /**
   * Starts a swap: client frames wait, the old connection is closed first, and a
   * new one resumes with the handle.
   * @param {string} why
   * @param {boolean} [closeOld] false when the old connection closed already
   */
  swap(why, closeOld = true) {
    if (this.closed || this.waiting !== null) return;
    if (this.handle === null || this.setup === null) {
      // Nothing to resume with: the session ends with the connection.
      if (!closeOld) return this.fail("relay_gemini_no_handle", why);
      return;
    }
    this.swaps += 1;
    const swap = this.swaps;
    this.waiting = new StartQueue();
    this.swapBy = this.now() + RESUME_LIMIT_MS;
    this.goAwayBy = null;
    this.speaking = false;
    // Whatever was on its way went to the old connection: it will not come.
    this.awaiting = 0;
    this.heardAudio = false;
    const cut = this.takeCut();
    this.events.log({ level: "info", message: "relay_gemini_swap", why });
    const old = closeOld ? this.socket : null;
    this.socket = null;
    // A cut answer's estimate waits for the old connection's close: its real usage may still come.
    if (cut !== null && old !== null) this.heldEstimate = cut;
    else if (cut !== null) this.events.usage(cut);
    void this.wait(RESUME_LIMIT_MS).then(() => {
      if (this.swaps === swap && this.waiting !== null) this.fail("relay_gemini_resume_failed", why);
    });
    void this.retire(old).then(() => {
      if (this.heldEstimate !== null && !this.closed) {
        this.events.usage(this.heldEstimate);
        this.heldEstimate = null;
      }
      if (this.swaps === swap && this.waiting !== null) void this.resume(swap);
    });
  }

  /**
   * Closes the old connection and waits for its close, or `OLD_CLOSE_WAIT_MS`.
   * @param {Socket | null} old
   */
  async retire(old) {
    if (old === null) return;
    const closed = new Promise((resolve) => {
      this.retired = () => resolve(undefined);
    });
    this.retiring = old;
    try {
      old.close(1000, "resuming");
    } catch {
      // Closed already.
      this.retiring = null;
      return;
    }
    await Promise.race([closed, this.wait(OLD_CLOSE_WAIT_MS)]);
    this.retired = null;
    // Nothing more from it counts: an estimate held for its cut answer is booked next, and only once.
    if (this.retiring === old) this.retiring = null;
  }

  /**
   * One resume attempt: a new connection with the setup and the handle. A
   * refusal before it is set up is tried again (`upstreamClosed`).
   * @param {number} swap
   */
  async resume(swap) {
    if (this.now() >= this.deadline) return this.timeUp();
    if (this.now() >= this.swapBy) return this.fail("relay_gemini_resume_failed", "deadline");
    /** @type {Socket} */
    let socket;
    try {
      socket = await this.open();
      // A handshake that began before the cap and ended after it: no resume past the session's time.
      if (this.now() >= this.deadline) {
        socket.close(1000, "session ended");
        return this.timeUp();
      }
    } catch {
      if (this.swaps !== swap || this.waiting === null) return;
      await this.wait(RESUME_RETRY_MS);
      if (this.swaps === swap && this.waiting !== null) void this.resume(swap);
      return;
    }
    if (this.closed || this.swaps !== swap || this.waiting === null) {
      socket.close(1000, "session ended");
      return;
    }
    this.next = socket;
    this.attach(socket);
    try {
      socket.send(JSON.stringify({ setup: { ...this.setup, sessionResumption: { handle: this.handle } } }));
    } catch {
      // Its close event tries again.
    }
  }

  /** The new connection is set up: the waiting frames go to it, in order, unless the session's time is up. */
  swapped() {
    const socket = /** @type {Socket} */ (this.next);
    if (this.now() >= this.deadline) return this.timeUp();
    const waiting = this.waiting?.drain() ?? [];
    this.next = null;
    this.waiting = null;
    this.socket = socket;
    for (const data of waiting) this.deliver(data);
    this.events.log({ level: "info", message: "relay_gemini_resumed", held: waiting.length });
  }

  /** The session's deadline came during a swap: nothing more goes upstream, and the session ends at its cap. */
  timeUp() {
    if (this.closed) return;
    this.waiting = null;
    this.events.capped();
  }

  /**
   * An answer cut by a swap or a close: its usage never comes (T19). Its estimate,
   * from the audio forwarded, marked as one, so it is never free; the answer is over.
   * @returns {import("./journal.js").UsageEvent | null}
   */
  takeCut() {
    if (!this.answering) return null;
    const tokens = Math.ceil(this.answerBytes / BYTES_PER_ESTIMATED_TOKEN);
    this.answering = false;
    this.answerBytes = 0;
    this.events.log({ level: "warn", message: "relay_gemini_answer_cut", estimatedTokens: tokens });
    this.events.cut();
    if (tokens === 0) return null;
    return { id: crypto.randomUUID(), measures: { output_tokens: tokens, output_split: 1, output_audio_tokens: tokens, estimated_tokens: tokens } };
  }

  /**
   * What the session's own end bills for an answer this upstream cut or is cutting:
   * an estimate held during a swap, or the answer still running. Asked once, before
   * the final slice (the session core's `estimate` hook).
   * @returns {import("./journal.js").UsageEvent | null}
   */
  estimate() {
    const held = this.heldEstimate;
    this.heldEstimate = null;
    return held ?? this.takeCut();
  }

  /**
   * The upstream is gone for good: the session ends as the provider's close.
   * @param {string} message
   * @param {string} [why]
   */
  fail(message, why) {
    if (this.closed) return;
    const cut = this.estimate();
    if (cut !== null) this.events.usage(cut);
    this.events.log({ level: "warn", message, ...(why === undefined ? {} : { why }) });
    this.closed = true;
    this.waiting = null;
    for (const socket of [this.socket, this.next]) {
      try {
        socket?.close(1000, "session ended");
      } catch {
        // Closed already.
      }
    }
    this.socket = null;
    this.next = null;
    this.events.gone();
  }

  /**
   * The session ends: every connection is closed, and nothing is resumed.
   * @param {number} code
   * @param {string} reason
   */
  close(code, reason) {
    this.closed = true;
    this.waiting = null;
    for (const socket of [this.socket, this.next, this.retiring]) {
      try {
        socket?.close(code, reason);
      } catch {
        // Closed already.
      }
    }
  }
}

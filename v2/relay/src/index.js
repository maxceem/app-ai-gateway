// @ts-check
/**
 * The relay Worker: live sessions between an app and a provider (plan step 9).
 * Plain JavaScript with no npm packages, uploaded as it is. It imports nothing
 * from the gateway Worker (plan section 5.2), and a test checks that.
 *
 * An app starts a session at `SESSION_PATH` with a WebSocket, its ticket in
 * the `authorization` header (never in the URL). The ticket's signature is
 * checked here with the main Worker's public key, before any session object
 * is created, so a made-up ticket creates nothing (crash table row 1). The
 * ticket names its session object. The object starts the session
 * (`./start.js`): the key from the vault's relay entrypoint, `open` on the
 * main Worker, then the provider.
 *
 * The object then forwards frames both ways (`./frames.js`). The session's
 * adapter (`./adapters.js`) reads usage from the provider's frames after they
 * are forwarded, into the journal; the alarm sends checkpoints.
 *
 * An observed session has no client socket at all (plan section 5): the app
 * sends its offer to `SESSION_PATH` in a POST, with the ticket, and gets the
 * provider's answer back; media then goes between the app and the provider
 * directly. The session object holds the call's side channel, reads usage
 * from it, and attaches it again whenever it closes, also after a restart,
 * with the key from the vault (`./start.js`).
 *
 * Reconnecting to the same session (plan 5.1, 5.2): when our SDK's link drops
 * (any close but a normal one), the session goes on without a client, and the
 * provider's frames are held, bounded, by the adapter's rule. The SDK comes
 * back with the same ticket and, as its first message, the reconnect secret;
 * it then gets the held frames and the session goes on. If nothing comes back,
 * the heartbeat ends the session after 90 s.
 */
import { DurableObject } from "cloudflare:workers";
import { adapterFor } from "./adapters.js";
import { HEALTH_PATH, RECONNECT_FIRST_MESSAGE_MS, RECONNECT_MESSAGE_MAX, SESSION_PATH } from "./constants.js";
import { JOURNAL_ALLOW_UNCONFIRMED, JOURNAL_KEY } from "./journal.js";
import { providerFrame, RELAY_MESSAGE_PREFIX, RELAY_MESSAGES_HEADER, SessionFrames, StartQueue } from "./frames.js";
import { GeminiUpstream } from "./gemini.js";
import { attachSideChannel, connectProvider, createObservedCall, hangUpObservedCall, signedSession } from "./provider.js";
import { ProviderRefused, SessionCore } from "./start.js";
import { parseTicket, verifyTicket } from "./ticket.js";

/**
 * @typedef {object} RelayEnv
 * @property {DurableObjectNamespace<Session>} SESSION
 * @property {import("./start.js").MainPort} MAIN the gateway Worker's `RelayContract` entrypoint
 * @property {import("./start.js").VaultPort} VAULT the vault Worker's `RelayKeys` entrypoint
 * @property {string} [RELAY_TICKET_PUBLIC_KEY] the main Worker's ticket key, public half (base64url)
 */

/** @param {number} status @param {string} code */
const refusal = (status, code) => Response.json({ error: { code } }, { status });

/** The ticket from `authorization: Bearer <ticket>`, or null. @param {Request} request */
function ticketOf(request) {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_.-]+)$/u.exec(header);
  return match?.[1] ?? null;
}

export default {
  /**
   * @param {Request} request
   * @param {RelayEnv} env
   */
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === HEALTH_PATH && request.method === "GET") {
      return Response.json({ ok: true, service: "app-ai-gateway-relay" });
    }
    if (pathname !== SESSION_PATH) return refusal(404, "not_found");
    // A relayed session is a WebSocket; an observed one is the app's offer, in a POST.
    const websocket = request.headers.get("upgrade")?.toLowerCase() === "websocket";
    if (!websocket && request.method !== "POST") return refusal(426, "websocket_required");
    /** @type {import("./ticket.js").Ticket | null} */
    let ticket;
    try {
      ticket = await verifyTicket(ticketOf(request), env.RELAY_TICKET_PUBLIC_KEY);
    } catch {
      console.log(JSON.stringify({ level: "error", message: "relay_ticket_key_unusable" }));
      return refusal(503, "service_unavailable");
    }
    // Checked before any session object exists: a made-up or cut ticket creates nothing.
    if (ticket === null) return refusal(401, "ticket_refused");
    if (ticket.mode === "observed" && websocket) return refusal(400, "offer_required");
    if (ticket.mode === "relayed" && !websocket) return refusal(426, "websocket_required");
    return env.SESSION.get(env.SESSION.idFromName(ticket.sid)).fetch(request);
  },
};

/**
 * @typedef {import("./start.js").ProviderCall & {
 *   send(data: string | ArrayBuffer): void,
 *   forward: ((data: string | ArrayBuffer) => boolean | void) | null,
 *   pending: StartQueue,
 *   meter?: import("./adapters.js").CallMeter | null,
 * }} RelayCall
 * The provider's side of a relayed session. Its frames wait in `pending` until
 * the session is started, then go through `forward`. `meter`: what the
 * session's adapter remembers about this call (`perCall`, OpenAI's).
 *
 * @typedef {{
 *   client: WebSocket | null,
 *   owner: import("./start.js").Client,
 *   frames: SessionFrames,
 *   call: RelayCall | null,
 *   deadline: number,
 *   queue: StartQueue,
 *   held: StartQueue,
 *   relayMessages: boolean,
 *   adapter: import("./adapters.js").Adapter,
 *   turnOpen: boolean,
 *   turns: number,
 *   clientState: Record<string, unknown>,
 *   providerUser: string | null,
 * }} Live
 * The session in this instance. Client frames wait in `queue` while the
 * session starts, then go to the provider in order. `client` is null while our
 * SDK's link is down; the provider's frames then wait in `held` for it to come
 * back. `turnOpen`: the provider is in the middle of an answer (the adapter's `turn`);
 * `turns` counts the answers opened, so a late "done" for an earlier one never closes a newer one.
 * `clientState`: what the adapter remembers from the client's frames (ElevenLabs' dictionaries).
 * `providerUser`: the end user's id as the provider gets it, from the ticket (an ElevenLabs agent's `user_id`):
 * the gateway decided it, and the relay only copies it.
 */

/**
 * One session: its start, its frames, its end, and its alarm. The client's
 * WebSocket is answered at once; the start runs after, and its result goes to
 * the client as a message (the reconnect secret, only to a client that asked
 * for the relay's messages) or a close with a code. Frames are forwarded both
 * ways in the step they arrive in, with no storage write and no call to the
 * main Worker (plan 5.2). The session's core (`./start.js`) owns the client's
 * socket and closes it when it ends.
 * @extends {DurableObject<RelayEnv>}
 */
export class Session extends DurableObject {
  /**
   * @param {DurableObjectState} ctx
   * @param {RelayEnv} env
   */
  constructor(ctx, env) {
    super(ctx, env);
    const storage = ctx.storage;
    /** @type {Live | null} The session this instance runs, once it started. A restart loses it. */
    this.live = null;
    /** An observed call's answer in progress, read from its side channel (the adapter's `turn`). */
    this.sideTurnOpen = false;
    /** The side channel's answers opened, and its attaches: a late "done" for an earlier one closes nothing. */
    this.sideTurns = 0;
    /** @type {import("./adapters.js").CallMeter | null} What the current side channel's adapter remembers (OpenAI's). */
    this.sideMeter = null;
    /** @type {string | null} A model the provider stated that is not the session's, logged once (`sideFrame`). */
    this.otherModel = null;
    this.core = new SessionCore({
      store: {
        get: (keys) => storage.get(keys),
        put: async (entries, alarmAt) => {
          // One write: workerd commits these together, as nothing is awaited between them.
          const writes = [storage.put(entries)];
          if (alarmAt !== null) writes.push(storage.setAlarm(alarmAt));
          await Promise.all(writes);
        },
        // The one small write per usage event (plan 5.2 rule 3).
        putJournal: (journal) => storage.put(JOURNAL_KEY, journal, { allowUnconfirmed: JOURNAL_ALLOW_UNCONFIRMED }),
        // With this compatibility date, deleteAll() removes the alarm too.
        deleteAll: () => storage.deleteAll(),
      },
      vault: env.VAULT,
      main: env.MAIN,
      provider: {
        connect: async (key, settings) => {
          // A session that starts through a signed URL (ElevenLabs agents): there, and with no key, only when
          // it is on the address the key is sealed for. It names the conversation.
          const signed = settings.signedUrl === undefined ? null : signedSession(key.target, settings.signedUrl);
          if (settings.signedUrl !== undefined && signed === null) {
            this.core.log({ level: "error", message: "relay_signed_url_refused", session: this.core.sessionId });
            throw new ProviderRefused(502);
          }
          const connected = await connectProvider(signed === null ? key : { target: signed.target }, undefined, undefined, undefined, adapterFor(settings.adapter).callIdHeader);
          const socket = connected.socket;
          const callId = signed === null ? connected.callId : signed.callId;
          // Gemini Live: the relay owns its upstream, resumes it and swaps it (`./gemini.js`, plan 9d).
          if (settings.adapter === "gemini") return this.geminiCall(key, settings, socket);
          const meter = adapterFor(settings.adapter).perCall?.(settings.model ?? null, settings) ?? null;
          /** @type {RelayCall} */
          const call = {
            callId,
            meter,
            // An answer the session's own end cuts is estimated, for a provider whose adapter can (OpenAI).
            ...(meter === null ? {} : { estimate: () => meter.estimate() }),
            // Every end hangs up through here: held frames go with the call.
            close: (code, reason) => {
              this.dropHeld(call);
              closeQuietly(socket, code, reason);
            },
            send: (data) => sendQuietly(socket, data),
            forward: null,
            pending: new StartQueue(),
          };
          // Frames that come before the session started (OpenAI sends `session.created` at
          // once) wait, in order, and go to the client once it is started. Too many, or too
          // large, and the queue drops them all and holds nothing more: the owning start then
          // ends the session with `4000 start_queue_full` (`begin`). Nothing is closed here, so
          // no close event can end the session with another reason first.
          socket.addEventListener("message", (event) => providerFrame(call, event.data));
          // The provider hung up first: the session ends, and the client is told. A close the
          // relay caused itself, after letting go of this call, is ignored (`providerGone`).
          socket.addEventListener("close", () => void this.core.providerGone(call));
          return call;
        },
        createCall: (key, offer, model) => createObservedCall(key, offer, model),
        // An observed call's side channel: its frames are read for usage, never forwarded anywhere.
        attach: async (key, callId, settings, limitMs) => {
          const socket = await attachSideChannel(key, callId, limitMs);
          const adapter = adapterFor(settings.adapter);
          // A side channel starts with nothing open: an answer a lost one missed is in its gap (OpenAI's meter).
          // What the one it replaces on this call must not forget goes on (`next`: committed items' models).
          const meter = this.sideMeter?.next?.() ?? adapter.perCall?.(settings.model ?? null, settings) ?? null;
          const keepalive = adapter.sideKeepalive;
          /** @type {import("./start.js").ProviderCall} */
          const call = {
            callId,
            close: (code, reason) => closeQuietly(socket, code, reason),
            ...(keepalive === undefined ? {} : { keepalive: () => sendQuietly(socket, keepalive) }),
          };
          this.sideMeter = meter;
          this.sideTurnOpen = false;
          this.sideTurns += 1;
          this.otherModel = null;
          socket.addEventListener("message", (event) => this.sideFrame(call, adapter, meter, event.data));
          socket.addEventListener("close", () => void this.core.sideGone(call));
          return call;
        },
        hangup: (key, callId) => hangUpObservedCall(key, callId),
      },
      // The tick's checks for the session this instance runs: none after a restart.
      liveness: (now) => this.live?.frames.check(now) ?? null,
      proof: () => this.live?.frames.clientSpoke ?? false,
      // An answer in progress, or an input transcription still to come (OpenAI): a closing session waits for both.
      // OpenAI's: its answers by id and its transcriptions (the call's meter), each until its usage is written.
      turnOpen: () => {
        if (this.live === null) return this.sideMeter?.pending() ?? this.sideTurnOpen;
        const meter = this.live.call?.meter;
        return meter === undefined || meter === null ? this.live.turnOpen : meter.pending();
      },
      // What the provider never finished: cut, if the session ends now.
      unfinished: () => {
        if (this.live === null) return this.sideMeter?.unfinished() ?? this.sideTurnOpen;
        const meter = this.live.call?.meter;
        return meter === undefined || meter === null ? this.live.turnOpen : meter.unfinished();
      },
    });
  }

  /**
   * @override
   * @param {Request} request
   */
  async fetch(request) {
    const ticketText = ticketOf(request);
    const parsed = ticketText === null ? null : parseTicket(ticketText);
    if (ticketText === null || parsed === null) return refusal(401, "ticket_refused");
    if (parsed.payload.mode === "observed") return this.observedStart(request, ticketText, parsed.payload);
    const relayMessages = request.headers.get(RELAY_MESSAGES_HEADER) === "1";
    const [client, server] = Object.values(new WebSocketPair());
    if (!client || !server) throw new Error("no WebSocket pair");
    // Binary frames as `ArrayBuffer`, not `Blob`: sizes and forwarding need the bytes at hand.
    server.binaryType = "arraybuffer";
    server.accept();
    // A session already running here: only our SDK coming back with its reconnect secret may join it.
    const running = this.live !== null && this.core.call !== null;
    this.ctx.waitUntil(running && relayMessages ? this.reconnect(server) : this.begin(server, ticketText, parsed.payload, relayMessages));
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * A Gemini Live session's provider side: an upstream the relay resumes and
   * swaps itself (`./gemini.js`). To the rest of the session it is one call,
   * like any other; it ends only when it can't be resumed.
   * @param {import("./start.js").SessionKey} key
   * @param {import("./start.js").Settings} settings
   * @param {WebSocket} socket the first connection
   * @returns {RelayCall}
   */
  geminiCall(key, settings, socket) {
    /** @type {RelayCall} */
    const call = {
      callId: null,
      close: (code, reason) => {
        this.dropHeld(call);
        upstream.close(code, reason);
      },
      send: (data) => upstream.send(data),
      estimate: () => upstream.estimate(),
      forward: null,
      pending: new StartQueue(),
    };
    const upstream = new GeminiUpstream({
      socket,
      open: async () => (await connectProvider(key)).socket,
      model: settings.model,
      deadline: settings.deadline,
      events: {
        frame: (data) => providerFrame(call, data),
        usage: (event) => void this.core.recordUsage(event, "per_turn").catch(() => undefined),
        // The cut answer is over: a closing session waits for it no more, and a late "done" closes nothing.
        cut: () => {
          const live = this.live;
          if (live?.call === call) {
            live.turnOpen = false;
            live.turns += 1;
          }
          this.core.turnDone();
        },
        gone: () => void this.core.providerGone(call),
        capped: () => {
          if (this.core.call === call) void this.core.end("time_cap");
        },
        // The first message was not a setup: the session ends, as for any frame an adapter refuses.
        refuse: (code) => {
          const live = this.live;
          if (live?.call === call) this.endFor(live, "error", 1008, code);
        },
        // Gemini closed a connection right after its setup: the client gets Gemini's code where a
        // client may be sent it, and its reason.
        ended: (code, reason) => {
          const live = this.live;
          const sendable = code === 1007 || code === 1008 || code === 1011 || (code >= 3000 && code <= 4999);
          if (live?.call === call && live.client !== null) closeQuietly(live.client, sendable ? code : 1011, reason);
          // Ended whether a client is attached or its link is down: a dead call is never joined again.
          void this.core.providerGone(call);
        },
        log: (event) => console.log(JSON.stringify({ ...event, session: this.core.sessionId })),
      },
    });
    return call;
  }

  /**
   * An observed session's start: the app's offer in, the provider's answer
   * out, once the call id is stored (4.3 step 4). The side channel is attached
   * after the answer, and the first checkpoint goes at once, as for a relayed
   * session. A refusal is an HTTP status with the start's code.
   * @param {Request} request
   * @param {string} ticketText
   * @param {import("./ticket.js").Ticket} ticket
   */
  async observedStart(request, ticketText, ticket) {
    const offer = await readOffer(request);
    if (typeof offer === "number") return offer === 413 ? refusal(413, "offer_too_large") : refusal(400, "offer_invalid");
    /** @type {import("./start.js").Client} No socket to close: the app has its answer, or its refusal. */
    const owner = { close: () => undefined };
    /** @type {Awaited<ReturnType<SessionCore["start"]>>} */
    let result;
    try {
      result = await this.core.start(ticketText, ticket, owner, offer);
    } catch {
      console.log(JSON.stringify({ level: "error", message: "relay_start_failed", session: ticket.sid }));
      if (this.core.startedBy(owner)) this.ctx.waitUntil(this.core.end("error").catch(() => undefined));
      return refusal(500, "internal_error");
    }
    if (!result.ok) {
      // An end the start began finishes inside this request, after the answer.
      if (this.core.ending !== null) this.ctx.waitUntil(this.core.ending.catch(() => undefined));
      return refusal(START_STATUS[result.code] ?? 503, result.code);
    }
    // The first checkpoint after the first attach, so it books no time from before the side channel.
    this.ctx.waitUntil(this.core.attachSide().then(() => this.core.checkpoint()).catch(() => undefined));
    return new Response(result.answer, { status: 201, headers: { "content-type": "application/sdp", "cache-control": "no-store" } });
  }

  /**
   * An observed call's side-channel frame: read for usage and answers, after
   * nothing (there is no client to forward it to). Only the current side
   * channel counts. Any frame says it is alive (the idle rule). With the
   * adapter's meter (OpenAI's), its answers and transcriptions are tracked as
   * a relayed call's are (`toClient`).
   * @param {import("./start.js").ProviderCall} call
   * @param {import("./adapters.js").Adapter} adapter
   * @param {import("./adapters.js").CallMeter | null} meter
   * @param {string | ArrayBuffer} data
   */
  sideFrame(call, adapter, meter, data) {
    if (this.core.call !== call) return;
    this.core.heard();
    if (meter !== null) {
      const finished = meter.see(data, false);
      // The app named another model on its own data channel, which the relay never sees: the session is
      // still billed at its own model, so it is logged, once per model (AGENTS.md: never miscount silently).
      const other = meter.otherModel?.() ?? null;
      if (other !== null && other !== this.otherModel) {
        this.otherModel = other;
        this.core.log({ level: "warn", message: "relay_model_changed", session: this.core.sessionId });
      }
      const settle =
        finished === null
          ? undefined
          : () => {
              meter.settled(finished);
              if (!meter.pending()) this.core.turnDone();
            };
      if (this.readUsage(adapter, data, meter, settle) === null) settle?.();
      return;
    }
    const recorded = this.readUsage(adapter, data);
    const turn = adapter.turn(data);
    if (turn === "open") {
      this.sideTurnOpen = true;
      this.sideTurns += 1;
    } else if (turn === "done") {
      const answer = this.sideTurns;
      this.answerDone(
        recorded,
        () => this.sideTurns === answer && this.core.call === call,
        () => {
          this.sideTurnOpen = false;
        },
      );
    }
  }

  /**
   * A second connection while a start is in flight is refused by the core
   * (`start_in_flight`, row 8), and its close changes nothing.
   * @param {WebSocket} client
   * @param {string} ticketText
   * @param {import("./ticket.js").Ticket} ticket
   * @param {boolean} relayMessages whether the client asked for the relay's own messages
   */
  async begin(client, ticketText, ticket, relayMessages) {
    /** @type {import("./start.js").Client} What the core holds: closing it never throws. */
    const owner = { close: (code, reason) => closeQuietly(client, code, reason) };
    /** @type {Live} */
    const live = {
      client,
      owner,
      frames: new SessionFrames({ relayMessages }),
      call: null,
      deadline: Infinity,
      queue: new StartQueue(),
      held: new StartQueue(),
      relayMessages,
      adapter: adapterFor(undefined),
      turnOpen: false,
      turns: 0,
      clientState: {},
      providerUser: ticket.providerUserId ?? null,
    };
    // Listened to before the start: a client that hangs up during it stops it, and its frames wait.
    this.listen(live, client, owner);
    /** @type {Awaited<ReturnType<SessionCore["start"]>>} */
    let result;
    try {
      result = await this.core.start(ticketText, ticket, owner);
    } catch {
      // The core has hung up any provider call; the client is told, and the session ends if it got that far.
      console.log(JSON.stringify({ level: "error", message: "relay_start_failed", session: ticket.sid }));
      closeQuietly(client, 1011, "internal_error");
      // Only a start that owned the session may end it: a second connection's failure never does.
      if (this.core.startedBy(owner)) await this.core.end("error").catch(() => undefined);
      return;
    }
    if (!result.ok) {
      closeQuietly(client, 4000, result.code);
      // An end the start began (a restarted instance's lost session) finishes inside this request.
      await this.core.ending?.catch(() => undefined);
      return;
    }
    const call = /** @type {RelayCall} */ (result.call);
    live.call = call;
    live.deadline = result.deadline;
    live.adapter = adapterFor(result.adapter);
    this.live = live;
    // Either side sent too much during the start: the session ends, and what was held is dropped.
    if (call.pending.overflowed || live.queue.overflowed) return this.endFor(live, "error", 4000, "start_queue_full");
    if (relayMessages) sendQuietly(client, JSON.stringify({ type: "agw.session.started", reconnect_secret: result.reconnectSecret, deadline: result.deadline }));
    // In order: what the provider sent during the start, then what the client did. The client's
    // go through the same guarded send as its live frames.
    call.forward = (data) => this.toClient(live, data);
    for (const data of call.pending.drain()) call.forward(data);
    for (const data of live.queue.drain()) this.toProvider(live, data);
    // The first checkpoint at once, empty if there is no usage yet: it writes the session row (call order step 9).
    void this.core.checkpoint().catch(() => undefined);
  }

  /**
   * Wires a client's socket to the session. Its frames and its close count
   * only while it is the session's client: an old socket replaced by a
   * reconnect changes nothing.
   * @param {Live} live
   * @param {WebSocket} socket
   * @param {import("./start.js").Client} owner
   */
  listen(live, socket, owner) {
    socket.addEventListener("message", (event) => {
      if (live.client === socket) this.fromClient(live, event.data);
    });
    socket.addEventListener("close", (event) => {
      if (live.client === socket) this.clientClosed(live, owner, event.code);
    });
  }

  /**
   * The session's client closed. Our SDK's link dropping (any close but a
   * deliberate one: 1000, 1001, or 1005 with no code) leaves the session running, so it can come back
   * with its reconnect secret, when the adapter holds frames for it. Anything
   * else ends the session: an official SDK can't come back to the same
   * session, and for it a reconnect is a new session (plan 5.2).
   * @param {Live} live
   * @param {import("./start.js").Client} owner
   * @param {number} code
   */
  clientClosed(live, owner, code) {
    const dropped = code !== 1000 && code !== 1001 && code !== 1005;
    if (live.relayMessages && dropped && live.adapter.detached === "hold" && this.live === live && this.core.detach(owner)) {
      live.client = null;
      live.frames.detached = true;
      console.log(JSON.stringify({ level: "info", message: "relay_client_detached", code }));
      return;
    }
    void this.core.clientGone(owner);
  }

  /**
   * Our SDK came back to a running session: its first message must be the
   * reconnect secret, within `RECONNECT_FIRST_MESSAGE_MS`. A match takes the
   * session over at once, even if the old link still looks open; the held
   * frames go to it first. Anything else gets the refusal any second
   * connection gets, `4000 session_active`.
   * @param {WebSocket} socket
   */
  async reconnect(socket) {
    const live = this.live;
    // Already ending: nothing to wait for, the client needs a new session.
    if (live === null || this.core.ending !== null) return closeQuietly(socket, 4000, "session_ended");
    // Every frame is kept from the start: the secret first, and whatever the SDK sends right after
    // it, while the secret is checked, goes to the session in order once it is taken back.
    /** @type {(string | ArrayBuffer)[]} */
    const inbox = [];
    let handedOver = false;
    /** @type {() => void} */
    let arrived = () => undefined;
    /** @param {MessageEvent} event */
    const onMessage = (event) => {
      if (handedOver) return;
      inbox.push(/** @type {string | ArrayBuffer} */ (event.data));
      arrived();
    };
    socket.addEventListener("message", onMessage);
    // A link that closes before it is handed over, even while the secret is hashed, never joins.
    let closed = false;
    const came = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), RECONNECT_FIRST_MESSAGE_MS);
      arrived = () => {
        clearTimeout(timer);
        resolve(true);
      };
      socket.addEventListener("close", () => {
        closed = true;
        clearTimeout(timer);
        resolve(false);
      }, { once: true });
    });
    const first = came ? inbox[0] : undefined;
    /** @type {unknown} */
    let secret;
    // Read only when small, and written the way every relay message is (`RELAY_MESSAGE_PREFIX`):
    // the form a live session drops, so a repeat of it never reaches the provider.
    if (typeof first === "string" && first.length <= RECONNECT_MESSAGE_MAX && first.startsWith(RELAY_MESSAGE_PREFIX)) {
      try {
        const message = /** @type {{ type?: unknown, secret?: unknown }} */ (JSON.parse(first));
        secret = message?.type === "agw.reconnect" ? message.secret : undefined;
      } catch {
        secret = undefined;
      }
    }
    // The session ending, ended or past its time: the client needs a new one. Only a failed
    // proof on a live session gets `session_active`, the refusal any second connection gets.
    const gone = () => this.live !== live || this.core.call === null || this.core.ending !== null || Date.now() >= live.deadline;
    const refuse = () => {
      socket.removeEventListener("message", onMessage);
      closeQuietly(socket, 4000, gone() ? "session_ended" : "session_active");
    };
    if (gone() || !(await this.core.mayReattach(secret))) return refuse();
    /** @type {import("./start.js").Client} */
    const owner = { close: (code, reason) => closeQuietly(socket, code, reason) };
    if (closed || gone() || !this.core.reattach(owner)) return refuse();
    const old = live.client;
    live.client = socket;
    live.owner = owner;
    live.frames.reattached();
    this.listen(live, socket, owner);
    handedOver = true;
    socket.removeEventListener("message", onMessage);
    // The old link, if it still looks open, is let go: its close changes nothing now.
    if (old !== null) closeQuietly(old, 1000, "reconnected");
    console.log(JSON.stringify({ level: "info", message: "relay_client_reattached", held: live.held.frames.length }));
    sendQuietly(socket, JSON.stringify({ type: "agw.session.resumed", deadline: live.deadline }));
    for (const data of live.held.drain()) this.deliver(live, data);
    // What the SDK sent right after its secret goes on, in order, before anything newer.
    for (const data of inbox.slice(1)) this.fromClient(live, data);
  }

  /**
   * A frame from the client: forwarded at once, or held while the session
   * starts. The relay's own messages are answered here and never forwarded.
   * @param {Live} live
   * @param {string | ArrayBuffer} data
   */
  fromClient(live, data) {
    if (live.client === null) return;
    const verdict = live.frames.fromClient(data);
    if (verdict.kind === "forward") {
      if (live.call === null) {
        if (!live.queue.push(data)) this.endFor(live, "error", 4000, "start_queue_full");
        return;
      }
      this.toProvider(live, data);
    } else if (verdict.kind === "answer") {
      sendQuietly(/** @type {WebSocket} */ (live.client), verdict.message);
    } else if (verdict.kind === "end") {
      if (verdict.closeCode !== undefined) this.endFor(live, verdict.reason, verdict.closeCode, verdict.closeReason ?? verdict.reason);
      // No code of its own (a client too slow): the session's end closes the client, with the code its reason has.
      else if (this.core.owner === live.owner) void this.core.end(verdict.reason);
    }
  }

  /**
   * A client frame to the provider, past the deadline check: live frames and
   * the ones held during the start go through here alike.
   * @param {Live} live
   * @param {string | ArrayBuffer} data
   */
  toProvider(live, data) {
    if (Date.now() >= live.deadline) return void this.core.end("time_cap");
    // The session is closing: nothing new goes to the provider while its last answer finishes.
    if (this.core.ending !== null) return;
    // The adapter's own lock (ElevenLabs': a client's credentials out, a binary frame dropped; an agent's
    // overrides refused), then the model lock, for a provider whose client may name another model
    // mid-session (OpenAI's `session.update`).
    let locked = live.adapter.lock === undefined ? data : live.adapter.lock(data, { userId: live.providerUser });
    if (locked === null) return;
    if (typeof locked !== "object" || locked instanceof ArrayBuffer) locked = live.call?.meter?.lock(locked) ?? locked;
    // A frame a lock refuses (GPT-Live's backend rules, an agent's overrides): the session ends, and the client is told why.
    if (typeof locked === "object" && !(locked instanceof ArrayBuffer)) {
      this.core.log({ level: "warn", message: "relay_frame_refused", session: this.core.sessionId, code: locked.refused });
      return void this.endFor(live, "error", 1008, locked.refused);
    }
    data = locked;
    live.call?.send(data);
    // Read after it went out (plan 5.2): a provider that bills by its own clock starts it at the
    // first activity, and bills each text message (xAI); one that bills the client's text counts it
    // (ElevenLabs). Nothing else is read here.
    const kind = live.adapter.client?.(data, live.clientState) ?? null;
    if (kind === "activity" && this.core.idle) void this.core.activity().catch(() => undefined);
    else if (kind === "text") void this.core.countText().catch(() => undefined);
    else if (typeof kind === "object" && kind !== null) void this.core.count(kind.counts).catch(() => undefined);
  }

  /**
   * A provider frame's usage, journaled in its own write (plan 5.2), or null when it has none.
   * @param {import("./adapters.js").Adapter} adapter
   * @param {string | ArrayBuffer} data
   * @param {import("./adapters.js").CallMeter | null} [meter] the call's own memory: an event's model, if not the session's
   * @param {() => void} [written] runs once the usage is written (`SessionCore.recordUsage`)
   * @returns {Promise<void> | null}
   */
  readUsage(adapter, data, meter = null, written = undefined) {
    const read = adapter.read(data);
    const event = read === null || meter === null ? read : meter.label(read);
    return event === null ? null : this.core.recordUsage(event, adapter.shape, written).catch(() => undefined);
  }

  /**
   * The provider finished an answer: `settle` marks it so, then the closing wait is told. When
   * the same frame carried its usage (OpenAI's `response.done`), both wait for that usage's
   * write, so an end that starts meanwhile still waits for it, and the final slice has it (plan 5.1).
   * By then a newer answer may have opened: `current` says whether this one is still the latest,
   * and only then is anything closed (Gemini Neon, #266 round 1).
   * @param {Promise<void> | null} recorded
   * @param {() => boolean} current
   * @param {() => void} settle
   */
  answerDone(recorded, current, settle) {
    const done = () => {
      if (!current()) return;
      settle();
      this.core.turnDone();
    };
    if (recorded === null) done();
    else void recorded.then(done);
  }

  /**
   * A frame from the provider: forwarded first, then counted (plan 5.2). The
   * deadline is the copy in memory: no storage read on the audio path.
   * @param {Live} live
   * @param {string | ArrayBuffer} data
   * @returns {boolean} whether the frame went to the client, or waits for it: not past the deadline or while closing
   */
  toClient(live, data) {
    // Past the deadline, or closing: the client gets nothing more, but the frame is still read,
    // so the last answer's usage counts while the end waits for it (plan 5.1).
    const late = Date.now() >= live.deadline;
    let overflowed = false;
    if (!late && this.core.ending === null) {
      if (live.client !== null) this.deliver(live, data);
      // Our SDK's link is down: the frame waits for it, bounded (the adapter's rule). Too much,
      // and the session ends below: nothing more could reach the client in order.
      else overflowed = !live.held.push(data);
    }
    const forwarded = !late && this.core.ending === null && !overflowed;
    // What the call remembers (OpenAI's format and transcription model, the answer's audio), after the frame went out.
    const meter = live.call?.meter ?? null;
    const finished = meter === null ? null : meter.see(data, forwarded);
    // An answer or transcription the frame finished counts as open until its usage is written: settled
    // as soon as the write is done, before the end judges what is cut. Once nothing is open, a closing
    // session waits no more.
    const settle =
      meter === null || finished === null
        ? undefined
        : () => {
            meter.settled(finished);
            if (!meter.pending()) this.core.turnDone();
          };
    // Usage is read after the frame went out, and journaled in its own write (plan 5.2).
    const recorded = this.readUsage(live.adapter, data, meter, settle);
    if (recorded === null) settle?.();
    const turn = live.adapter.turn(data);
    // Gemini says "open" on each of an answer's audio chunks: each counts as the answer opening again,
    // which changes nothing, since its "done" comes after its last chunk.
    if (turn === "open") {
      live.turnOpen = true;
      live.turns += 1;
      // An answer is activity too: a provider that bills by its own clock has started it (xAI).
      if (this.core.idle) void this.core.activity().catch(() => undefined);
    } else if (turn === "done") {
      const answer = live.turns;
      this.answerDone(
        recorded,
        () => live.turns === answer,
        () => {
          live.turnOpen = false;
        },
      );
    }
    // Ended only after the frame was read, so its usage counts.
    if (overflowed) {
      console.log(JSON.stringify({ level: "warn", message: "relay_reconnect_buffer_full" }));
      void this.core.end("client_closed");
    }
    if (late) void this.core.end("time_cap");
    return forwarded;
  }

  /**
   * The provider call is closed: frames held for a client that might have come back are let go,
   * so they don't stay in memory until the object is evicted.
   * @param {RelayCall} call
   */
  dropHeld(call) {
    if (this.live?.call === call) this.live.held.drain();
  }

  /**
   * A provider frame to the session's client, counted for the received-byte reports.
   * @param {Live} live
   * @param {string | ArrayBuffer} data
   */
  deliver(live, data) {
    if (live.client === null) return;
    sendQuietly(live.client, data);
    live.frames.toClient(data, live.adapter.keepalive?.(data) === true);
  }

  /**
   * Ends the session with a close code of its own for the client: the client
   * is told first, then the core ends the session with the reason.
   * @param {Live} live
   * @param {string} reason
   * @param {number} code
   * @param {string} closeReason
   */
  endFor(live, reason, code, closeReason) {
    if (live.client !== null) closeQuietly(live.client, code, closeReason);
    // Only the session's own connection may end it: a turned-away one changes nothing.
    if (this.core.owner === live.owner) void this.core.end(reason);
  }

  /** @override */
  async alarm() {
    await this.core.alarm();
  }
}

/** The HTTP status an observed start's refusal gets, by its code; anything else is a 503. */
const START_STATUS = /** @type {Record<string, number>} */ ({
  ticket_refused: 401,
  ticket_expired: 401,
  session_active: 409,
  start_in_flight: 409,
  session_ended: 409,
  provider_unavailable: 502,
});

/** The largest offer the relay reads: a real SDP offer is a few KB. */
const MAX_OFFER_BYTES = 64 * 1024;

/**
 * The request's offer, in either form OpenAI takes at `…/realtime/calls`: the SDP alone, or a
 * `multipart/form-data` body with `sdp` and `session` (the session's settings, a JSON object). Read whole,
 * as any message that can change settings is (plan 5.1). A status instead: 413 when it is larger than
 * `MAX_OFFER_BYTES`, 400 when a form has no `sdp` or a `session` that is not a JSON object.
 * @param {Request} request
 * @returns {Promise<import("./start.js").Offer | 400 | 413>}
 */
async function readOffer(request) {
  const bytes = await readBody(request);
  if (bytes === null) return 413;
  const type = request.headers.get("content-type") ?? "";
  // The media type without its parameters: a form with no boundary is a form, which the parser refuses.
  if ((type.split(";")[0] ?? "").trim().toLowerCase() !== "multipart/form-data") return { sdp: new TextDecoder().decode(bytes), session: {} };
  /** @type {FormData} */
  let form;
  try {
    form = await new Response(bytes, { headers: { "content-type": type } }).formData();
  } catch {
    return 400;
  }
  const sdp = form.get("sdp");
  const settings = form.get("session");
  if (typeof sdp !== "string") return 400;
  if (settings === null) return { sdp, session: {} };
  if (typeof settings !== "string") return 400;
  try {
    const session = JSON.parse(settings);
    if (typeof session !== "object" || session === null || Array.isArray(session)) return 400;
    return { sdp, session };
  } catch {
    return 400;
  }
}

/** The request's body, or null when it is larger than `MAX_OFFER_BYTES`. @param {Request} request */
async function readBody(request) {
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_OFFER_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** Sends to a socket that may be closed already. @param {WebSocket} socket @param {string | ArrayBuffer} data */
function sendQuietly(socket, data) {
  try {
    socket.send(data);
  } catch {
    // Closed: the session's end is under way.
  }
}

/** Closes a socket that may be closed already. @param {WebSocket} socket @param {number} code @param {string} reason */
function closeQuietly(socket, code, reason) {
  try {
    socket.close(code, reason);
  } catch {
    // Already closed: nothing to do.
  }
}

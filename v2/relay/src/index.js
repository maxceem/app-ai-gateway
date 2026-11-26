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
 * The object then forwards frames both ways (`./frames.js`). The journal and
 * checkpoints come in step 9a part 2, and observed mode in part 3.
 */
import { DurableObject } from "cloudflare:workers";
import { HEALTH_PATH, SESSION_PATH } from "./constants.js";
import { RELAY_MESSAGES_HEADER, SessionFrames, START_QUEUE_FRAMES } from "./frames.js";
import { connectProvider } from "./provider.js";
import { SessionCore } from "./start.js";
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
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return refusal(426, "websocket_required");
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
    if (ticket.mode !== "relayed") return refusal(501, "mode_not_served");
    return env.SESSION.get(env.SESSION.idFromName(ticket.sid)).fetch(request);
  },
};

/**
 * @typedef {import("./start.js").ProviderCall & {
 *   send(data: string | ArrayBuffer): void,
 *   forward: ((data: string | ArrayBuffer) => void) | null,
 *   pending: (string | ArrayBuffer)[],
 * }} RelayCall
 * The provider's side of a relayed session. Its frames wait in `pending` until
 * the session is started, then go through `forward`.
 *
 * @typedef {{
 *   client: WebSocket,
 *   owner: import("./start.js").Client,
 *   frames: SessionFrames,
 *   call: RelayCall | null,
 *   deadline: number,
 *   queue: (string | ArrayBuffer)[],
 * }} Live
 * One client's session in this instance. Client frames wait in `queue` while
 * the session starts, then go to the provider in order.
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
    this.core = new SessionCore({
      store: {
        get: (keys) => storage.get(keys),
        put: async (entries, alarmAt) => {
          // One write: workerd commits these together, as nothing is awaited between them.
          const writes = [storage.put(entries)];
          if (alarmAt !== null) writes.push(storage.setAlarm(alarmAt));
          await Promise.all(writes);
        },
        // With this compatibility date, deleteAll() removes the alarm too.
        deleteAll: () => storage.deleteAll(),
      },
      vault: env.VAULT,
      main: env.MAIN,
      provider: {
        connect: async (key) => {
          const { callId, socket } = await connectProvider(key);
          /** @type {RelayCall} */
          const call = {
            callId,
            close: (code, reason) => closeQuietly(socket, code, reason),
            send: (data) => sendQuietly(socket, data),
            forward: null,
            pending: [],
          };
          // Frames that come before the session started (OpenAI sends `session.created` at
          // once) wait, in order, and go to the client once it is started.
          socket.addEventListener("message", (event) => {
            if (call.forward !== null) call.forward(event.data);
            else if (call.pending.length < START_QUEUE_FRAMES) call.pending.push(event.data);
            else call.close?.(1011, "start_queue_full");
          });
          // The provider hung up first: the session ends, and the client is told. A close the
          // relay caused itself, after letting go of this call, is ignored (`providerGone`).
          socket.addEventListener("close", () => void this.core.providerGone(call));
          return call;
        },
      },
      // The tick's checks for the session this instance runs: none after a restart.
      liveness: (now) => this.live?.frames.check(now) ?? null,
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
    const relayMessages = request.headers.get(RELAY_MESSAGES_HEADER) === "1";
    const [client, server] = Object.values(new WebSocketPair());
    if (!client || !server) throw new Error("no WebSocket pair");
    server.accept();
    this.ctx.waitUntil(this.begin(server, ticketText, parsed.payload, relayMessages));
    return new Response(null, { status: 101, webSocket: client });
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
    const live = { client, owner, frames: new SessionFrames({ relayMessages }), call: null, deadline: Infinity, queue: [] };
    // Listened to before the start: a client that hangs up during it stops it, and its frames wait.
    client.addEventListener("close", () => void this.core.clientGone(owner));
    client.addEventListener("message", (event) => this.fromClient(live, event.data));
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
      return;
    }
    const call = /** @type {RelayCall} */ (result.call);
    live.call = call;
    live.deadline = result.deadline;
    this.live = live;
    if (relayMessages) sendQuietly(client, JSON.stringify({ type: "agw.session.started", reconnect_secret: result.reconnectSecret, deadline: result.deadline }));
    // In order: what the provider sent during the start, then what the client did.
    call.forward = (data) => this.toClient(live, data);
    for (const data of call.pending.splice(0)) call.forward(data);
    for (const data of live.queue.splice(0)) call.send(data);
  }

  /**
   * A frame from the client: forwarded at once, or held while the session
   * starts. The relay's own messages are answered here and never forwarded.
   * @param {Live} live
   * @param {string | ArrayBuffer} data
   */
  fromClient(live, data) {
    const verdict = live.frames.fromClient(data);
    if (verdict.kind === "forward") {
      if (live.call === null) {
        if (live.queue.length < START_QUEUE_FRAMES) live.queue.push(data);
        else this.endFor(live, "error", 4000, "start_queue_full");
        return;
      }
      if (Date.now() >= live.deadline) return void this.core.end("time_cap");
      live.call.send(data);
    } else if (verdict.kind === "answer") {
      sendQuietly(live.client, verdict.message);
    } else if (verdict.kind === "end") {
      this.endFor(live, verdict.reason, verdict.closeCode, verdict.closeReason);
    }
  }

  /**
   * A frame from the provider: forwarded first, then counted (plan 5.2). The
   * deadline is the copy in memory: no storage read on the audio path.
   * @param {Live} live
   * @param {string | ArrayBuffer} data
   */
  toClient(live, data) {
    if (Date.now() >= live.deadline) return void this.core.end("time_cap");
    sendQuietly(live.client, data);
    live.frames.toClient(data);
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
    closeQuietly(live.client, code, closeReason);
    void this.core.end(reason);
  }

  /** @override */
  async alarm() {
    await this.core.alarm();
  }
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

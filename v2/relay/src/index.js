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
 * Forwarding frames comes next (step 9a part 1, fourth review), the journal and
 * checkpoints after it (part 2), and observed mode in part 3.
 */
import { DurableObject } from "cloudflare:workers";
import { HEALTH_PATH, SESSION_PATH } from "./constants.js";
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
 * One session: its start, its end, and its alarm. The client's WebSocket is
 * answered at once; the start runs after, and its result goes to the client
 * as a message (the reconnect secret) or a close with a code. The session's
 * core (`./start.js`) owns the client's socket and closes it when it ends.
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
          /** @type {import("./start.js").ProviderCall} */
          const call = { callId, close: (code, reason) => socket.close(code, reason) };
          // The provider hung up first: the session ends, and the client is told. A close the
          // relay caused itself, after letting go of this call, is ignored (`providerGone`).
          socket.addEventListener("close", () => void this.core.providerGone(call));
          return call;
        },
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
    const [client, server] = Object.values(new WebSocketPair());
    if (!client || !server) throw new Error("no WebSocket pair");
    server.accept();
    this.ctx.waitUntil(this.begin(server, ticketText, parsed.payload));
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * A second connection while a start is in flight is refused by the core
   * (`start_in_flight`, row 8), and its close changes nothing.
   * @param {WebSocket} client
   * @param {string} ticketText
   * @param {import("./ticket.js").Ticket} ticket
   */
  async begin(client, ticketText, ticket) {
    // Listened to before the start: a client that hangs up during it stops it.
    client.addEventListener("close", () => void this.core.clientGone(client));
    /** @type {Awaited<ReturnType<SessionCore["start"]>>} */
    let result;
    try {
      result = await this.core.start(ticketText, ticket, client);
    } catch {
      // The core has hung up any provider call; the client is told, and the session ends if it got that far.
      console.log(JSON.stringify({ level: "error", message: "relay_start_failed", session: ticket.sid }));
      closeQuietly(client, 1011, "internal_error");
      // Only a start that owned the session may end it: a second connection's failure never does.
      if (this.core.startedBy(client)) await this.core.end("error").catch(() => undefined);
      return;
    }
    if (!result.ok) {
      closeQuietly(client, 4000, result.code);
      return;
    }
    client.send(JSON.stringify({ type: "agw.session.started", reconnect_secret: result.reconnectSecret, deadline: result.deadline }));
  }

  /** @override */
  async alarm() {
    await this.core.alarm();
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

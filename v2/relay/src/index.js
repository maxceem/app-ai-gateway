// @ts-check
/**
 * The relay Worker: live sessions between an app and a provider (plan step 9).
 * Plain JavaScript with no npm packages, uploaded as it is. It imports nothing
 * from the gateway Worker (plan section 5.2), and a test checks that.
 *
 * For now its session object only echoes WebSocket frames, so the deploy, the
 * binding to the gateway and the code-update setting can be tested before any
 * session logic exists. Tickets, `open`, `close` and forwarding come next.
 */
import { DurableObject } from "cloudflare:workers";

/** The paths this Worker answers. Everything else is a 404. */
export const HEALTH_PATH = "/v2/relay/healthz";
export const ECHO_PATH = "/v2/relay/echo";

/** An echo frame larger than this closes the socket. */
export const MAX_ECHO_FRAME_BYTES = 64 * 1024;

/** An echo session ends by itself after this long. */
export const ECHO_LIFETIME_MS = 60_000;

/**
 * @typedef {object} RelayEnv
 * @property {DurableObjectNamespace<Session>} SESSION
 * @property {Fetcher} MAIN the gateway Worker
 */

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
    if (pathname === ECHO_PATH) {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return Response.json({ error: { code: "websocket_required" } }, { status: 426 });
      }
      return env.SESSION.get(env.SESSION.newUniqueId()).fetch(request);
    }
    return Response.json({ error: { code: "not_found" } }, { status: 404 });
  },
};

/**
 * One session. For now: an echo that sends every frame back and ends after
 * `ECHO_LIFETIME_MS`. It uses the hibernation API, so an idle echo costs
 * nothing.
 *
 * @extends {DurableObject<RelayEnv>}
 */
export class Session extends DurableObject {
  /**
   * @override
   * @param {Request} _request
   */
  async fetch(_request) {
    const [client, server] = Object.values(new WebSocketPair());
    if (!client || !server) throw new Error("no WebSocket pair");
    this.ctx.acceptWebSocket(server);
    await this.ctx.storage.setAlarm(Date.now() + ECHO_LIFETIME_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * @override
   * @param {WebSocket} ws
   * @param {string | ArrayBuffer} message
   */
  webSocketMessage(ws, message) {
    const size = typeof message === "string" ? new TextEncoder().encode(message).byteLength : message.byteLength;
    if (size > MAX_ECHO_FRAME_BYTES) {
      ws.close(1009, "frame too large");
      return;
    }
    ws.send(message);
  }

  /**
   * @override
   * @param {WebSocket} ws
   * @param {number} code
   */
  webSocketClose(ws, code) {
    // 1005 and 1006 can't be sent back; close normally instead.
    ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
  }

  /** @override */
  async alarm() {
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, "echo ended");
    await this.ctx.storage.deleteAll();
  }
}

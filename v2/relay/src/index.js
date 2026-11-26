// @ts-check
/**
 * The relay Worker: live sessions between an app and a provider (plan step 9).
 * Plain JavaScript with no npm packages, uploaded as it is. It imports nothing
 * from the gateway Worker (plan section 5.2), and a test checks that.
 *
 * For now its session object only echoes WebSocket frames, so the deploy, the
 * binding to the gateway and the code-update setting can be tested before any
 * session logic exists. The echo is off unless the deployment sets
 * `RELAY_ECHO` to "1", which only a test deployment does; the tracked config
 * never sets it. Tickets, `open`, `close` and forwarding come next.
 */
import { DurableObject } from "cloudflare:workers";
import { ECHO_LIFETIME_MS, ECHO_PATH, HEALTH_PATH, MAX_ECHO_FRAME_BYTES } from "./constants.js";

/**
 * @typedef {object} RelayEnv
 * @property {DurableObjectNamespace<Session>} SESSION
 * @property {Fetcher} MAIN the gateway Worker
 * @property {string} [RELAY_ECHO] "1" on a test deployment only: turns the echo on
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
    // Checked before any session object is created: off, the echo is a 404 like any other path.
    if (pathname === ECHO_PATH && env.RELAY_ECHO === "1") {
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

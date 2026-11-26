// @ts-check
/**
 * The provider connection for a relayed session: the key the vault opened,
 * sent only to the address the vault named (`target`), never one that `open`
 * or the client names (crash table, "Who keeps what").
 */
import { PROVIDER_CONNECT_TIMEOUT_MS } from "./constants.js";
import { ProviderRefused } from "./start.js";

/**
 * Connects to the provider. A refusal with an answer is known; a throw or a
 * timeout is an unknown outcome (`./start.js`).
 * @param {import("./start.js").SessionKey} key
 * @param {typeof fetch} [send] for the tests
 * @returns {Promise<{ callId: string | null, socket: WebSocket }>}
 */
export async function connectProvider(key, send = fetch) {
  const headers = new Headers({ upgrade: "websocket" });
  // A callback, so a key with `$&` goes as it is.
  if (key.key !== undefined) headers.set(key.key.header, key.key.format.replace("{key}", () => /** @type {NonNullable<typeof key.key>} */ (key.key).value));
  if (key.cloudflareToken !== undefined) headers.set("cf-aig-authorization", `Bearer ${key.cloudflareToken}`);
  const response = await send(key.target, { headers, redirect: "manual", signal: AbortSignal.timeout(PROVIDER_CONNECT_TIMEOUT_MS) });
  const socket = response.webSocket;
  if (response.status !== 101 || socket === null) {
    await response.body?.cancel();
    throw new ProviderRefused(response.status);
  }
  socket.accept();
  return { callId: null, socket };
}

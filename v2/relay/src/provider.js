// @ts-check
/**
 * The provider connection for a relayed session: the key the vault opened,
 * sent only to the address the vault named (`target`), never one that `open`
 * or the client names (crash table, "Who keeps what").
 */
import { PROVIDER_CONNECT_TIMEOUT_MS } from "./constants.js";
import { ProviderRefused } from "./start.js";

/** Waits `ms`; the tests give their own. @param {number} ms */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Connects to the provider. A refusal with an answer is known; a throw or a
 * timeout is an unknown outcome (`./start.js`).
 *
 * The time limit covers only the handshake. A signal handed to `fetch` stays
 * tied to the WebSocket it opens, so `AbortSignal.timeout` would cut every
 * session at the limit (T12, first run: sessions ended at 15 s). Here the
 * signal is aborted only if the handshake itself is late.
 * @param {import("./start.js").SessionKey} key
 * @param {typeof fetch} [send] for the tests
 * @param {(ms: number) => Promise<unknown>} [timeout] for the tests
 * @returns {Promise<{ callId: string | null, socket: WebSocket }>}
 */
export async function connectProvider(key, send = fetch, timeout = wait) {
  const headers = new Headers({ upgrade: "websocket" });
  // A callback, so a key with `$&` goes as it is.
  if (key.key !== undefined) headers.set(key.key.header, key.key.format.replace("{key}", () => /** @type {NonNullable<typeof key.key>} */ (key.key).value));
  if (key.cloudflareToken !== undefined) headers.set("cf-aig-authorization", `Bearer ${key.cloudflareToken}`);
  const handshake = new AbortController();
  let answered = false;
  void timeout(PROVIDER_CONNECT_TIMEOUT_MS).then(() => {
    if (!answered) handshake.abort(new Error("provider_connect_timeout"));
  });
  /** @type {Response} */
  let response;
  try {
    response = await send(key.target, { headers, redirect: "manual", signal: handshake.signal });
  } finally {
    answered = true;
  }
  const socket = response.webSocket;
  if (response.status !== 101 || socket === null) {
    await response.body?.cancel();
    throw new ProviderRefused(response.status);
  }
  socket.accept();
  return { callId: null, socket };
}

// @ts-check
/**
 * The provider connections: a relayed session's WebSocket, and an observed
 * call's creation, side channel and hang-up. The key the vault opened is sent
 * only to the address the vault named (`target`), never one that `open` or the
 * client names (crash table, "Who keeps what").
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
 * @param {number} [limitMs] a shorter limit than `PROVIDER_CONNECT_TIMEOUT_MS`, such as the time left before a deadline
 * @param {string} [callIdHeader] the answer's header that names the call (Deepgram's `dg-request-id`): its value is the call id
 * @returns {Promise<{ callId: string | null, socket: WebSocket }>}
 */
export async function connectProvider(key, send = fetch, timeout = wait, limitMs = PROVIDER_CONNECT_TIMEOUT_MS, callIdHeader = undefined) {
  const headers = keyHeaders(key, { upgrade: "websocket" });
  const handshake = new AbortController();
  let answered = false;
  void timeout(Math.min(PROVIDER_CONNECT_TIMEOUT_MS, limitMs)).then(() => {
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
  // Binary frames as `ArrayBuffer`, not `Blob`: sizes and forwarding need the bytes at hand.
  socket.binaryType = "arraybuffer";
  socket.accept();
  // Only a plain id is kept: the gateway stores it and looks the call up by it.
  const named = callIdHeader === undefined ? null : response.headers.get(callIdHeader);
  return { callId: named !== null && CALL_ID.test(named) ? named : null, socket };
}

/** A provider's call id as the gateway keeps it: a plain id, never anything else. */
const CALL_ID = /^[A-Za-z0-9_.:-]{1,200}$/u;

/**
 * Where a session that starts through a signed URL connects (ElevenLabs agents, 11a), and the conversation
 * it names (`conversation_id`), or null when the URL is not on the address the key is sealed for: the same
 * origin and path, no user part. `open` named it, so it is checked here like any address `open` names
 * (crash table, "Who keeps what"). Its own query (the signature) is kept; no key goes with it.
 * @param {string} target the address the vault named
 * @param {string} signedUrl
 * @returns {{ target: string, callId: string | null } | null}
 */
export function signedSession(target, signedUrl) {
  /** @type {URL} */
  let signed;
  /** @type {URL} */
  let sealed;
  try {
    signed = new URL(signedUrl);
    sealed = new URL(target);
  } catch {
    return null;
  }
  if (signed.protocol === "wss:") signed.protocol = "https:";
  else if (signed.protocol === "ws:") signed.protocol = "http:";
  if (signed.username !== "" || signed.password !== "" || signed.origin !== sealed.origin || signed.pathname !== sealed.pathname) return null;
  const named = signed.searchParams.get("conversation_id");
  return { target: signed.toString(), callId: named !== null && CALL_ID.test(named) ? named : null };
}

/**
 * The provider headers that carry the session's key: the key in its own
 * header, and a Cloudflare AI Gateway token when the connection has one.
 * @param {import("./start.js").SessionKey} key
 * @param {Record<string, string>} [extra]
 */
function keyHeaders(key, extra = {}) {
  const headers = new Headers(extra);
  // A callback, so a key with `$&` goes as it is.
  if (key.key !== undefined) headers.set(key.key.header, key.key.format.replace("{key}", () => /** @type {NonNullable<typeof key.key>} */ (key.key).value));
  if (key.cloudflareToken !== undefined) headers.set("cf-aig-authorization", `Bearer ${key.cloudflareToken}`);
  return headers;
}

/**
 * Where an observed call's side channel and hang-up go, from the one address
 * the vault named (`target`, the call-creating path, `…/realtime/calls`): the
 * same host and the same base, never one the app or `open` names (crash table,
 * "Who keeps what"). OpenAI's shape (plan step 12), which the mock follows:
 * the side channel at `…/realtime?call_id=…`, the hang-up at `…/calls/{id}/hangup`.
 * @param {string} target
 * @param {string} callId
 */
export function observedUrls(target, callId) {
  const calls = new URL(target);
  calls.search = "";
  calls.hash = "";
  const base = calls.pathname.replace(/\/+$/u, "");
  const side = new URL(calls);
  side.pathname = base.replace(/\/calls$/u, "");
  side.searchParams.set("call_id", callId);
  const hangup = new URL(calls);
  hangup.pathname = `${base}/${encodeURIComponent(callId)}/hangup`;
  return { side: side.toString(), hangup: hangup.toString() };
}

/**
 * Creates an observed call from the app's offer (plan 4.3 step 4): the
 * provider answers with its own answer and the call's id (`Location`). A
 * refusal with an answer is known; a throw or a timeout is an unknown
 * outcome, never retried (`./start.js`).
 * @param {import("./start.js").SessionKey} key
 * @param {string} offer
 * @param {typeof fetch} [send]
 * @param {(ms: number) => Promise<unknown>} [timeout]
 * @returns {Promise<{ callId: string, answer: string }>}
 */
export async function createObservedCall(key, offer, send = fetch, timeout = wait) {
  const handshake = new AbortController();
  let answered = false;
  void timeout(PROVIDER_CONNECT_TIMEOUT_MS).then(() => {
    if (!answered) handshake.abort(new Error("provider_connect_timeout"));
  });
  // The limit covers the answer's body too: a provider that stalls in it never leaves the app's POST waiting.
  try {
    const response = await send(key.target, { method: "POST", headers: keyHeaders(key, { "content-type": "application/sdp" }), body: offer, redirect: "manual", signal: handshake.signal });
    const location = response.headers.get("location") ?? "";
    const callId = decodeURIComponent(location.split("/").filter((part) => part !== "").pop() ?? "");
    if ((response.status !== 200 && response.status !== 201) || !/^[A-Za-z0-9_.-]{1,200}$/u.test(callId)) {
      await response.body?.cancel();
      // A success without a call id can't be followed: the call, if any, ends by itself (crash table row 11).
      throw new ProviderRefused(response.status);
    }
    return { callId, answer: await response.text() };
  } finally {
    answered = true;
  }
}

/**
 * Attaches the side channel of an observed call (plan section 5): a refusal
 * carries its status (404: the call ended; 503: unknown, the call is kept).
 * @param {import("./start.js").SessionKey} key
 * @param {string} callId
 * @param {number} limitMs the longest wait: the time left before the session's deadline
 * @param {typeof fetch} [send]
 * @param {(ms: number) => Promise<unknown>} [timeout]
 * @returns {Promise<WebSocket>}
 */
export async function attachSideChannel(key, callId, limitMs, send = fetch, timeout = wait) {
  const { side } = observedUrls(key.target, callId);
  const { socket } = await connectProvider({ ...key, target: side }, send, timeout, limitMs);
  return socket;
}

/** How long a hang-up may take: it is retried on the next wakeup (`./start.js`). */
const HANGUP_TIMEOUT_MS = 5_000;

/**
 * Hangs up an observed call. A 404 means it already ended, which is a success.
 * @param {import("./start.js").SessionKey} key
 * @param {string} callId
 * @param {typeof fetch} [send]
 */
export async function hangUpObservedCall(key, callId, send = fetch) {
  const { hangup } = observedUrls(key.target, callId);
  const response = await send(hangup, { method: "POST", headers: keyHeaders(key), redirect: "manual", signal: AbortSignal.timeout(HANGUP_TIMEOUT_MS) });
  await response.body?.cancel();
  if (response.status !== 404 && (response.status < 200 || response.status > 299)) throw new ProviderRefused(response.status);
}

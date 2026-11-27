// @ts-check
/**
 * A stand-in for an observed (WebRTC) call, for the relay's tests
 * (`./provider-stub.js`; step 9a part 3). It follows the shape of OpenAI's
 * calls, which the relay's observed mode will use (plan step 12), with no media:
 *
 * - `POST …/realtime/calls` with the app's offer creates a call: `201`, the
 *   call's path in `Location`, and an answer as the body;
 * - a WebSocket to `…/realtime?call_id=…` attaches its side channel: `101`
 *   while the call runs; `404` for a minute after it ended, then `503` (T18);
 * - `POST …/realtime/calls/{id}/hangup` hangs it up: `200`.
 *
 * It keeps no state: what a call does is written in its id, from lines in the
 * offer, `a=x-mock-<name>:<value>` (seconds, decimals allowed):
 * - `ends:S`: the call ends S seconds after it was made, and its side channel closes then;
 * - `drop:S`: each side channel closes S seconds after it attached; the call goes on;
 * - `down:A-B`: an attach between A and B seconds after the call was made gets `503`;
 * - `turns:S`: every S seconds, the attached side channel reports an answer:
 *   `response.created`, a `mock.usage` event of 100 input and 20 output
 *   tokens, then `response.done`. Each answer's event id is the call's id and
 *   its number, so one answer is never counted twice, whichever side channel
 *   reported it.
 */

/**
 * An option's value, and the second one of a range: 0 when unset.
 * @param {string} offer
 * @param {string} name
 * @returns {[number, number]}
 */
function option(offer, name) {
  const match = new RegExp(`^a=x-mock-${name}:([0-9.]+)(?:-([0-9.]+))?\\s*$`, "mu").exec(offer);
  return match === null ? [0, 0] : [Number(match[1]) || 0, Number(match[2]) || 0];
}

/**
 * A call's id, with what it does: `rtc_mock_<made>_<ends>_<drop>_<downFrom>_<downTo>_<turns>_<random>`,
 * times in milliseconds (0: never).
 * @param {string} offer
 * @param {number} now
 */
function newCallId(offer, now) {
  const ms = (/** @type {number} */ seconds) => Math.round(seconds * 1000);
  const [ends] = option(offer, "ends");
  const [drop] = option(offer, "drop");
  const [downFrom, downTo] = option(offer, "down");
  const [turns] = option(offer, "turns");
  const random = crypto.randomUUID().slice(0, 8);
  return `rtc_mock_${now}_${ms(ends)}_${ms(drop)}_${ms(downFrom)}_${ms(downTo)}_${ms(turns)}_${random}`;
}

/** @param {string} id */
function readCallId(id) {
  const match = /^rtc_mock_(\d+)_(\d+)_(\d+)_(\d+)_(\d+)_(\d+)_[0-9a-f]{8}$/u.exec(id);
  if (match === null) return null;
  const [made, ends, drop, downFrom, downTo, turns] = match.slice(1).map(Number);
  return { made: /** @type {number} */ (made), ends: /** @type {number} */ (ends), drop: /** @type {number} */ (drop), downFrom: /** @type {number} */ (downFrom), downTo: /** @type {number} */ (downTo), turns: /** @type {number} */ (turns) };
}

/** How long a reattach to an ended call gets `404` before it gets `503` (T18: about a minute). */
const ENDED_404_MS = 60_000;

/**
 * The mock's answer for an observed call, or null when the request is not one.
 * @param {Request} request
 * @returns {Promise<Response | null>}
 */
export async function observedCall(request) {
  const url = new URL(request.url);
  const now = Date.now();
  if (request.method === "POST" && /\/realtime\/calls\/?$/u.test(url.pathname)) {
    const offer = await request.text();
    if (!offer.startsWith("v=")) return Response.json({ error: { message: "The offer is not SDP" } }, { status: 400 });
    const id = newCallId(offer, now);
    return new Response(`v=0\r\no=mock 1 1 IN IP4 0.0.0.0\r\ns=mock answer\r\nt=0 0\r\n`, {
      status: 201,
      headers: { location: `/v1/realtime/calls/${id}`, "content-type": "application/sdp" },
    });
  }
  const hangup = /\/realtime\/calls\/([^/]+)\/hangup$/u.exec(url.pathname);
  if (request.method === "POST" && hangup !== null) return readCallId(decodeURIComponent(hangup[1] ?? "")) === null ? new Response(null, { status: 404 }) : new Response(null, { status: 200 });
  const callId = url.searchParams.get("call_id");
  if (callId === null || !url.pathname.endsWith("/realtime") || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return null;
  const call = readCallId(callId);
  if (call === null) return new Response(null, { status: 503 });
  const age = now - call.made;
  if (call.ends > 0 && age >= call.ends) return new Response(null, { status: age < call.ends + ENDED_404_MS ? 404 : 503 });
  if (call.downTo > 0 && age >= call.downFrom && age < call.downTo) return new Response(null, { status: 503 });
  return sideChannel(callId, call, now);
}

/**
 * @param {string} callId
 * @param {NonNullable<ReturnType<typeof readCallId>>} call
 * @param {number} now
 */
function sideChannel(callId, call, now) {
  const [client, server] = Object.values(new WebSocketPair());
  if (client === undefined || server === undefined) throw new Error("no WebSocket pair");
  server.accept();
  /** @type {ReturnType<typeof setTimeout>[]} */
  const timers = [];
  const stop = () => timers.forEach((timer) => clearTimeout(timer));
  const close = (/** @type {number} */ code, /** @type {string} */ reason) => {
    stop();
    try {
      server.close(code, reason);
    } catch {
      // Closed already.
    }
  };
  server.addEventListener("close", stop);
  // Echoes what the relay sends, as OpenAI echoes a keepalive's `session.update` (plan section 5).
  server.addEventListener("message", (event) => {
    try {
      server.send(typeof event.data === "string" ? event.data : "");
    } catch {
      stop();
    }
  });
  if (call.ends > 0) timers.push(setTimeout(() => close(1011, "call ended"), call.made + call.ends - now)); // real-timer: the provider's own clock, in another Worker
  if (call.drop > 0) timers.push(setTimeout(() => close(1011, "dropped"), call.drop)); // real-timer: the provider's own clock, in another Worker
  if (call.turns > 0) {
    const next = (/** @type {number} */ number) => {
      timers.push(setTimeout(() => { // real-timer: the provider's own clock, in another Worker
        try {
          server.send(JSON.stringify({ type: "response.created" }));
          server.send(JSON.stringify({ type: "mock.usage", event_id: `${callId}-${number}`, usage: { input_tokens: 100, output_tokens: 20 } }));
          server.send(JSON.stringify({ type: "response.done" }));
        } catch {
          stop();
          return;
        }
        next(number + 1);
      }, call.made + number * call.turns - Date.now()));
    };
    // The next answer after now, numbered from the call's start.
    next(Math.floor((now - call.made) / call.turns) + 1);
  }
  return new Response(null, { status: 101, webSocket: client });
}

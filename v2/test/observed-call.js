// @ts-check
/**
 * A stand-in for an observed (WebRTC) call, for the relay's tests
 * (`./provider-stub.js`; step 9a part 3). It follows the shape of OpenAI's
 * calls, which the relay's observed mode will use (plan step 12), with no media:
 *
 * - `POST …/realtime/calls` with the app's offer creates a call: `201`, the
 *   call's path in `Location`, and an answer as the body;
 * - a WebSocket to `…/realtime?call_id=…` attaches its side channel: `101`
 *   while the call runs, `404` once it ended;
 * - `POST …/realtime/calls/{id}/hangup` hangs it up: `200`.
 *
 * It keeps no state: what a call does is written in its id, from lines in the
 * offer, `a=x-mock-<name>:<value>` (seconds, decimals allowed):
 * - `ends:S`: the call ends S seconds after it was made, and its side channel closes then;
 * - `turns:S`: every S seconds, the attached side channel reports an answer:
 *   `response.created`, a `mock.usage` event of 100 input and 20 output
 *   tokens, then `response.done`. Each answer's event id is the call's id and
 *   its number, so one answer is never counted twice, whichever side channel
 *   reported it.
 */

/** An option's value in milliseconds: 0 when unset. @param {string} offer @param {string} name */
function option(offer, name) {
  const match = new RegExp(`^a=x-mock-${name}:([0-9.]+)\\s*$`, "mu").exec(offer);
  return match === null ? 0 : Math.round((Number(match[1]) || 0) * 1000);
}

/** @param {string} id */
function readCallId(id) {
  const match = /^rtc_mock_(\d+)_(\d+)_(\d+)_[0-9a-f]{8}$/u.exec(id);
  return match === null ? null : { made: Number(match[1]), ends: Number(match[2]), turns: Number(match[3]) };
}

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
    // `rtc_mock_<made>_<ends>_<turns>_<random>`, times in milliseconds (0: never).
    const id = `rtc_mock_${now}_${option(offer, "ends")}_${option(offer, "turns")}_${crypto.randomUUID().slice(0, 8)}`;
    return new Response(`v=0\r\no=mock 1 1 IN IP4 0.0.0.0\r\ns=mock answer\r\nt=0 0\r\n`, {
      status: 201,
      headers: { location: `/v1/realtime/calls/${id}`, "content-type": "application/sdp" },
    });
  }
  const hangup = /\/realtime\/calls\/([^/]+)\/hangup$/u.exec(url.pathname);
  if (request.method === "POST" && hangup !== null) return new Response(null, { status: readCallId(decodeURIComponent(hangup[1] ?? "")) === null ? 404 : 200 });
  const callId = url.searchParams.get("call_id");
  if (callId === null || !url.pathname.endsWith("/realtime") || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return null;
  const call = readCallId(callId);
  if (call === null || (call.ends > 0 && now - call.made >= call.ends)) return new Response(null, { status: 404 });
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
  server.addEventListener("close", stop);
  if (call.ends > 0) {
    timers.push(setTimeout(() => { // real-timer: the provider's own clock, in another Worker
      stop();
      try {
        server.close(1011, "call ended");
      } catch {
        // Closed already.
      }
    }, call.made + call.ends - now));
  }
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

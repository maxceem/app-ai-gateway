// The provider stand-in for the relay's tests (`vitest.config.ts`): every
// provider request the test relay makes comes here, and nothing leaves the
// machine.
//
// - A relayed session's WebSocket stays open, sends one event at once and
//   echoes every frame. A frame that starts with "later:" is echoed after
//   300 ms: a provider frame that lands while the client's link is down (the
//   reconnect tests).
// - An observed call, its side channel and its hang-up are in
//   `./observed-call.js`.
//
// It keeps the key header of the last request, which a test reads back at
// /last-key-header; the hang-ups it got, at /hangups; and how many calls were
// made for an offer with the line `a=x-test:<tag>`, at /calls/<tag>.
import { observedCall } from "./observed-call.js";

let lastKeyHeader = null;
const hangups = [];
const calls = new Map();

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/last-key-header") return Response.json({ authorization: lastKeyHeader });
    if (url.pathname === "/hangups") return Response.json(hangups);
    if (url.pathname.startsWith("/calls/")) return Response.json({ made: calls.get(url.pathname.slice("/calls/".length)) ?? 0 });
    lastKeyHeader = request.headers.get("authorization");
    if (request.method === "POST" && url.pathname.endsWith("/hangup")) hangups.push(decodeURIComponent(url.pathname.split("/").at(-2)));
    if (request.method === "POST" && url.pathname.endsWith("/realtime/calls")) {
      const tag = /^a=x-test:(\S+)/mu.exec(await request.clone().text())?.[1];
      if (tag !== undefined) calls.set(tag, (calls.get(tag) ?? 0) + 1);
    }
    const observed = await observedCall(request);
    if (observed !== null) return observed;
    const [client, server] = Object.values(new WebSocketPair());
    server.binaryType = "arraybuffer";
    server.accept();
    server.send(JSON.stringify({ type: "session.created" }));
    server.addEventListener("message", (event) => {
      if (typeof event.data === "string" && event.data.startsWith("later:")) setTimeout(() => server.send(event.data), 300); // real-timer: a provider that answers later, in another Worker
      else server.send(event.data);
    });
    return new Response(null, { status: 101, webSocket: client });
  },
};

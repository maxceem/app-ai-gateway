// A stand-in for Gemini Live, for the relay's tests (`./provider-stub.js`): one
// WebSocket per connection, its JSON in binary frames, as Gemini sends it (T4, T19).
//
// - A `setup` is answered with `setupComplete`, then a resumable handle,
//   `h-<n>` for the n-th connection.
// - A client text turn (`clientContent`) is answered with one audio chunk,
//   then `turnComplete` with its usage, then a fresh handle, as Gemini sends
//   one after each `turnComplete` (T19). The text "goaway" gets a `goAway`
//   with 11 s left first.
//
// It keeps every setup it got, which a test reads back at /gemini-setups.

const setups = [];
let connections = 0;

/** One turn's usage: 60 text and 40 audio tokens in, 20 audio tokens out. */
export const GEMINI_STUB_USAGE = {
  promptTokenCount: 100,
  responseTokenCount: 20,
  totalTokenCount: 120,
  promptTokensDetails: [
    { modality: "TEXT", tokenCount: 60 },
    { modality: "AUDIO", tokenCount: 40 },
  ],
  responseTokensDetails: [{ modality: "AUDIO", tokenCount: 20 }],
};

/** @param {Request} request */
export function geminiLive(request) {
  const url = new URL(request.url);
  if (url.pathname === "/gemini-setups") return Response.json(setups);
  if (!url.pathname.endsWith("BidiGenerateContent")) return null;
  connections += 1;
  const connection = connections;
  const [client, server] = Object.values(new WebSocketPair());
  server.binaryType = "arraybuffer";
  server.accept();
  const send = (message) => server.send(new TextEncoder().encode(JSON.stringify(message)));
  server.addEventListener("message", (event) => {
    const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
    const message = JSON.parse(text);
    if (message.setup !== undefined) {
      setups.push(message.setup);
      send({ setupComplete: {} });
      send({ sessionResumptionUpdate: { newHandle: `h-${connection}`, resumable: true } });
      return;
    }
    const said = message.clientContent?.turns?.[0]?.parts?.[0]?.text;
    if (said === "goaway") send({ goAway: { timeLeft: "11s" } });
    if (said !== undefined) {
      send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAAA" } }], role: "model" } } });
      send({ serverContent: { turnComplete: true }, usageMetadata: GEMINI_STUB_USAGE });
      send({ sessionResumptionUpdate: { newHandle: `h-${connection}-${crypto.randomUUID().slice(0, 8)}`, resumable: true } });
    }
  });
  return new Response(null, { status: 101, webSocket: client });
}

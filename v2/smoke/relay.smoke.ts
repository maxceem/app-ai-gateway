/**
 * The relay Worker of a live v2 deployment (plan step 9a). For now its session
 * object only echoes frames, which shows the relay is deployed and reachable.
 *
 *   V2_RELAY_URL=https://app-ai-gateway-v2-relay.<subdomain>.workers.dev \
 *   pnpm --filter @app-ai-gateway/gateway-v2 smoke
 *
 * V2_RELAY_URL is the `RELAY_URL` the deploy gave the gateway. Skipped when it
 * is not set.
 */
import { test } from "node:test";
import { check, expectCode, expectResponse, fail, readJson, same, send, TEST_TIMEOUT_MS } from "./support.ts";

const relay = process.env.V2_RELAY_URL ?? "";
const skip = relay === "" ? "V2_RELAY_URL is needed" : false;

test("the relay's health check answers", { skip }, async () => {
  const response = await send("/v2/relay/healthz", relay);
  await expectResponse(response, 200, "the relay's health check");
  same(await readJson(response), { ok: true, service: "app-ai-gateway-relay" }, "the relay's health check answered something else");
});

test("the relay answers JSON 404 for a path it doesn't serve, and asks for a WebSocket on the echo", { skip }, async () => {
  const missing = await send("/v2/relay/nothing", relay);
  same(missing.status, 404, "a path the relay doesn't serve");
  expectCode(await readJson(missing), "not_found", "a path the relay doesn't serve");
  const plain = await send("/v2/relay/echo", relay);
  same(plain.status, 426, "the echo without a WebSocket");
  expectCode(await readJson(plain), "websocket_required", "the echo without a WebSocket");
});

test("the relay's session object echoes text and binary frames", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const url = new URL("/v2/relay/echo", relay);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const received: (string | ArrayBuffer)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const echoed = await new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), 20_000);
    socket.addEventListener("open", () => {
      socket.send("hello relay");
      socket.send(new Uint8Array([1, 2, 3]));
    });
    socket.addEventListener("message", (event) => {
      received.push(event.data as string | ArrayBuffer);
      if (received.length === 2) resolve(true);
    });
    socket.addEventListener("error", () => resolve(false));
  }).finally(() => clearTimeout(timer));
  socket.close(1000, "done");
  if (!echoed) fail("the relay's echo did not answer both frames within 20 s");
  check(received[0] === "hello relay", "the relay's echo changed a text frame");
  check(received[1] instanceof ArrayBuffer, "the relay's echo answered a binary frame with text");
  same([...new Uint8Array(received[1])], [1, 2, 3], "the relay's echo changed a binary frame");
});

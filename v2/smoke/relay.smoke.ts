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
import assert from "node:assert/strict";
import { test } from "node:test";
import { TEST_TIMEOUT_MS } from "./support.ts";

const relay = process.env.V2_RELAY_URL ?? "";
const skip = relay === "" ? "V2_RELAY_URL is needed" : false;

test("the relay's health check answers", { skip }, async () => {
  const response = await fetch(new URL("/v2/relay/healthz", relay));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "app-ai-gateway-relay" });
});

test("the relay answers JSON 404 for a path it doesn't serve, and asks for a WebSocket on the echo", { skip }, async () => {
  const missing = await fetch(new URL("/v2/relay/nothing", relay));
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: { code: "not_found" } });
  const plain = await fetch(new URL("/v2/relay/echo", relay));
  assert.equal(plain.status, 426);
  assert.deepEqual(await plain.json(), { error: { code: "websocket_required" } });
});

test("the relay's session object echoes text and binary frames", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  const url = new URL("/v2/relay/echo", relay);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const received: (string | ArrayBuffer)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  await new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("no echo within 20 s")), 20_000);
    socket.addEventListener("open", () => {
      socket.send("hello relay");
      socket.send(new Uint8Array([1, 2, 3]));
    });
    socket.addEventListener("message", (event) => {
      received.push(event.data as string | ArrayBuffer);
      if (received.length === 2) resolve();
    });
    socket.addEventListener("error", () => reject(new Error("the relay's WebSocket failed")));
  }).finally(() => clearTimeout(timer));
  socket.close(1000, "done");
  assert.equal(received[0], "hello relay");
  assert.deepEqual([...new Uint8Array(received[1] as ArrayBuffer)], [1, 2, 3]);
});

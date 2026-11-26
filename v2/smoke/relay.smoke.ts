/**
 * The relay Worker of a live v2 deployment (plan step 9a).
 *
 *   V2_RELAY_URL=https://app-ai-gateway-v2-relay.<subdomain>.workers.dev \
 *   pnpm --filter @app-ai-gateway/gateway-v2 smoke
 *
 * V2_RELAY_URL is the `RELAY_URL` the deploy gave the gateway. Skipped when it
 * is not set. For now the relay's session object only echoes frames, and only
 * on a test deployment that sets `RELAY_ECHO`: set `V2_RELAY_ECHO=1` for one.
 * Without it, the check is that the echo is refused.
 */
import { test } from "node:test";
import { check, exchangeFrames, expectCode, expectResponse, readJson, same, send, TEST_TIMEOUT_MS } from "./support.ts";

const relay = process.env.V2_RELAY_URL ?? "";
const skip = relay === "" ? "V2_RELAY_URL is needed" : false;
const echoOn = process.env.V2_RELAY_ECHO === "1";

test("the relay's health check answers", { skip }, async () => {
  const response = await send("/v2/relay/healthz", relay);
  await expectResponse(response, 200, "the relay's health check");
  same(await readJson(response), { ok: true, service: "app-ai-gateway-relay" }, "the relay's health check answered something else");
});

test("the relay answers JSON 404 for a path it doesn't serve", { skip }, async () => {
  const missing = await send("/v2/relay/nothing", relay);
  same(missing.status, 404, "a path the relay doesn't serve");
  expectCode(await readJson(missing), "not_found", "a path the relay doesn't serve");
});

test("a relay without RELAY_ECHO refuses the echo", { skip: skip || (echoOn ? "V2_RELAY_ECHO=1: this deployment's echo is on" : false) }, async () => {
  // A plain GET tells the two apart: 404 when the echo is off, 426 when it is on.
  // (Node's fetch refuses an `upgrade` header, so none is sent.)
  const refused = await send("/v2/relay/echo", relay);
  same(refused.status, 404, "the echo on a relay without RELAY_ECHO");
  expectCode(await readJson(refused), "not_found", "the echo on a relay without RELAY_ECHO");
});

test("the relay's session object echoes text and binary frames", { skip: skip || (echoOn ? false : "V2_RELAY_ECHO=1 is needed"), timeout: TEST_TIMEOUT_MS }, async () => {
  const plain = await send("/v2/relay/echo", relay);
  same(plain.status, 426, "the echo without a WebSocket");
  expectCode(await readJson(plain), "websocket_required", "the echo without a WebSocket");
  const [text, bytes] = await exchangeFrames("/v2/relay/echo", relay, ["hello relay", new Uint8Array([1, 2, 3])], 2);
  check(text === "hello relay", "the relay's echo changed a text frame");
  check(bytes instanceof Uint8Array, "the relay's echo answered a binary frame with text");
  same([...bytes], [1, 2, 3], "the relay's echo changed a binary frame");
});

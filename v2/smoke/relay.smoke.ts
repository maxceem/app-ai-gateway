/**
 * The relay Worker of a live v2 deployment (plan step 9a).
 *
 *   V2_RELAY_URL=https://app-ai-gateway-v2-relay.<subdomain>.workers.dev \
 *   pnpm --filter @app-ai-gateway/gateway-v2 smoke
 *
 * V2_RELAY_URL is the `RELAY_URL` the deploy gave the gateway. Skipped when it
 * is not set. A session starts only with a ticket the gateway signed: these
 * checks show a made-up ticket creates nothing, and `sessions.smoke.ts` that
 * a ticket the gateway issued is taken.
 */
import { test } from "node:test";
import { check, expectCode, expectResponse, readJson, same, send, TEST_TIMEOUT_MS, websocketHandshake } from "./support.ts";

const relay = process.env.V2_RELAY_URL ?? "";
const skip = relay === "" ? "V2_RELAY_URL is needed" : false;

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

test("a session needs a WebSocket, and a made-up ticket is refused at the handshake", { skip, timeout: TEST_TIMEOUT_MS }, async () => {
  // (Node's fetch refuses an `upgrade` header, so a plain request shows the first refusal.)
  const plain = await send("/v2/relay/session", relay);
  same(plain.status, 426, "a session without a WebSocket");
  expectCode(await readJson(plain), "websocket_required", "a session without a WebSocket");
  const forged = await websocketHandshake("/v2/relay/session", relay, { authorization: "Bearer eyJ2IjoxfQ.AAAA" });
  check(forged === "refused", "the relay opened a session for a made-up ticket");
  const none = await websocketHandshake("/v2/relay/session", relay, {});
  check(none === "refused", "the relay opened a session with no ticket");
});

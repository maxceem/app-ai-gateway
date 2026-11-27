/**
 * A live provider the gateway does not know, on a live v2 deployment (step 10b; plan D4, D10), against the
 * mock's plain echo WebSocket in `smoke/mock/`, so nothing is billed:
 *
 * - a custom provider lists one WebSocket path with a price a minute; an app that allows passthrough starts
 *   a session on it through the session endpoint;
 * - the relay sends the key only in the connection's own header, the app's query goes on without its
 *   credential fields, and frames go both ways as they are;
 * - the session is billed by its connection time at the listing's price a minute.
 *
 *   V2_BASE_URL=https://gateway.example.com \
 *   V2_MANAGEMENT_KEY=agw_mgmt_… \
 *   V2_MOCK_URL=https://agw-test-v2-mock.<subdomain>.workers.dev/ \
 *   V2_RELAY_URL=https://agw-test-v2-relay.<subdomain>.workers.dev \
 *   pnpm --filter @app-ai-gateway/gateway-v2 smoke
 *
 * Everything is made through the management API and removed afterwards. Skipped when any of these is not set.
 */
import { after, test } from "node:test";
import { admin, check, checkId, exchangeFrames, expectResponse, readJson, same, send, uniqueSlug } from "./support.ts";

const base = process.env.V2_BASE_URL ?? "";
const mockUrl = process.env.V2_MOCK_URL ?? "";
const relay = process.env.V2_RELAY_URL ?? "";
const skip =
  base === "" || mockUrl === "" || relay === "" || (process.env.V2_MANAGEMENT_KEY ?? "") === ""
    ? "V2_BASE_URL, V2_MANAGEMENT_KEY, V2_MOCK_URL and V2_RELAY_URL are needed"
    : false;

const made = { provider: "", app: "" };

after(async () => {
  if (skip !== false) return;
  if (made.app !== "") await admin("DELETE", `/v2/admin/apps/${made.app}?confirm=${made.app}`);
  if (made.provider !== "") await admin("DELETE", `/v2/admin/providers/${made.provider}`);
});

type Charge = { kind: string; operation: string; cost_nano: number | null; price_source: string; unit: string | null; units: number | null };

test("a custom provider's WebSocket path is relayed as it is and billed by its connection time at its price a minute (step 10b)", { skip, timeout: 120_000 }, async () => {
  const slug = uniqueSlug("smoke-live");
  // The mock's public test key, which it reports only as a label.
  const provider = await admin("POST", "/v2/admin/providers", {
    type: "custom",
    name: `Smoke ${slug}`,
    slug,
    secret: "sk-mock-smoke-key",
    baseUrl: mockUrl,
    auth: { header: "x-api-key", format: "{key}" },
    // $0.06 a minute.
    passthrough: [{ method: "GET", path: "v1/live-echo", websocket: true, per_minute: 0.06 }],
  });
  same(provider.status, 201, "the custom provider could not be made");
  made.provider = checkId(provider.body?.provider?.id, "the custom provider's id");
  same(provider.body?.provider?.passthrough, [{ method: "GET", path: "v1/live-echo", websocket: true, per_minute: 0.06 }], "the WebSocket path as shown");
  // A WebSocket path with no price a minute is refused when saved.
  const unpriced = await admin("PUT", `/v2/admin/providers/${made.provider}`, {
    revision: provider.body?.provider?.revision,
    passthrough: [{ method: "GET", path: "v1/live-echo", websocket: true }],
  });
  same(unpriced.status, 400, "a WebSocket path with no price a minute was saved");

  const app = await admin("POST", "/v2/admin/apps", {
    name: `Smoke ${slug}`,
    config: {
      authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
      routing: { providers: { [slug]: { operations: ["passthrough"] } } },
    },
  });
  same(app.status, 201, "the app could not be made");
  made.app = checkId(app.body?.app?.id, "the app id");
  const key = String(app.body?.api_key?.key ?? "");

  const response = await send(`/v2/apps/${made.app}/sessions/${slug}`, base, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-end-user-id": "smoke-live-user" },
    body: JSON.stringify({ path: "v1/live-echo?voice=alloy&api_key=theirs&token=theirs" }),
  });
  await expectResponse(response, 201, "starting a session on the WebSocket path");
  const body = await readJson(response);
  const sessionId = checkId(body?.session_id, "the session's id");
  // The mock's hello, then each frame echoed; the link stays open 2 s, so the session has time to bill.
  const got = await exchangeFrames("/v2/relay/session", relay, ['{"type":"anything","n":1}', new Uint8Array([1, 2, 3])], 3, { authorization: `Bearer ${String(body?.ticket)}` }, 1000, 2_000);
  const hello = JSON.parse(typeof got[0] === "string" ? got[0] : "{}") as { type?: string; key?: string; query?: string };
  same(hello.type, "mock.hello", "the mock's first frame");
  same(hello.key, "x-api-key:fixture-smoke", "the key was not sent in the connection's own header alone");
  same(hello.query, "?voice=alloy", "the app's query did not go on without its credential fields");
  same(got[1], '{"type":"anything","n":1}', "the text frame was not forwarded as it was");
  same(got[2] instanceof Uint8Array ? [...got[2]] : null, [1, 2, 3], "the binary frame was not forwarded as it was");

  // Billed by its connection time at the listing's price: $0.06 a minute is 1,000 nano-dollars a millisecond.
  let charges: Charge[] = [];
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const listed = await admin("GET", `/v2/admin/apps/${made.app}/charges?owner=${encodeURIComponent(sessionId)}`);
    same(listed.status, 200, "listing the session's charges");
    charges = ((listed.body?.charges ?? []) as Charge[]).filter((charge) => charge.kind === "slice" && (charge.units ?? 0) > 0);
    // Until the last slice is in: the billed time reaches the 2 s the link was held.
    if (charges.reduce((sum, charge) => sum + (charge.units ?? 0), 0) >= 2_000) break;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  check(charges.length > 0, "the session was not billed");
  check(
    charges.every((charge) => charge.operation === "websocket" && charge.unit === "session_seconds" && charge.price_source === "customer_rate"),
    "the session was not billed by its connection time at the listing's price",
  );
  const billedMs = charges.reduce((sum, charge) => sum + (charge.units ?? 0), 0);
  // At least the 2 s the link was held, and well under the 2 minutes the test may take.
  check(billedMs >= 2_000 && billedMs < 120_000, "the session's billed time is not its connection time");
  // Each slice rounds up once, to a whole nano-dollar.
  same(charges.reduce((sum, charge) => sum + (charge.cost_nano ?? 0), 0), billedMs * 1_000, "the session's cost");
});

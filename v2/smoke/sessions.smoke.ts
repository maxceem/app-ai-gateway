/**
 * Starting a live session on a live v2 deployment (plan section 4.3, step 1;
 * step 9a part 1, third review): the gateway checks the caller and the app,
 * takes the session's slots and answers a ticket with the relay's address,
 * and the relay takes the session only with that ticket. Everything is made
 * through the management API and removed afterwards.
 *
 *   V2_BASE_URL=https://gateway.example.com \
 *   V2_MANAGEMENT_KEY=agw_mgmt_… \
 *   V2_MOCK_URL=https://agw-test-v2-mock.<subdomain>.workers.dev/ \
 *   V2_RELAY_URL=https://agw-test-v2-relay.<subdomain>.workers.dev \
 *   pnpm --filter @app-ai-gateway/gateway-v2 smoke
 *
 * The connection points at the mock in `smoke/mock/`, so nothing is billed.
 * Skipped when any of these is not set.
 */
import { after, before, test } from "node:test";
import { admin, check, checkId, exchangeFrames, expectCode, expectResponse, readJson, same, send, uniqueSlug, websocketHandshake } from "./support.ts";

const base = process.env.V2_BASE_URL ?? "";
const mockUrl = process.env.V2_MOCK_URL ?? "";
const relay = process.env.V2_RELAY_URL ?? "";
const skip =
  base === "" || mockUrl === "" || relay === "" || (process.env.V2_MANAGEMENT_KEY ?? "") === ""
    ? "V2_BASE_URL, V2_MANAGEMENT_KEY, V2_MOCK_URL and V2_RELAY_URL are needed"
    : false;

const slug = uniqueSlug("smoke-session");
const created = { provider: "", app: "", key: "" };

before(async () => {
  if (skip !== false) return;
  const provider = await admin("POST", "/v2/admin/providers", { type: "openai", name: `Smoke ${slug}`, slug, secret: "sk-mock-smoke-key", baseUrl: mockUrl });
  same(provider.status, 201, "the session connection could not be made");
  created.provider = checkId(provider.body?.provider?.id, "the session connection's id");
  const app = await admin("POST", "/v2/admin/apps", {
    name: `Smoke ${slug}`,
    config: {
      authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
      routing: { providers: { [slug]: { operations: ["openai.realtime"] } } },
    },
  });
  same(app.status, 201, "the session app could not be made");
  created.app = checkId(app.body?.app?.id, "the session app's id");
  const key = app.body?.api_key?.key;
  check(typeof key === "string" && key !== "", "the session app came with no key");
  created.key = key;
});

after(async () => {
  if (created.app !== "") await admin("DELETE", `/v2/admin/apps/${created.app}?confirm=${created.app}`);
  if (created.provider !== "") await admin("DELETE", `/v2/admin/providers/${created.provider}`);
});

async function startSession(body: Record<string, unknown>): Promise<Response> {
  return send(`/v2/apps/${created.app}/sessions/${slug}`, base, {
    method: "POST",
    headers: { authorization: `Bearer ${created.key}`, "content-type": "application/json", "x-end-user-id": "smoke-session-user" },
    body: JSON.stringify(body),
  });
}

test("a session starts with a ticket the gateway issues, and the relay takes that ticket", { skip }, async () => {
  const response = await startSession({ path: "v1/realtime", model: "gpt-realtime" });
  await expectResponse(response, 201, "starting a session");
  const body = await readJson(response);
  checkId(body?.session_id, "the session's id");
  check(typeof body?.ticket === "string" && body.ticket.length > 0, "the session came with no ticket");
  const relayUrl = new URL(String(body?.relay_url));
  same(relayUrl.pathname, "/v2/relay/session", "the session's relay address has another path");
  same(relayUrl.host, new URL(relay).host, "the session's relay address is not this deployment's relay");
  const opened = await websocketHandshake("/v2/relay/session", relay, { authorization: `Bearer ${body.ticket}` });
  check(opened === "opened", "the relay refused the ticket the gateway issued");
});

test("a started session forwards frames both ways, and our SDK gets the relay's own messages (step 9a part 1, fourth review)", { skip }, async () => {
  const response = await startSession({ path: "v1/realtime", model: "gpt-realtime" });
  await expectResponse(response, 201, "starting a session to forward frames");
  const body = await readJson(response);
  const frame = JSON.stringify({ type: "input_audio_buffer.append", audio: "AAAA" });
  // Sent at once: the relay holds it while the session starts, then forwards it. The mock echoes it.
  const got = await exchangeFrames("/v2/relay/session", relay, [frame], 3, { authorization: `Bearer ${String(body?.ticket)}`, "x-agw-relay-messages": "1" });
  const texts = got.map((item) => (typeof item === "string" ? item : ""));
  same((JSON.parse(texts[0] ?? "{}") as { type?: string }).type, "agw.session.started", "the first frame our SDK gets");
  same((JSON.parse(texts[1] ?? "{}") as { type?: string }).type, "session.created", "the provider's first event");
  same(texts[2], frame, "the frame the provider echoed");
});

test("a session's usage is booked once as a slice when it ends, even when the provider repeats an event (step 9a part 2)", { skip, timeout: 90_000 }, async () => {
  const response = await startSession({ path: "v1/realtime", model: "gpt-realtime" });
  await expectResponse(response, 201, "starting a session to count its usage");
  const body = await readJson(response);
  const sessionId = checkId(body?.session_id, "the session's id");
  // The mock answers one usage event, sent twice: the relay counts it once.
  const turn = JSON.stringify({ type: "mock.turn", event_id: "smoke-turn-1", usage: { input_tokens: 120, output_tokens: 30 }, repeat: 2 });
  const got = await exchangeFrames("/v2/relay/session", relay, [turn], 3, { authorization: `Bearer ${String(body?.ticket)}` });
  same(got.filter((item) => typeof item === "string" && item.startsWith('{"type":"mock.usage"')).length, 2, "the usage events the client got");
  // The client closed: the relay books the final slice, then closes the session.
  type Charge = { kind: string; input_tokens: number | null; output_tokens: number | null; cost_nano: number | null; price_source: string };
  let charges: Charge[] = [];
  for (let tries = 0; tries < 30; tries += 1) {
    const listed = await admin("GET", `/v2/admin/apps/${created.app}/charges?owner=${encodeURIComponent(sessionId)}`);
    same(listed.status, 200, "listing the session's charges");
    charges = (listed.body?.charges ?? []) as Charge[];
    if (charges.some((charge) => (charge.input_tokens ?? 0) > 0)) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  check(charges.length > 0 && charges.every((charge) => charge.kind === "slice"), "the session's usage was not booked as slices");
  same(charges.reduce((sum, charge) => sum + (charge.input_tokens ?? 0), 0), 120, "the session's input tokens");
  same(charges.reduce((sum, charge) => sum + (charge.output_tokens ?? 0), 0), 30, "the session's output tokens");
  // Tokens are never booked as free: priced, or left for the pricing sweep.
  for (const charge of charges.filter((c) => (c.input_tokens ?? 0) > 0)) {
    check(charge.cost_nano === null ? charge.price_source === "unresolved" : charge.cost_nano > 0, "a slice with tokens was booked as free");
  }
});

test("a session the app doesn't allow, or a path that isn't a live session, is refused", { skip }, async () => {
  const notSession = await startSession({ path: "v1/chat/completions", model: "gpt-4o-mini" });
  same(notSession.status, 403, "a path that isn't a live session");
  expectCode(await readJson(notSession), "path_not_allowed", "a path that isn't a live session");
  const noModel = await startSession({ path: "v1/realtime" });
  same(noModel.status, 400, "a session with no model");
});

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
/** An xAI connection on the same mock, and an app for its voice API (step 9b). */
const xaiSlug = uniqueSlug("smoke-xai-session");
const xai = { provider: "", app: "", key: "" };

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
  if (xai.app !== "") await admin("DELETE", `/v2/admin/apps/${xai.app}?confirm=${xai.app}`);
  if (xai.provider !== "") await admin("DELETE", `/v2/admin/providers/${xai.provider}`);
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

test("a client that hangs up during an answer still has that answer's usage booked (step 9a part 3)", { skip, timeout: 90_000 }, async () => {
  const response = await startSession({ path: "v1/realtime", model: "gpt-realtime" });
  await expectResponse(response, 201, "starting a session to close during an answer");
  const body = await readJson(response);
  const sessionId = checkId(body?.session_id, "the session's id");
  // The mock opens an answer, streams it for a second and reports its usage last.
  // The client hangs up as soon as the answer opens: the relay waits for it to finish.
  const answer = JSON.stringify({ type: "mock.answer", event_id: "smoke-answer-1", usage: { input_tokens: 70, output_tokens: 40 }, seconds: 1 });
  const got = await exchangeFrames("/v2/relay/session", relay, [answer], 2, { authorization: `Bearer ${String(body?.ticket)}` });
  same((JSON.parse(typeof got[1] === "string" ? got[1] : "{}") as { type?: string }).type, "response.created", "the frame the client hung up after");
  type Charge = { input_tokens: number | null; output_tokens: number | null };
  let charges: Charge[] = [];
  for (let tries = 0; tries < 30; tries += 1) {
    const listed = await admin("GET", `/v2/admin/apps/${created.app}/charges?owner=${encodeURIComponent(sessionId)}`);
    same(listed.status, 200, "listing the session's charges");
    charges = (listed.body?.charges ?? []) as Charge[];
    if (charges.some((charge) => (charge.input_tokens ?? 0) > 0)) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  same(charges.reduce((sum, charge) => sum + (charge.input_tokens ?? 0), 0), 70, "the answer's input tokens");
  same(charges.reduce((sum, charge) => sum + (charge.output_tokens ?? 0), 0), 40, "the answer's output tokens");
});

test("our SDK comes back to the same session after its link drops, with the reconnect secret as its first message (step 9a part 3)", { skip }, async () => {
  const response = await startSession({ path: "v1/realtime", model: "gpt-realtime" });
  await expectResponse(response, 201, "starting a session to reconnect to");
  const body = await readJson(response);
  const headers = { authorization: `Bearer ${String(body?.ticket)}`, "x-agw-relay-messages": "1" };
  // The first link gets the start, then drops: any close but 1000 or 1001.
  const first = await exchangeFrames("/v2/relay/session", relay, [], 2, headers, 4001);
  const started = JSON.parse(typeof first[0] === "string" ? first[0] : "{}") as { type?: string; reconnect_secret?: string; deadline?: number };
  same(started.type, "agw.session.started", "the first frame our SDK gets");
  const frame = JSON.stringify({ type: "input_audio_buffer.append", audio: "BBBB" });
  const again = await exchangeFrames("/v2/relay/session", relay, [JSON.stringify({ type: "agw.reconnect", secret: started.reconnect_secret }), frame], 2, headers);
  const resumed = JSON.parse(typeof again[0] === "string" ? again[0] : "{}") as { type?: string; deadline?: number };
  same(resumed.type, "agw.session.resumed", "the first frame after coming back");
  same(resumed.deadline, started.deadline, "the deadline after coming back");
  same(again[1], frame, "the frame the provider echoed after coming back");
});

test("a session the app doesn't allow, or a path that isn't a live session, is refused", { skip }, async () => {
  const notSession = await startSession({ path: "v1/chat/completions", model: "gpt-4o-mini" });
  same(notSession.status, 403, "a path that isn't a live session");
  expectCode(await readJson(notSession), "path_not_allowed", "a path that isn't a live session");
  const noModel = await startSession({ path: "v1/realtime" });
  same(noModel.status, 400, "a session with no model");
});

test("an xAI voice session is billed by its clock from the first audio, plus each text message, at the list price (step 9b)", { skip, timeout: 90_000 }, async () => {
  // xAI's adapter against the mock: it reads the client's frames, so the mock's echo is enough.
  const provider = await admin("POST", "/v2/admin/providers", { type: "xai", name: `Smoke ${xaiSlug}`, slug: xaiSlug, secret: "xai-mock-smoke-key", baseUrl: mockUrl });
  same(provider.status, 201, "the xAI connection could not be made");
  xai.provider = checkId(provider.body?.provider?.id, "the xAI connection's id");
  const app = await admin("POST", "/v2/admin/apps", {
    name: `Smoke ${xaiSlug}`,
    config: {
      authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
      routing: { providers: { [xaiSlug]: { operations: ["xai.realtime"] } } },
    },
  });
  same(app.status, 201, "the xAI app could not be made");
  xai.app = checkId(app.body?.app?.id, "the xAI app's id");
  xai.key = String(app.body?.api_key?.key ?? "");
  const response = await send(`/v2/apps/${xai.app}/sessions/${xaiSlug}`, base, {
    method: "POST",
    headers: { authorization: `Bearer ${xai.key}`, "content-type": "application/json", "x-end-user-id": "smoke-xai-user" },
    body: JSON.stringify({ path: "v1/realtime", model: "grok-voice-3.0" }),
  });
  await expectResponse(response, 201, "starting an xAI session");
  const body = await readJson(response);
  const sessionId = checkId(body?.session_id, "the xAI session's id");
  const frames = [
    JSON.stringify({ type: "session.update", session: { voice: "eve" } }),
    JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] } }),
    JSON.stringify({ type: "input_audio_buffer.append", audio: "AAAA" }),
  ];
  // The mock's first event, then its echo of each frame. The link stays open a second after, so the
  // session has time on its clock: a deployed object's clock moves only between its events.
  await exchangeFrames("/v2/relay/session", relay, frames, 4, { authorization: `Bearer ${String(body?.ticket)}` }, 1000, 1_000);
  type Charge = { cost_nano: number | null; price_source: string; unit: string | null; session_ms: number | null };
  let charges: Charge[] = [];
  for (let tries = 0; tries < 30; tries += 1) {
    const listed = await admin("GET", `/v2/admin/apps/${xai.app}/charges?owner=${encodeURIComponent(sessionId)}`);
    same(listed.status, 200, "listing the xAI session's charges");
    charges = (listed.body?.charges ?? []) as Charge[];
    // The first checkpoint may book the text message alone; the close books the time after it.
    if (charges.some((charge) => (charge.session_ms ?? 0) > 0)) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  check(charges.length > 0, "the xAI session's usage was not booked");
  // Each slice at the list price: by its time, or by its text messages alone when it has no time.
  check(charges.every((charge) => charge.price_source === "list_rate" && (charge.unit === "session_seconds" || charge.unit === "text_messages")), "the xAI session was not billed by its clock and text messages at the list price");
  const cost = charges.reduce((sum, charge) => sum + (charge.cost_nano ?? 0), 0);
  // One text message is $0.004 (4,000,000 nano-dollars); the time from the first audio adds to it.
  check(cost > 4_000_000, "the xAI session cost less than one text message and its time");
  check(charges.reduce((sum, charge) => sum + (charge.session_ms ?? 0), 0) > 0, "the xAI session booked no time from its first audio");
});

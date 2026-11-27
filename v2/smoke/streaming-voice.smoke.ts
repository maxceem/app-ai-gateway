/**
 * ElevenLabs' and Deepgram's streaming voice on a live v2 deployment (step 10a), against the mock in
 * `smoke/mock/`, so nothing is billed:
 *
 * - an ElevenLabs stream is billed by the characters of the text the client sends, at the list price;
 * - a Deepgram stream is billed by time at the streaming list price, then settled to the dollar figure
 *   in Deepgram's request record, which the gateway's sweep looks up after the stream ends.
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

const made: { provider: string; app: string }[] = [];

after(async () => {
  if (skip !== false) return;
  for (const { provider, app } of made) {
    if (app !== "") await admin("DELETE", `/v2/admin/apps/${app}?confirm=${app}`);
    if (provider !== "") await admin("DELETE", `/v2/admin/providers/${provider}`);
  }
});

/** A connection of `type` on the mock and an app that allows only `operation`: its id and key. */
async function streamApp(type: string, operation: string): Promise<{ app: string; key: string; slug: string }> {
  const slug = uniqueSlug(`smoke-${type}-stream`);
  const entry = { provider: "", app: "" };
  made.push(entry);
  const provider = await admin("POST", "/v2/admin/providers", { type, name: `Smoke ${slug}`, slug, secret: `${type}-mock-smoke-key`, baseUrl: mockUrl });
  same(provider.status, 201, "the stream's connection could not be made");
  entry.provider = checkId(provider.body?.provider?.id, "the stream's connection id");
  const app = await admin("POST", "/v2/admin/apps", {
    name: `Smoke ${slug}`,
    config: {
      authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
      routing: { providers: { [slug]: { operations: [operation] } } },
    },
  });
  same(app.status, 201, "the stream's app could not be made");
  entry.app = checkId(app.body?.app?.id, "the stream's app id");
  return { app: entry.app, key: String(app.body?.api_key?.key ?? ""), slug };
}

type Charge = { kind: string; cost_nano: number | null; price_source: string; unit: string | null; units: number | null; correction_kind: string | null };

/** The session's charges, once `ready` holds for them, polled for up to `tries` × 3 s. */
async function chargesOf(app: string, sessionId: string, ready: (charges: Charge[]) => boolean, tries = 30): Promise<Charge[]> {
  let charges: Charge[] = [];
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const listed = await admin("GET", `/v2/admin/apps/${app}/charges?owner=${encodeURIComponent(sessionId)}`);
    same(listed.status, 200, "listing the session's charges");
    charges = (listed.body?.charges ?? []) as Charge[];
    if (ready(charges)) break;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return charges;
}

test("an ElevenLabs stream is billed by the characters of the text the client sends, at the list price (step 10a)", { skip, timeout: 120_000 }, async () => {
  const { app, key, slug } = await streamApp("elevenlabs", "elevenlabs.tts_websocket");
  const response = await send(`/v2/apps/${app}/sessions/${slug}`, base, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-end-user-id": "smoke-tts-user" },
    body: JSON.stringify({ path: "v1/text-to-speech/smoke-voice/stream-input?output_format=pcm_16000", model: "eleven_flash_v2_5" }),
  });
  await expectResponse(response, 201, "starting an ElevenLabs stream");
  const body = await readJson(response);
  const sessionId = checkId(body?.session_id, "the ElevenLabs stream's id");
  // The opening space and the closing empty text are not billed: only "Hello there " (12 characters).
  const got = await exchangeFrames("/v2/relay/session", relay, [JSON.stringify({ text: " " }), JSON.stringify({ text: "Hello there " }), JSON.stringify({ text: "" })], 2, {
    authorization: `Bearer ${String(body?.ticket)}`,
  });
  same((JSON.parse(typeof got[1] === "string" ? got[1] : "{}") as { isFinal?: unknown }).isFinal, true, "ElevenLabs' final frame");
  const charges = await chargesOf(app, sessionId, (list) => list.some((charge) => charge.unit === "characters"));
  const billed = charges.filter((charge) => charge.unit === "characters");
  check(billed.length > 0 && billed.every((charge) => charge.kind === "slice" && charge.price_source === "list_rate"), "the stream was not billed by its characters at the list price");
  same(billed.reduce((sum, charge) => sum + (charge.units ?? 0), 0), 12, "the stream's characters");
  // 12 characters at Flash's $40 a million.
  same(billed.reduce((sum, charge) => sum + (charge.cost_nano ?? 0), 0), 480_000, "the stream's cost");
});

test("a Deepgram stream is billed by time at the streaming price, then settled to Deepgram's own dollars by its request lookup (step 10a)", { skip, timeout: 240_000 }, async () => {
  const { app, key, slug } = await streamApp("deepgram", "deepgram.listen_stream");
  // `mock_usd` goes on to the mock with the app's other options: its request record reports that figure.
  const response = await send(`/v2/apps/${app}/sessions/${slug}`, base, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-end-user-id": "smoke-stt-user" },
    body: JSON.stringify({ path: "v1/listen?encoding=linear16&sample_rate=16000&mock_usd=0.0042", model: "nova-3" }),
  });
  await expectResponse(response, 201, "starting a Deepgram stream");
  const body = await readJson(response);
  const sessionId = checkId(body?.session_id, "the Deepgram stream's id");
  // Two seconds of audio, then CloseStream: two Results and the Metadata, then Deepgram closes.
  const second = new Uint8Array(32_000);
  const got = await exchangeFrames("/v2/relay/session", relay, [second, second, JSON.stringify({ type: "CloseStream" })], 3, { authorization: `Bearer ${String(body?.ticket)}` });
  same((JSON.parse(typeof got[2] === "string" ? got[2] : "{}") as { type?: string }).type, "Metadata", "Deepgram's closing frame");
  // The slices first, by time at the streaming price.
  const sliced = await chargesOf(app, sessionId, (list) => list.some((charge) => charge.kind === "slice" && (charge.cost_nano ?? 0) > 0));
  check(
    sliced.filter((charge) => charge.kind === "slice" && (charge.cost_nano ?? 0) > 0).every((charge) => charge.unit === "session_seconds" && charge.price_source === "list_rate"),
    "the stream was not billed by time at the list price",
  );
  // Then the lookup, about a minute after the end: the session totals Deepgram's $0.0042.
  const settled = await chargesOf(app, sessionId, (list) => list.some((charge) => charge.kind === "correction" && charge.correction_kind === "dollars"), 60);
  check(settled.some((charge) => charge.kind === "correction" && charge.correction_kind === "dollars" && charge.price_source === "provider_usd"), "the stream was never settled to Deepgram's dollars");
  same(settled.reduce((sum, charge) => sum + (charge.cost_nano ?? 0), 0), 4_200_000, "the stream's cost after Deepgram's figure");
});

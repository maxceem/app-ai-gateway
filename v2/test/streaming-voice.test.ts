/**
 * ElevenLabs' and Deepgram's streaming voice on the gateway's side (step 10a): their session operations and
 * prices, one price rule over every write path (the save check, the session's price, the pricing sweep), the
 * session start (the app's options sent on, the model locked, Deepgram's price keys and key copies), and
 * Deepgram's request lookup after a stream: a final record settles the session to Deepgram's dollars, one not
 * ready yet is tried again, and past an hour, or when it can't be read, the estimate stays.
 *
 * Runs with split keys off and on (`vitest.config.ts`): with them on, the lookup opens the key with the copies
 * made when the app asked for the session.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { parseTicket } from "../relay/src/ticket.js";
import { adapterFor, closeForRelay } from "../src/relay/contract.ts";
import { checkpointForRelay, priceSlice, sliceCharge } from "../src/relay/checkpoint.ts";
import { deepgramLookup, recordFigure } from "../src/relay/deepgram-lookup.ts";
import { billing, billingForCharge, listedModelRefusal, priceSources, savedPriceProblem } from "../src/pricing/billability.ts";
import { priceKeyValues } from "../src/proxy/request-fields.ts";
import { CREDENTIAL_FIELD } from "../src/relay/start-session.ts";
import { CREDENTIAL_FIELD as RELAY_CREDENTIAL_FIELD } from "../relay/src/adapters.js";
import { GatewayError } from "../src/core/errors.ts";
import { setVaultForTests, type VaultClient } from "../src/vault/client.ts";
import { localVault } from "./local-vault.ts";
import { listPrice } from "../src/pricing/prices.ts";
import { deepgram } from "../src/providers/deepgram.ts";
import { elevenlabs } from "../src/providers/elevenlabs.ts";
import { attachLookupKeyCopies, lookupWorkId, openSession, PROVIDER_LOOKUP_WINDOW_MS, sessionWorkId, type SessionRow } from "../src/ledger/sessions.ts";
import { runSweep, type OpenWorkItem } from "../src/ledger/sweep.ts";
import { sessionBillsTime } from "../src/relay/session-price.ts";
import { sealForTest, splitKeysOn } from "./split-keys.ts";
import { ACCOUNT_ID, clearCaches, ledger, seedAccount, seedAppKey, seedRoutedApp } from "./helpers.ts";
import { ticketFor } from "./relay-stand-ins.ts";

const ORIGIN = "https://gateway.test";
const RELAY_ENV = { ...env, RELAY_URL: "https://relay.test" } as unknown as Env;
const SECRET = "dg-secret-for-tests-0123456789";
const stream = deepgram.operations.find((op) => op.name === "deepgram.listen_stream")!;
const prerecorded = deepgram.operations.find((op) => op.name === "deepgram.listen")!;
const tts = elevenlabs.operations.find((op) => op.name === "elevenlabs.tts_websocket")!;

beforeEach(() => {
  clearCaches();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe(`streaming voice prices and the save rule (step 10a, split keys ${splitKeysOn ? "on" : "off"})`, () => {
  const none = priceSources({ type: "deepgram", rates: null });

  it("prices a Deepgram stream at Deepgram's streaming rates, and leaves the prerecorded rates as they were", () => {
    expect(listPrice("deepgram-streaming", "nova-3")?.rates).toEqual({ per_minute: 4_800_000 });
    expect(billing(stream, none, "nova-3").price?.price.rates).toEqual({ per_minute: 4_800_000 });
    expect(billingForCharge(none, "nova-3", "deepgram.listen_stream")?.price.rates).toEqual({ per_minute: 4_800_000 });
    // Never start refusing, or billing differently, what used to work: the prerecorded call keeps its rate.
    expect(billing(prerecorded, none, "nova-3").price?.price.rates).toEqual({ per_minute: 4_300_000 });
    expect(billingForCharge(none, "nova-3")?.price.rates).toEqual({ per_minute: 4_300_000 });
    // A model the streaming list doesn't price is not a stream's: it was never served there.
    expect(billing(stream, none, "whisper-large").problem).toBe("no_price");
  });

  it("bills a stream's slice by its billed time with its own price keys: language and add-ons, exactly", () => {
    const resolved = billing(stream, none, "nova-3").price;
    const off = { language: "en", redact: "false", detect_entities: "false", keyterm: "false", diarize: "false" };
    expect(priceSlice({}, resolved, 60_000, off)).toMatchObject({ costNano: 4_800_000, estimated: false, unit: "session_seconds" });
    expect(priceSlice({}, resolved, 60_000, { ...off, language: "multi" })).toMatchObject({ costNano: 5_800_000, estimated: false });
    // Diarization costs extra when streaming (included in the prerecorded rate).
    expect(priceSlice({}, resolved, 60_000, { ...off, diarize: "true" })).toMatchObject({ costNano: 6_800_000, estimated: false });
    // With no key values the dearest bills, as an estimate: never less than the model's own price.
    const unknown = priceSlice({}, resolved, 60_000);
    expect(unknown.estimated).toBe(true);
    expect(unknown.costNano!).toBeGreaterThan(5_800_000);
  });

  it("bills an ElevenLabs stream by its characters at the model's rate, never its connection time, and as an estimate under a dictionary", () => {
    expect(sessionBillsTime("elevenlabs.tts_websocket")).toBe(false);
    expect(sessionBillsTime("deepgram.listen_stream")).toBe(true);
    const flash = billing(tts, priceSources({ type: "elevenlabs", rates: null }), "eleven_flash_v2_5").price;
    expect(flash).not.toBeNull();
    // 1,000 characters at $40 a million: $0.04.
    expect(priceSlice({ characters: 1_000 }, flash, 0)).toMatchObject({ costNano: 40_000_000, unit: "characters", estimated: false });
    const doubtful = priceSlice({ characters: 1_000, estimated_characters: 1_000 }, flash, 0);
    expect(doubtful).toMatchObject({ estimated: true });
    expect(doubtful.costNano!).toBeGreaterThanOrEqual(40_000_000);
    // A slice with a gap keeps its characters' known cost, marked partial.
    const { ticket } = ticketFor(Date.now(), { providerType: "elevenlabs", operation: "elevenlabs.tts_websocket", model: "eleven_flash_v2_5", slot: "streaming" });
    const slice = { seq: 2, measures: { characters: 1_000 }, sessionMs: 30_000, gapMs: 5_000, gaps: 1, from: ticket.start, to: ticket.start + 35_000 };
    const charge = sliceCharge(ticket, slice, priceSlice(slice.measures, flash, 0), Date.now());
    expect(charge).toMatchObject({ costNano: 40_000_000, measured: "partial", unit: "characters" });
    expect(charge.measures).toMatchObject({ units_characters: 1_000, gap_ms: 5_000 });
    expect(charge.measures.units_session_seconds).toBeUndefined();
  });

  it("bills a stream's time at a customer's rates by language alone, with no base rate: the time the save check judged billable is never dropped (Sol, #273 round 1)", () => {
    const stored = { "nova-3": { by: { language: { multi: { per_minute: 5_800_000 }, "*": { per_minute: 4_800_000 } } } } };
    expect(savedPriceProblem(stored, "nova-3", "deepgram", deepgram.operations)).toBeNull();
    const resolved = billing(stream, priceSources({ type: "deepgram", rates: stored }), "nova-3").price;
    const keys = { language: "en", redact: "false", detect_entities: "false", keyterm: "false", diarize: "false" };
    expect(priceSlice({}, resolved, 60_000, keys)).toMatchObject({ costNano: 4_800_000, unit: "session_seconds", priceSource: "customer_rate" });
    expect(priceSlice({}, resolved, 60_000, { ...keys, language: "multi" })).toMatchObject({ costNano: 5_800_000 });
  });

  it("switches the diarization price key on with diarize_model too (Sol, #273 round 1)", () => {
    const keys = (query: string) => priceKeyValues(stream, { body: {}, query: new URLSearchParams(query) });
    expect(keys("diarize_model=latest")).toMatchObject({ diarize: "true" });
    expect(keys("diarize=true")).toMatchObject({ diarize: "true" });
    expect(keys("diarize=false")).toMatchObject({ diarize: "false" });
    expect(keys("")).toMatchObject({ diarize: "false" });
  });

  it("names credential fields the same way on the gateway and the relay, never an option such as Deepgram's keyterm", () => {
    expect(String(CREDENTIAL_FIELD)).toBe(String(RELAY_CREDENTIAL_FIELD));
    for (const name of ["xi-api-key", "xi_api_key", "api_key", "key", "token", "access_token", "single_use_token", "authorization", "Authorization", "client_secret"]) {
      expect(CREDENTIAL_FIELD.test(name), name).toBe(true);
    }
    for (const name of ["keyterm", "keywords", "model", "output_format", "language", "tokens_per_second", "sample_rate"]) expect(CREDENTIAL_FIELD.test(name), name).toBe(false);
  });

  it("refuses a model the ElevenLabs stream endpoint doesn't serve, at save, beside the calls that do serve it (Sol, #273 round 1)", () => {
    const sources = priceSources({ type: "elevenlabs", rates: null });
    expect(listedModelRefusal({ models: ["eleven_v3"] }, undefined, sources, [tts], "eleven_v3")).toMatchObject({ reason: "model_not_served", model: "eleven_v3" });
    expect(listedModelRefusal({ models: ["eleven_v4"] }, undefined, sources, [tts], "eleven_v4")).toMatchObject({ reason: "model_not_served" });
    // Their variants too, priced or not, by one rule: the family's name, then `_` (Sol, #273 round 2).
    for (const model of ["eleven_v3_conversational", "eleven_v4_turbo"]) {
      expect(listedModelRefusal({ models: [model] }, undefined, sources, [tts], model), model).toMatchObject({ reason: "model_not_served" });
    }
    // A name that only begins like one is another model.
    expect(listedModelRefusal({ models: ["eleven_v30"] }, undefined, sources, [tts], "eleven_v30")).not.toMatchObject({ reason: "model_not_served" });
    // Listed for text to speech calls as well: those serve it, so the app may list it.
    const call = elevenlabs.operations.find((op) => op.name === "elevenlabs.tts")!;
    expect(listedModelRefusal({ models: ["eleven_v3"] }, undefined, sources, [call, tts], "eleven_v3")).toBeNull();
    expect(listedModelRefusal({ models: ["eleven_flash_v2_5"] }, undefined, sources, [tts], "eleven_flash_v2_5")).toBeNull();
  });

  it("keeps a stream's price keys on its slice, so the pricing sweep prices an unpriced one the same way", () => {
    const { ticket } = ticketFor(Date.now(), {
      providerType: "deepgram",
      operation: "deepgram.listen_stream",
      model: "nova-3",
      slot: "streaming",
      priceKeys: { language: "multi", redact: "false", detect_entities: "false", keyterm: "false", diarize: "false" },
    });
    const slice = { seq: 1, measures: {}, sessionMs: 60_000, billedMs: 60_000, gapMs: 0, gaps: 0, from: ticket.start, to: ticket.start + 60_000 };
    const charge = sliceCharge(ticket, slice, priceSlice({}, null, 60_000), Date.now());
    expect(charge).toMatchObject({ priceSource: "unresolved" });
    expect(charge.measures).toMatchObject({ units_session_seconds: 60_000, key_language: "multi", key_diarize: "false" });
  });

  it("one save rule for every session: a custom price must bill the stream its model is listed for, in the stream's unit", () => {
    // ElevenLabs: a price in credits alone can't bill streamed text, which has no credits header.
    expect(savedPriceProblem({ eleven_flash_v2_5: { per_credit: 80_000 } }, "eleven_flash_v2_5", "elevenlabs", elevenlabs.operations)).toMatchObject({
      kind: "session_rates",
      operation: "elevenlabs.tts_websocket",
      rates: ["per_million_characters"],
      byClock: false,
    });
    expect(savedPriceProblem({ eleven_flash_v2_5: { per_million_characters: 30_000_000_000 } }, "eleven_flash_v2_5", "elevenlabs", elevenlabs.operations)).toBeNull();
    // Deepgram: a stream bills time, and its own price keys may set rates by language.
    expect(
      savedPriceProblem({ "nova-3": { per_minute: 4_000_000, by: { language: { multi: { per_minute: 5_000_000 }, "*": {} } } } }, "nova-3", "deepgram", deepgram.operations),
    ).toBeNull();
    expect(savedPriceProblem({ "nova-3": { input: 1_000_000 } }, "nova-3", "deepgram", deepgram.operations)).toMatchObject({
      kind: "session_rates",
      operation: "deepgram.listen_stream",
      rates: ["per_minute"],
      byClock: true,
      withoutBy: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Starting a stream, and Deepgram's lookup after it.

async function seedConnection(type: string): Promise<{ id: string; slug: string }> {
  await seedAccount();
  const id = crypto.randomUUID().replaceAll("-", "");
  const slug = `${type}-${id.slice(0, 6)}`;
  const blob = await sealForTest("providerKey", [ACCOUNT_ID, id, type, "", "", ""], SECRET);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO provider_connection
      (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, rates_json, revision, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Provider', 'active', ?, '6789', NULL, NULL, 1, 'usr_test', ?, ?)`,
  )
    .bind(id, ACCOUNT_ID, type, slug, blob, now, now)
    .run();
  return { id, slug };
}

async function setup(type: string, operation: string) {
  const connection = await seedConnection(type);
  const appId = await seedRoutedApp({ type: "api_key", end_user: { source: "header", header: "x-end-user-id" } }, { providers: { [connection.slug]: { operations: [operation] } } });
  const key = await seedAppKey(appId);
  return { appId, slug: connection.slug, connectionId: connection.id, key: key.key };
}

async function start(appId: string, slug: string, key: string, body: Record<string, unknown>) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}/v2/apps/${appId}/sessions/${slug}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-end-user-id": "user-10a" },
      body: JSON.stringify(body),
    }),
    RELAY_ENV,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function lookupRow(sessionId: string) {
  return ledger()
    .prepare("SELECT kind, due_at, tries, last_error, gave_up_at, detail_json FROM open_work WHERE id = ?")
    .bind(lookupWorkId(sessionId))
    .first<{ kind: string; due_at: number; tries: number; last_error: string | null; gave_up_at: number | null; detail_json: string }>();
}

describe(`starting a stream (step 10a, split keys ${splitKeysOn ? "on" : "off"})`, () => {
  it("starts an ElevenLabs stream on a streaming slot: the app's options go on, its own credentials don't, and the model is the session's", async () => {
    const { appId, slug, key } = await setup("elevenlabs", "elevenlabs.tts_websocket");
    const path = "v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream-input?output_format=pcm_16000&model_id=eleven_v3&authorization=Bearer%20theirs&single_use_token=t";
    const response = await start(appId, slug, key, { path, model: "eleven_flash_v2_5" });
    expect(response.status).toBe(201);
    const { payload } = parseTicket(((await response.json()) as { ticket: string }).ticket)!;
    expect(payload).toMatchObject({ operation: "elevenlabs.tts_websocket", model: "eleven_flash_v2_5", slot: "streaming", mode: "relayed", sessionTotal: false });
    expect(payload.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream-input?output_format=pcm_16000&model_id=eleven_flash_v2_5");
    expect(adapterFor(payload)).toBe("elevenlabs_tts");
    // With no model named, ElevenLabs' default, as a call.
    const plain = await start(appId, slug, key, { path: "v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream-input" });
    expect(parseTicket(((await plain.json()) as { ticket: string }).ticket)!.payload.model).toBe("eleven_multilingual_v2");
    // A model with no price is refused before any slot is taken, as a call to it is.
    const unpriced = await start(appId, slug, key, { path: "v1/text-to-speech/v/stream-input", model: "eleven_v9" });
    expect(unpriced.status).toBe(400);
    // So is a model the stream endpoint doesn't serve, priced as it is (Sol, #273 round 1).
    const unserved = await start(appId, slug, key, { path: "v1/text-to-speech/v/stream-input", model: "eleven_v3" });
    expect(unserved.status).toBe(403);
    expect(await unserved.json()).toMatchObject({ error: { code: "model_not_allowed" } });
    // A credential in the query never goes on, whatever its name (Sol, #273 round 1).
    const keyed = await start(appId, slug, key, { path: "v1/text-to-speech/v/stream-input?xi-api-key=theirs&output_format=mp3_44100_128&enable_ssml_parsing=true" });
    expect(parseTicket(((await keyed.json()) as { ticket: string }).ticket)!.payload.url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/v/stream-input?output_format=mp3_44100_128&enable_ssml_parsing=true&model_id=eleven_multilingual_v2",
    );
  });

  it("refuses a query on a session that takes no options in it, as before: never a client's own key to Gemini or OpenAI (Sol, #273 round 1)", async () => {
    const gemini = await setup("gemini", "gemini.live.v1beta");
    const path = "ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
    const withKey = await start(gemini.appId, gemini.slug, gemini.key, { path: `${path}?key=theirs`, model: "gemini-3.8-live" });
    expect(withKey.status).toBe(403);
    expect(await withKey.json()).toMatchObject({ error: { code: "path_not_allowed" } });
    expect((await start(gemini.appId, gemini.slug, gemini.key, { path, model: "gemini-3.8-live" })).status).toBe(201);
    const openai = await setup("openai", "openai.realtime");
    expect((await start(openai.appId, openai.slug, openai.key, { path: "v1/realtime?model=gpt-realtime-2.1", model: "gpt-realtime-2.1" })).status).toBe(403);
  });

  it("starts a Deepgram stream with its options, without webhooks or a client's token, its price keys signed, and its lookup queued", async () => {
    const { appId, slug, key } = await setup("deepgram", "deepgram.listen_stream");
    const path = "v1/listen?model=nova-2&encoding=linear16&sample_rate=16000&language=multi&diarize=true&keyterm=Acme&callback=https%3A%2F%2Fevil.test&token=theirs&api_key=theirs&access_token=theirs";
    const response = await start(appId, slug, key, { path, model: "nova-3" });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { ticket: string; session_id: string };
    const { payload } = parseTicket(body.ticket)!;
    expect(payload).toMatchObject({ operation: "deepgram.listen_stream", model: "nova-3", slot: "streaming", sessionTotal: true });
    expect(payload.url).toBe("https://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&language=multi&diarize=true&keyterm=Acme");
    expect(payload.priceKeys).toEqual({ language: "multi", redact: "false", detect_entities: "false", keyterm: "true", diarize: "true" });
    expect(adapterFor(payload)).toBe("deepgram");
    // The session expects Deepgram's total, and its lookup waits for the end, with the key's copies when split keys are on.
    const session = await ledger().prepare("SELECT expects_session_total FROM session WHERE id = ?").bind(body.session_id).first<{ expects_session_total: number }>();
    expect(session?.expects_session_total).toBe(1);
    const row = await lookupRow(body.session_id);
    expect(row).toMatchObject({ kind: "provider_lookup", tries: 0 });
    const detail = JSON.parse(row!.detail_json) as Record<string, unknown>;
    expect(detail).toMatchObject({ providerType: "deepgram", retryEveryMs: 60_000 });
    if (splitKeysOn) expect(detail.keyCopies).toMatchObject({ providerKey: { blob: expect.any(String) } });
    else expect(detail.keyCopies).toBeUndefined();
    // No model, no price: Deepgram's default has none.
    expect((await start(appId, slug, key, { path: "v1/listen" })).status).toBe(400);
  });
});

/** A Deepgram stream through the endpoint, one slice booked and closed as the relay does; returns its ids. */
async function closedStream(sliceMs = 30_000, requestId: string | null = "dg-req-1") {
  const { appId, slug, key, connectionId } = await setup("deepgram", "deepgram.listen_stream");
  const response = await start(appId, slug, key, { path: "v1/listen?encoding=linear16&sample_rate=16000", model: "nova-3" });
  const { ticket, session_id: sessionId } = (await response.json()) as { ticket: string; session_id: string };
  const { payload } = parseTicket(ticket)!;
  const endedAt = payload.start + sliceMs + 1_000;
  const ctx = createExecutionContext();
  const reply = await checkpointForRelay(
    env,
    ticket,
    {
      slice: { seq: 1, measures: {}, sessionMs: sliceMs, billedMs: sliceMs, gapMs: 0, gaps: 0, from: payload.start, to: payload.start + sliceMs },
      connected: true,
      accounting: true,
      providerCallId: requestId,
    },
    endedAt,
    (promise) => ctx.waitUntil(promise),
  );
  expect(reply.written).toBe(true);
  await closeForRelay(env, ticket, { finalSlice: 1, endReason: "provider_closed", endedAt, providerCallId: requestId }, endedAt, (promise) => ctx.waitUntil(promise));
  await waitOnExecutionContext(ctx);
  return { sessionId, appId, connectionId, endedAt };
}

type Answer = { status: number; body?: unknown };

/** Deepgram's API as the lookup sees it, through the vault: each path's answer, and what was asked. */
function deepgramApi(record: () => Answer, projects: () => Answer = () => ({ status: 200, body: { projects: [{ project_id: "proj-1", name: "p" }] } })) {
  const asked: { url: string; authorization: string | null }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    asked.push({ url: request.url, authorization: request.headers.get("authorization") });
    const path = new URL(request.url).pathname;
    const answer = path === "/v1/projects" ? projects() : path.startsWith("/v1/projects/proj-1/requests/") ? record() : { status: 500 };
    return answer.body === undefined ? new Response(null, { status: answer.status }) : Response.json(answer.body, { status: answer.status });
  });
  return asked;
}

const finalRecord = (usd: number): Answer => ({
  status: 200,
  body: { request_id: "dg-req-1", created: "2026-11-28T10:00:00Z", path: "/v1/listen", response: { code: 101, completed: "2026-11-28T10:00:31Z", details: { usd, duration: 30 } } },
});

async function settlementOf(sessionId: string) {
  return ledger().prepare("SELECT settlement, session_total_nano FROM session WHERE id = ?").bind(sessionId).first<{ settlement: string; session_total_nano: number | null }>();
}

async function sessionCost(sessionId: string): Promise<number> {
  const row = await ledger().prepare("SELECT COALESCE(SUM(cost_nano), 0) AS cost FROM charge WHERE owner_id = ?").bind(sessionId).first<{ cost: number }>();
  return row?.cost ?? 0;
}

describe(`Deepgram's request lookup after a stream (step 10a, split keys ${splitKeysOn ? "on" : "off"})`, () => {
  it("reads only a completed record's dollar figure as final", () => {
    expect(recordFigure(finalRecord(0.0024).body)).toEqual({ kind: "final", usd: 0.0024 });
    expect(recordFigure({ response: { details: { usd: 0.0024 } } })).toEqual({ kind: "pending" });
    expect(recordFigure({ response: { completed: "2026-11-28T10:00:31Z", details: {} } })).toEqual({ kind: "pending" });
    expect(recordFigure({ response: { completed: "2026-11-28T10:00:31Z", details: { usd: -1 } } })).toEqual({ kind: "pending" });
    expect(recordFigure(null)).toEqual({ kind: "pending" });
  });

  it("is moved to the stream's end by close, and settles the session to Deepgram's dollars, minus the slice already booked", async () => {
    const { sessionId, endedAt } = await closedStream();
    // The slice: 30 s at $0.0048 a minute.
    expect(await sessionCost(sessionId)).toBe(2_400_000);
    expect((await lookupRow(sessionId))?.due_at).toBeLessThanOrEqual(endedAt + 30_000);
    const asked = deepgramApi(() => finalRecord(0.0031));
    await runSweep(env, ledger(), { now: endedAt + 31_000 });
    expect(await settlementOf(sessionId)).toEqual({ settlement: "settled", session_total_nano: 3_100_000 });
    expect(await sessionCost(sessionId)).toBe(3_100_000);
    // The record was asked for by the stream's request id, in the key's own project, with the key the vault added.
    expect(asked.map((one) => one.url)).toEqual(["https://api.deepgram.com/v1/projects", "https://api.deepgram.com/v1/projects/proj-1/requests/dg-req-1"]);
    expect(asked.every((one) => one.authorization === `Token ${SECRET}`)).toBe(true);
    // Both rows are done; a repeat run changes nothing.
    expect(await lookupRow(sessionId)).toBeNull();
    expect(await ledger().prepare("SELECT COUNT(*) AS n FROM open_work WHERE id = ?").bind(sessionWorkId(sessionId)).first("n")).toBe(0);
    await runSweep(env, ledger(), { now: endedAt + 3 * 60_000 });
    expect(await sessionCost(sessionId)).toBe(3_100_000);
  });

  it("tries a record that isn't ready again a minute later, until it is complete (pending)", async () => {
    const { sessionId, endedAt } = await closedStream();
    let answer: Answer = { status: 404, body: { err_code: "NOT_FOUND" } };
    deepgramApi(() => answer);
    await runSweep(env, ledger(), { now: endedAt + 31_000 });
    expect(await lookupRow(sessionId)).toMatchObject({ tries: 1, last_error: "record not ready", due_at: endedAt + 31_000 + 60_000 });
    // There, but not complete yet.
    answer = { status: 200, body: { request_id: "dg-req-1", response: { details: { usd: 0.003 } } } };
    await runSweep(env, ledger(), { now: endedAt + 91_000 });
    expect(await lookupRow(sessionId)).toMatchObject({ tries: 2, last_error: "record not complete" });
    expect(await settlementOf(sessionId)).toMatchObject({ settlement: "open", session_total_nano: null });
    answer = finalRecord(0.0029);
    await runSweep(env, ledger(), { now: endedAt + 151_000 });
    expect(await settlementOf(sessionId)).toEqual({ settlement: "settled", session_total_nano: 2_900_000 });
    expect(await sessionCost(sessionId)).toBe(2_900_000);
  });

  it("keeps the estimate once an hour has passed since the stream ended (expired), and asks Deepgram nothing", async () => {
    const { sessionId, endedAt } = await closedStream();
    const asked = deepgramApi(() => ({ status: 404 }));
    await runSweep(env, ledger(), { now: endedAt + PROVIDER_LOOKUP_WINDOW_MS + 1_000 });
    expect(asked).toEqual([]);
    expect(await settlementOf(sessionId)).toEqual({ settlement: "estimate_kept", session_total_nano: null });
    expect(await sessionCost(sessionId)).toBe(2_400_000);
    expect(await lookupRow(sessionId)).toBeNull();
  });

  it("tries a refused record again within the hour (a key without usage:read), then keeps the estimate; a stream with no request id keeps it at once", async () => {
    const refused = await closedStream();
    deepgramApi(() => ({ status: 403, body: { err_code: "INSUFFICIENT_PERMISSIONS" } }));
    await runSweep(env, ledger(), { now: refused.endedAt + 31_000 });
    expect(await lookupRow(refused.sessionId)).toMatchObject({ tries: 1, last_error: "record answered 403" });
    expect(await settlementOf(refused.sessionId)).toMatchObject({ settlement: "open" });
    await runSweep(env, ledger(), { now: refused.endedAt + PROVIDER_LOOKUP_WINDOW_MS + 1_000 });
    expect(await settlementOf(refused.sessionId)).toMatchObject({ settlement: "estimate_kept" });

    const unnamed = await closedStream(30_000, null);
    const asked = deepgramApi(() => finalRecord(0.01));
    await runSweep(env, ledger(), { now: unnamed.endedAt + 31_000 });
    expect(asked).toEqual([]);
    expect(await settlementOf(unnamed.sessionId)).toMatchObject({ settlement: "estimate_kept" });
  });

  it("puts the key's copies on the lookup row whichever write made it, once, and never on one that gave up (a first checkpoint sooner than the row)", async () => {
    const session: SessionRow = {
      id: `ses_${crypto.randomUUID().replaceAll("-", "")}`,
      accountId: ACCOUNT_ID,
      appId: "app_copies",
      endUserId: null,
      installId: null,
      appleAccountId: null,
      appKeyId: null,
      providerType: "deepgram",
      providerConnectionId: null,
      operation: "deepgram.listen_stream",
      model: "nova-3",
      mode: "relayed",
      slot: "streaming",
      timeCapMs: 30 * 60_000,
      startedAt: Date.now(),
      expectsSessionTotal: true,
      lookup: "deepgram",
    };
    // Not written yet: nothing takes them.
    expect(await attachLookupKeyCopies(ledger(), session.id, { providerKey: { blob: "b1", identity: [] } })).toBe(false);
    // Written first by a checkpoint (no copies), then they arrive: they go on.
    await openSession(ledger(), session, Date.now());
    expect(JSON.parse((await lookupRow(session.id))!.detail_json)).not.toHaveProperty("keyCopies");
    expect(await attachLookupKeyCopies(ledger(), session.id, { providerKey: { blob: "b1", identity: [] } })).toBe(true);
    expect(await attachLookupKeyCopies(ledger(), session.id, "missing")).toBe(false);
    expect(JSON.parse((await lookupRow(session.id))!.detail_json)).toMatchObject({ keyCopies: { providerKey: { blob: "b1" } } });
    // A row that gave up keeps none.
    const other = { ...session, id: `ses_${crypto.randomUUID().replaceAll("-", "")}` };
    await openSession(ledger(), other, Date.now());
    await ledger().prepare("UPDATE open_work SET gave_up_at = 1 WHERE id = ?").bind(lookupWorkId(other.id)).run();
    expect(await attachLookupKeyCopies(ledger(), other.id, "missing")).toBe(false);
  });

  it("tries again after a projects answer that can't be read, cut short or refused, and settles once it can (Sol, #273 round 2)", async () => {
    const { sessionId, endedAt } = await closedStream();
    let projects: Answer = { status: 200, body: { projects: "cut" } };
    deepgramApi(() => finalRecord(0.0027), () => projects);
    await runSweep(env, ledger(), { now: endedAt + 31_000 });
    expect(await lookupRow(sessionId)).toMatchObject({ tries: 1, last_error: "no project in the answer" });
    projects = { status: 401 };
    await runSweep(env, ledger(), { now: endedAt + 91_000 });
    expect(await lookupRow(sessionId)).toMatchObject({ tries: 2, last_error: "projects answered 401" });
    projects = { status: 200, body: { projects: [{ project_id: "proj-1" }] } };
    await runSweep(env, ledger(), { now: endedAt + 151_000 });
    expect(await settlementOf(sessionId)).toEqual({ settlement: "settled", session_total_nano: 2_700_000 });
  });

  it("never settles before the stream has ended: it waits for close", async () => {
    const { sessionId } = await closedStream();
    await ledger().prepare("UPDATE session SET state = 'active', ended_at = NULL WHERE id = ?").bind(sessionId).run();
    const asked = deepgramApi(() => finalRecord(0.01));
    const item = { id: lookupWorkId(sessionId), kind: "provider_lookup", accountId: ACCOUNT_ID, appId: "a", ownerType: "session", ownerId: sessionId, chargeId: null, detail: {}, dueAt: 0, tries: 0 } as OpenWorkItem;
    expect(await deepgramLookup(env, item, { ledger: ledger(), now: Date.now(), lastTry: false })).toEqual({ done: false, reason: "session not ended" });
    expect(asked).toEqual([]);
  });

  it.runIf(splitKeysOn)("keeps the estimate when the key's copies couldn't be made: nothing else can open the key", async () => {
    const { sessionId, endedAt } = await closedStream();
    await ledger().prepare("UPDATE open_work SET detail_json = json_set(detail_json, '$.keyCopies', 'missing') WHERE id = ?").bind(lookupWorkId(sessionId)).run();
    const asked = deepgramApi(() => finalRecord(0.01));
    await runSweep(env, ledger(), { now: endedAt + 31_000 });
    expect(asked).toEqual([]);
    expect(await settlementOf(sessionId)).toMatchObject({ settlement: "estimate_kept" });
  });

  it.runIf(splitKeysOn)("tries again when the row came without copies (written by a checkpoint) and the vault can't open the key, then keeps the estimate past the hour", async () => {
    const { sessionId, endedAt } = await closedStream();
    await ledger().prepare("UPDATE open_work SET detail_json = json_remove(detail_json, '$.keyCopies') WHERE id = ?").bind(lookupWorkId(sessionId)).run();
    const asked = deepgramApi(() => finalRecord(0.01));
    await runSweep(env, ledger(), { now: endedAt + 31_000 });
    expect(asked).toEqual([]);
    expect(await lookupRow(sessionId)).toMatchObject({ tries: 1, last_error: "lookup failed" });
    await runSweep(env, ledger(), { now: endedAt + PROVIDER_LOOKUP_WINDOW_MS + 1_000 });
    expect(await settlementOf(sessionId)).toMatchObject({ settlement: "estimate_kept" });
  });

  it("tries again after the vault fails once (a timeout, say), and settles on the next try (Sol, #273 round 1)", async () => {
    const { sessionId, endedAt } = await closedStream();
    deepgramApi(() => finalRecord(0.0033));
    let failures = 1;
    setVaultForTests((vaultEnv): VaultClient => {
      const real = localVault(vaultEnv);
      return {
        ...real,
        call: async (input) => {
          if (failures > 0) {
            failures -= 1;
            throw new GatewayError(502, "provider_unavailable", "The provider credential could not be used");
          }
          return real.call(input);
        },
      };
    });
    try {
      await runSweep(env, ledger(), { now: endedAt + 31_000 });
      expect(await lookupRow(sessionId)).toMatchObject({ tries: 1, last_error: "lookup failed" });
      expect(await settlementOf(sessionId)).toMatchObject({ settlement: "open" });
      await runSweep(env, ledger(), { now: endedAt + 91_000 });
      expect(await settlementOf(sessionId)).toEqual({ settlement: "settled", session_total_nano: 3_300_000 });
    } finally {
      setVaultForTests(localVault);
    }
  });
});

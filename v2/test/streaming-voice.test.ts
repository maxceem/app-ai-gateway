/**
 * ElevenLabs' and Deepgram's streaming voice on the gateway's side (step 10a): their session operations and
 * prices, one price rule over every write path (the save check, the session's price, the pricing sweep), the
 * session start (the app's options sent on, the model locked, Deepgram's price keys), and a Deepgram stream
 * after it ends: it settles on its own minutes, with no lookup of Deepgram's record.
 *
 * Runs with split keys off and on (`vitest.config.ts`).
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { parseTicket } from "../relay/src/ticket.js";
import { adapterFor, closeForRelay } from "../src/relay/contract.ts";
import { checkpointForRelay, priceSlice, sliceCharge } from "../src/relay/checkpoint.ts";
import { billing, billingForCharge, priceSources, savedPriceProblem } from "../src/pricing/billability.ts";
import { priceKeyValues } from "../src/proxy/request-fields.ts";
import { credentialField } from "../src/relay/start-session.ts";
import { listPrice } from "../src/pricing/prices.ts";
import { deepgram } from "../src/providers/deepgram.ts";
import { elevenlabs } from "../src/providers/elevenlabs.ts";
import { attachLookupKeyCopies, lookupWorkId, openSession, type SessionRow } from "../src/ledger/sessions.ts";
import { runSweep } from "../src/ledger/sweep.ts";
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

  it("names a query's credential fields, never an option such as Deepgram's keyterm", () => {
    for (const name of ["xi-api-key", "xi_api_key", "api_key", "key", "token", "access_token", "single_use_token", "authorization", "Authorization", "client_secret"]) {
      expect(credentialField(name), name).toBe(true);
    }
    // camelCase too (Sol, #274 round 1).
    for (const name of ["apiKey", "accessToken", "xiApiKey", "XiApiKey", "clientSecret", "singleUseToken", "proxyAuthorization", "API_KEY", "ApiKey"]) {
      expect(credentialField(name), name).toBe(true);
    }
    // Acronyms, and plain names (Gemini Neon, Fable, #274 round 1).
    for (const name of ["APIKey", "xiAPIKey", "JWTToken", "APIToken", "HMACSecret", "apikey", "APIKEY", "x-apikey", "auth", "Auth", "password", "user_password", "userPassword"]) {
      expect(credentialField(name), name).toBe(true);
    }
    // Every option ElevenLabs' and Deepgram's streams take in the query goes on.
    const options = [
      ...["model_id", "language_code", "enable_logging", "enable_ssml_parsing", "output_format", "inactivity_timeout", "sync_alignment", "auto_mode", "apply_text_normalization", "seed"],
      ...["keyterm", "keywords", "model", "language", "encoding", "sample_rate", "channels", "multichannel", "punctuate", "smart_format", "diarize", "diarize_model"],
      ...["interim_results", "utterance_end_ms", "vad_events", "endpointing", "redact", "detect_entities", "numerals", "profanity_filter", "search", "replace", "tag", "extra"],
      ...["mip_opt_out", "no_delay", "filler_words", "dictation", "version", "tokens_per_second", "maxTokens", "keyTerm", "tokenizer"],
      ...["author", "auth_mode", "authorized", "keyterms", "KEYTERM", "IDs", "URLPath", "passwordless"],
    ];
    for (const name of options) expect(credentialField(name), name).toBe(false);
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
// Starting a stream, and a Deepgram stream after it ends.

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
    // A model named only in the query is the session's (Fable, #273 round 1).
    const queried = await start(appId, slug, key, { path: "v1/text-to-speech/v/stream-input?model_id=eleven_flash_v2_5" });
    expect(parseTicket(((await queried.json()) as { ticket: string }).ticket)!.payload).toMatchObject({ model: "eleven_flash_v2_5" });
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

  it("starts a Deepgram stream with its options, without webhooks or a client's token, its price keys signed, and no lookup after it", async () => {
    const { appId, slug, key } = await setup("deepgram", "deepgram.listen_stream");
    const path = "v1/listen?model=nova-2&encoding=linear16&sample_rate=16000&language=multi&diarize=true&keyterm=Acme&callback=https%3A%2F%2Fevil.test&token=theirs&api_key=theirs&access_token=theirs";
    const response = await start(appId, slug, key, { path, model: "nova-3" });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { ticket: string; session_id: string };
    const { payload } = parseTicket(body.ticket)!;
    expect(payload).toMatchObject({ operation: "deepgram.listen_stream", model: "nova-3", slot: "streaming", sessionTotal: false });
    expect(payload.url).toBe("https://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&language=multi&diarize=true&keyterm=Acme");
    expect(payload.priceKeys).toEqual({ language: "multi", redact: "false", detect_entities: "false", keyterm: "true", diarize: "true" });
    expect(adapterFor(payload)).toBe("deepgram");
    // The session settles on its own minutes: it expects no total from Deepgram, and no lookup row is queued.
    const session = await ledger().prepare("SELECT expects_session_total FROM session WHERE id = ?").bind(body.session_id).first<{ expects_session_total: number }>();
    expect(session?.expects_session_total).toBe(0);
    expect(await lookupRow(body.session_id)).toBeNull();
    // With no model named, the gateway's default, Nova-3: the guide's own example starts (Sol, #273 round 4).
    const unnamed = await start(appId, slug, key, { path: "v1/listen?encoding=linear16&sample_rate=16000" });
    expect(unnamed.status).toBe(201);
    expect(parseTicket(((await unnamed.json()) as { ticket: string }).ticket)!.payload.url).toBe(
      "https://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&model=nova-3",
    );
    // A model named only in the query is the session's (Fable, #273 round 1).
    const queried = await start(appId, slug, key, { path: "v1/listen?model=nova-3&encoding=linear16" });
    expect(queried.status).toBe(201);
    expect(parseTicket(((await queried.json()) as { ticket: string }).ticket)!.payload).toMatchObject({ model: "nova-3" });
  });
});

/** A Deepgram stream through the endpoint, one slice booked and closed as the relay does; returns its ids. */
async function closedStream(sliceMs = 30_000, requestId: string | null = "dg-req-1", extra: Record<string, unknown> = {}) {
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
      slice: { seq: 1, measures: {}, sessionMs: sliceMs, billedMs: sliceMs, gapMs: 0, gaps: 0, from: payload.start, to: payload.start + sliceMs, ...extra },
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

async function settlementOf(sessionId: string) {
  return ledger().prepare("SELECT settlement, session_total_nano FROM session WHERE id = ?").bind(sessionId).first<{ settlement: string; session_total_nano: number | null }>();
}

async function sessionCost(sessionId: string): Promise<number> {
  const row = await ledger().prepare("SELECT COALESCE(SUM(cost_nano), 0) AS cost FROM charge WHERE owner_id = ?").bind(sessionId).first<{ cost: number }>();
  return row?.cost ?? 0;
}

describe(`a Deepgram stream after it ends (step 10a, split keys ${splitKeysOn ? "on" : "off"})`, () => {
  it("settles on its own minutes at the first sweep after close: no lookup, no call to Deepgram, no warning", async () => {
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => void warnings.push(String(line)));
    const { sessionId, endedAt } = await closedStream();
    expect(await lookupRow(sessionId)).toBeNull();
    const fetched: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetched.push(new Request(input, init).url);
      return new Response(null, { status: 500 });
    });
    await runSweep(env, ledger(), { now: endedAt + 31_000 });
    expect(await settlementOf(sessionId)).toEqual({ settlement: "settled", session_total_nano: null });
    // The slice as booked, 30 s at $0.0048 a minute, with no correction.
    expect(await sessionCost(sessionId)).toBe(2_400_000);
    expect(await ledger().prepare("SELECT COUNT(*) AS n FROM charge WHERE owner_id = ? AND kind = 'correction'").bind(sessionId).first("n")).toBe(0);
    expect(fetched).toEqual([]);
    expect(warnings.filter((line) => line.includes(sessionId))).toEqual([]);
  });

  it("prices the keyterm add-on on a slice once Deepgram confirmed keyterms mid-stream (Sol, #273 round 3)", async () => {
    const { sessionId } = await closedStream(30_000, "dg-req-1", { keyterms: true });
    // 30 s at $0.0048 a minute plus the keyterm add-on, $0.0013.
    expect(await sessionCost(sessionId)).toBe(3_050_000);
  });
});

describe(`a provider lookup row's key copies (split keys ${splitKeysOn ? "on" : "off"})`, () => {
  it("puts the key's copies on the lookup row whichever write made it, once, and never on one that gave up (a first checkpoint sooner than the row)", async () => {
    const session: SessionRow = {
      id: `ses_${crypto.randomUUID().replaceAll("-", "")}`,
      accountId: ACCOUNT_ID,
      appId: "app_copies",
      endUserId: null,
      installId: null,
      appleAccountId: null,
      appKeyId: null,
      providerType: "elevenlabs",
      providerConnectionId: null,
      operation: "elevenlabs.agent",
      model: "agent_copies",
      mode: "relayed",
      slot: "conversational",
      timeCapMs: 30 * 60_000,
      startedAt: Date.now(),
      expectsSessionTotal: true,
      lookup: "elevenlabs",
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
});

/**
 * ElevenLabs text to speech and speech to text through the proxy (plan step
 * 4b). The provider is mocked at `fetch`.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../src/index.ts";
import { listedJudgement } from "./listed-model.ts";
import { billing, priceSources, savedPriceProblem } from "../src/pricing/billability.ts";
import { listPrice } from "../src/pricing/prices.ts";
import { meterCases } from "../src/pricing/units.ts";
import { elevenlabs } from "../src/providers/elevenlabs.ts";
import { BUILT_IN_PROVIDERS } from "../src/providers/index.ts";
import { ProviderMatcher } from "../src/providers/matcher.ts";
import { attemptCostUsd, headerNumber } from "../src/proxy/meter.ts";
import { checkAppConfig } from "../src/admin/apps.ts";
import { servedNow } from "../src/pricing/billability.ts";
import { sealSecret } from "../src/vault/secrets.ts";
import { ACCOUNT_ID, clearCaches, seedAccount, seedAppKey, seedRoutedApp } from "./helpers.ts";

const ORIGIN = "https://gateway.test";
const SECRET = "sk-test-elevenlabs-key-5678";
const VOICE = "JBFqnCBsd6RMkjVDRZzb";

async function setup(routing: Record<string, unknown>, rates: Record<string, unknown> | null = null): Promise<{ appId: string; slug: string; key: string }> {
  await seedAccount();
  const id = crypto.randomUUID().replaceAll("-", "");
  const slug = `elevenlabs-${id.slice(0, 6)}`;
  const blob = await sealSecret(env, "providerKey", [ACCOUNT_ID, id, "elevenlabs", ""], SECRET);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO provider_connection
      (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, rates_json, revision, created_by, created_at, updated_at)
     VALUES (?, ?, 'elevenlabs', ?, 'ElevenLabs', 'active', ?, '5678', NULL, ?, 1, 'usr_test', ?, ?)`,
  )
    .bind(id, ACCOUNT_ID, slug, blob, rates === null ? null : JSON.stringify(rates), now, now)
    .run();
  const appId = await seedRoutedApp(
    { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
    { providers: { [slug]: routing } },
  );
  const { key } = await seedAppKey(appId);
  return { appId, slug, key };
}

async function send(path: string, key: string, body: BodyInit, headers: Record<string, string> = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "x-end-user-id": "user-1", ...headers },
      body,
    }),
    env,
    ctx,
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  await waitOnExecutionContext(ctx);
  return { response, bytes };
}

const json = (path: string, key: string, body: Record<string, unknown>) => send(path, key, JSON.stringify(body), { "content-type": "application/json" });

async function upload(path: string, key: string, fields: Record<string, string | Blob>) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  const request = new Request("https://local.invalid", { method: "POST", body: form });
  return send(path, key, new Uint8Array(await request.arrayBuffer()), { "content-type": request.headers.get("content-type")! });
}

async function openWorkFor(chargeId: string): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("SELECT * FROM open_work WHERE charge_id = ?").bind(chargeId).all();
  return results;
}

async function chargesOf(appId: string): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("SELECT * FROM charge WHERE app_id = ? ORDER BY written_at, id").bind(appId).all();
  return results;
}

/** Audio as ElevenLabs answers it, with the credits it charged. */
function audio(credits: string | null, extra: Record<string, string> = {}): Response {
  const headers: Record<string, string> = { "content-type": "audio/mpeg", "request-id": "req_1", ...extra };
  if (credits !== null) headers["character-cost"] = credits;
  return new Response(new Uint8Array([0xff, 0xf3, 0x44, 0xc4, 0x00, 0x01]), { headers });
}

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
  clearCaches();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => vi.restoreAllMocks());

describe("ElevenLabs operations", () => {
  const matcher = new ProviderMatcher(elevenlabs);

  it("matches each text-to-speech path with the voice in it, and speech to text", () => {
    const cases: [string, string][] = [
      [`v1/text-to-speech/${VOICE}`, "elevenlabs.tts"],
      [`v1/text-to-speech/${VOICE}/stream`, "elevenlabs.tts_stream"],
      [`v1/text-to-speech/${VOICE}/with-timestamps`, "elevenlabs.tts_timestamps"],
      [`v1/text-to-speech/${VOICE}/stream/with-timestamps`, "elevenlabs.tts_stream_timestamps"],
      ["v1/speech-to-text", "elevenlabs.stt"],
    ];
    for (const [path, name] of cases) expect(matcher.match("POST", path), path).toMatchObject({ kind: "operation", operation: { name } });
  });

  it("serves every ElevenLabs operation now", () => {
    for (const op of elevenlabs.operations) expect(servedNow(op), op.name).toBe(true);
  });

  it("prices each listed model's credits at what its characters cost, as real calls measured them (T27)", () => {
    // 33 characters gave 13 credits on Multilingual v2 (about 0.4 a character) and 7 on Flash v2.5
    // (about 0.2), against $80 and $40 per million characters: $0.0002 a credit either way.
    const multilingual = listPrice("elevenlabs", "eleven_multilingual_v2")!;
    const flash = listPrice("elevenlabs", "eleven_flash_v2_5")!;
    expect(multilingual.rates).toMatchObject({ per_credit: 200_000, per_million_characters: 80_000_000_000 });
    expect(flash.rates).toMatchObject({ per_credit: 200_000, per_million_characters: 40_000_000_000 });
  });

  it("bills text to speech without a price of ours only through a customer rate, and speech to text through ElevenLabs' own dollars", () => {
    const tts = elevenlabs.operations.find((op) => op.name === "elevenlabs.tts")!;
    const stt = elevenlabs.operations.find((op) => op.name === "elevenlabs.stt")!;
    expect(billing(tts, priceSources({ type: "elevenlabs", rates: null }), "eleven_multilingual_v2")).toMatchObject({ problem: null, reportsCost: false });
    expect(billing(tts, priceSources({ type: "elevenlabs", rates: null }), "no_such_model")).toMatchObject({ problem: "no_price" });
    expect(billing(stt, priceSources({ type: "elevenlabs", rates: null }), "scribe_v2")).toMatchObject({ problem: null, reportsCost: true });
    // A model with no price of ours is still served: ElevenLabs sends its own dollars.
    expect(billing(stt, priceSources({ type: "elevenlabs", rates: null }), "scribe_v9")).toMatchObject({ problem: null, reportsCost: true, price: null });
  });

  it("reads header numbers as plain decimals only: no hex, no infinity, no underflow to 0 (4b S1)", () => {
    expect(headerNumber("33")).toBe(33);
    expect(headerNumber(" 2.5 ")).toBe(2.5);
    expect(headerNumber("0")).toBe(0);
    expect(headerNumber("0.0005")).toBe(0.0005);
    expect(headerNumber("5e-4")).toBe(0.0005);
    for (const bad of ["0x21", "0b11", "-1", "+3", "Infinity", "1e400", "1e-400", "", "  ", "lots", "1,000", null]) {
      expect(headerNumber(bad), String(bad)).toBeNull();
    }
  });

  it("refuses a credits-only price for a text-to-speech model, even beside speech to text, since an answer without its header cannot be charged (4b S3)", () => {
    const stored = { eleven_multilingual_v2: { per_credit: 80_000 } };
    expect(savedPriceProblem(stored, "eleven_multilingual_v2", "elevenlabs", elevenlabs.operations)).toMatchObject({ kind: "bills_nothing", operation: expect.stringMatching(/^elevenlabs\.tts/u) });
    const enabled = elevenlabs.operations.filter((op) => op.name === "elevenlabs.tts" || op.name === "elevenlabs.stt");
    expect(listedJudgement(enabled, priceSources({ type: "elevenlabs", rates: stored }), "eleven_multilingual_v2")).toEqual({ operation: "elevenlabs.tts" });
    // Both rates: every way text to speech answers is charged, and the model lists beside speech to text.
    const both = { eleven_multilingual_v2: { per_credit: 80_000, per_million_characters: 80_000_000_000 } };
    expect(listedJudgement(enabled, priceSources({ type: "elevenlabs", rates: both }), "eleven_multilingual_v2")).toBeNull();
    // A transcription model is not judged against text to speech, so it lists beside it.
    expect(listedJudgement(elevenlabs.operations, priceSources({ type: "elevenlabs", rates: null }), "scribe_v2")).toBeNull();
    // A model priced for an operation it cannot reach at all is still fine there: whisper-1 beside chat (3a-2 S1).
    const openai = BUILT_IN_PROVIDERS.openai!.operations.filter((op) => op.name === "openai.chat" || op.name === "openai.transcription");
    expect(listedJudgement(openai, priceSources({ type: "openai", rates: null }), "whisper-1")).toBeNull();
  });

  it("prices the flash v2, turbo v2 and Scribe v3 models like their siblings, and Scribe at $0.20 an hour (4b S4, F4)", () => {
    expect(listPrice("elevenlabs", "eleven_flash_v2")!.rates).toEqual(listPrice("elevenlabs", "eleven_flash_v2_5")!.rates);
    expect(listPrice("elevenlabs", "eleven_turbo_v2")!.rates).toEqual(listPrice("elevenlabs", "eleven_flash_v2_5")!.rates);
    expect(listPrice("elevenlabs", "scribe_v3")!.rates).toEqual(listPrice("elevenlabs", "scribe_v2")!.rates);
    expect(listPrice("elevenlabs", "scribe_v2")!.rates).toEqual({ per_hour: 200_000_000 });
  });

  it("treats a model of another listed kind as wrong for the operation, at save and serve alike (4b F2)", () => {
    const tts = elevenlabs.operations.find((op) => op.name === "elevenlabs.tts")!;
    const stt = elevenlabs.operations.find((op) => op.name === "elevenlabs.stt")!;
    const sources = priceSources({ type: "elevenlabs", rates: null });
    expect(billing(tts, sources, "scribe_v2")).toMatchObject({ problem: "wrong_unit", price: null });
    expect(billing(stt, sources, "eleven_multilingual_v2")).toMatchObject({ problem: "wrong_unit", price: null, reportsCost: false });
    expect(billing(tts, sources, "scribe_v2", undefined, "save")).toMatchObject({ problem: "wrong_unit" });
  });

  it("refuses an app route with no model list whose connection has a model an enabled operation charges only partly (4b F1)", async () => {
    await seedAccount();
    const id = crypto.randomUUID().replaceAll("-", "");
    const slug = `elevenlabs-${id.slice(0, 6)}`;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO provider_connection
        (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, rates_json, revision, created_by, created_at, updated_at)
       VALUES (?, ?, 'elevenlabs', ?, 'ElevenLabs', 'active', 'x', '5678', NULL, ?, 1, 'usr_test', ?, ?)`,
    )
      .bind(id, ACCOUNT_ID, slug, JSON.stringify({ m: { per_credit: 50_000 } }), now, now)
      .run();
    const config = (operations: string[], models?: string[]) => ({
      authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
      routing: { providers: { [slug]: { operations, ...(models !== undefined ? { models } : {}) } } },
    });
    // Text to speech could bill its credits but not an answer without the header: refused.
    await expect(checkAppConfig(env.DB, ACCOUNT_ID, config(["elevenlabs.tts"]))).rejects.toMatchObject({ code: "pricing_not_configured" });
    // Speech to text charges it fully, and a model list that leaves it out is judged by its own models.
    await expect(checkAppConfig(env.DB, ACCOUNT_ID, config(["elevenlabs.stt"]))).resolves.toBeDefined();
    await expect(checkAppConfig(env.DB, ACCOUNT_ID, config(["elevenlabs.tts"], ["eleven_multilingual_v2"]))).resolves.toBeDefined();
  });

  it("judges a no-list route's models as serving sends them: one a rewrite always maps away is never charged (4b A3)", async () => {
    await seedAccount();
    const id = crypto.randomUUID().replaceAll("-", "");
    const slug = `elevenlabs-${id.slice(0, 6)}`;
    const now = Date.now();
    // scribe_v1 has credits only, which text to speech charges only partly (not an answer without its header).
    const rates = { scribe_v1: { per_credit: 50_000 } };
    await env.DB.prepare(
      `INSERT INTO provider_connection
        (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, rates_json, revision, created_by, created_at, updated_at)
       VALUES (?, ?, 'elevenlabs', ?, 'ElevenLabs', 'active', 'x', '5678', NULL, ?, 1, 'usr_test', ?, ?)`,
    )
      .bind(id, ACCOUNT_ID, slug, JSON.stringify(rates), now, now)
      .run();
    const config = (rewrites?: Record<string, string>) => ({
      authentication: { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
      routing: { providers: { [slug]: { operations: ["elevenlabs.tts", "elevenlabs.stt"] } }, ...(rewrites !== undefined ? { model_rewrites: rewrites } : {}) },
    });
    await expect(checkAppConfig(env.DB, ACCOUNT_ID, config())).rejects.toMatchObject({ code: "pricing_not_configured", data: { model: "scribe_v1" } });
    await expect(checkAppConfig(env.DB, ACCOUNT_ID, config({ scribe_v1: "scribe_v2" }))).resolves.toBeDefined();
    // A rewrite is applied once, so another rewrite's target stays reachable: alias → scribe_v1 sends scribe_v1 (4b A3).
    await expect(checkAppConfig(env.DB, ACCOUNT_ID, config({ alias: "scribe_v1", scribe_v1: "scribe_v2" }))).rejects.toMatchObject({
      code: "pricing_not_configured",
      data: { model: "scribe_v1" },
    });
    // Removing the rewrite later, with the route unchanged, is judged too (4b A4).
    const saved = config({ scribe_v1: "scribe_v2" });
    const stored = { providers: saved.routing.providers, presets: {}, rewrites: saved.routing.model_rewrites! };
    await expect(checkAppConfig(env.DB, ACCOUNT_ID, config(), stored)).rejects.toMatchObject({ code: "pricing_not_configured", data: { model: "scribe_v1" } });
    // A change elsewhere, with the rewrite kept, still saves.
    await expect(checkAppConfig(env.DB, ACCOUNT_ID, config({ scribe_v1: "scribe_v2" }), stored)).resolves.toBeDefined();
  });

  it("judges speech to text on every way its answers come: credits and duration, credits only, duration only (4b F8)", () => {
    const stt = elevenlabs.operations.find((op) => op.name === "elevenlabs.stt")!;
    const [way, ...others] = meterCases(stt);
    expect(others).toEqual([]);
    expect(way!.map((usage) => Object.keys(usage.units ?? {}).sort())).toEqual([["audio_seconds", "credits"], ["credits"], ["audio_seconds"]]);
    // An hourly rate alone cannot bill an answer with credits and no duration, nor credits alone one with a duration and no header.
    expect(savedPriceProblem({ scribe_v2: { per_hour: 200_000_000 } }, "scribe_v2", "elevenlabs", [stt])).toMatchObject({ kind: "bills_nothing", operation: "elevenlabs.stt" });
    expect(savedPriceProblem({ m: { per_credit: 100_000 } }, "m", "elevenlabs", [stt])).toMatchObject({ kind: "bills_nothing" });
    expect(savedPriceProblem({ m: { per_credit: 100_000, per_hour: 200_000_000 } }, "m", "elevenlabs", [stt])).toBeNull();
  });

  it("reads a dollar figure of $0 beside a positive body duration as no report, even with no credits header (4b F10)", () => {
    const stt = elevenlabs.operations.find((op) => op.name === "elevenlabs.stt")!;
    const zero = new Headers({ "fiat-cost-before-overages": "0", "fiat-currency": "usd" });
    const reading = { usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, noTokens: true as const, audioSeconds: 4.7 }, providerCostUsd: null, closed: null };
    expect(attemptCostUsd(stt, reading, zero)).toBeNull();
    expect(attemptCostUsd(stt, { ...reading, usage: { ...reading.usage, audioSeconds: 0 } }, zero)).toBe(0);
  });

  it("reads a JSON cost report too large to store as no report, in the same one place (4b F7)", () => {
    const op = BUILT_IN_PROVIDERS.openrouter!.operations[0]!;
    const reading = { usage: null, providerCostUsd: 1e300, closed: null };
    expect(attemptCostUsd(op, reading, new Headers())).toBeNull();
    expect(attemptCostUsd(op, { ...reading, providerCostUsd: 0.002 }, new Headers())).toBe(0.002);
  });

  it("reads ElevenLabs' dollar figure only in US dollars and as a number 0 or more", () => {
    const stt = elevenlabs.operations.find((op) => op.name === "elevenlabs.stt")!;
    const cost = (headers: Record<string, string>) => attemptCostUsd(stt, null, new Headers(headers));
    expect(cost({ "fiat-cost-before-overages": "0.0005", "fiat-currency": "usd" })).toBe(0.0005);
    expect(cost({ "fiat-cost-before-overages": "0.0005", "fiat-currency": "USD" })).toBe(0.0005);
    expect(cost({ "fiat-cost-before-overages": "0.0005", "fiat-currency": "eur" })).toBeNull();
    expect(cost({ "fiat-cost-before-overages": "0.0005" })).toBeNull();
    expect(cost({ "fiat-cost-before-overages": "-1", "fiat-currency": "usd" })).toBeNull();
    expect(cost({ "fiat-cost-before-overages": "lots", "fiat-currency": "usd" })).toBeNull();
  });
});

describe("text to speech through the proxy", () => {
  it("sends the voice in the path and the key in its header, passes the audio through, and bills the request's characters, keeping the credits beside them (T27)", async () => {
    const { appId, slug, key } = await setup({ operations: ["elevenlabs.tts"] });
    // Multilingual v2 really reported 13 credits for these 33 characters.
    fetchSpy.mockResolvedValue(audio("13"));
    const { response, bytes } = await json(`/v2/apps/${appId}/proxy/${slug}/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`, key, {
      text: "Hello from the gateway cost test.",
      model_id: "eleven_multilingual_v2",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect([...bytes]).toEqual([0xff, 0xf3, 0x44, 0xc4, 0x00, 0x01]);
    const [input, init] = fetchSpy.mock.calls[0]!;
    expect(String(input)).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`);
    expect(new Headers(init?.headers).get("xi-api-key")).toBe(SECRET);
    // 33 characters at $80 per million, exact; the 13 credits are recorded beside them.
    const charges = await chargesOf(appId);
    expect(charges).toMatchObject([
      { operation: "elevenlabs.tts", model: "eleven_multilingual_v2", status: "ok", unit: "characters", units: 33, price_source: "list_rate", measured: "complete", price_is_estimate: 0, cost_nano: 2_640_000 },
    ]);
    expect(JSON.parse(String(charges[0]!.measures_json))).toMatchObject({ secondary_units: "credits" });
    expect(String(charges[0]!.measures_json)).toContain("13000");
  });

  it("uses ElevenLabs' default model when the request names none", async () => {
    const { appId, slug, key } = await setup({ operations: ["elevenlabs.tts"] });
    fetchSpy.mockResolvedValue(audio("2"));
    await json(`/v2/apps/${appId}/proxy/${slug}/v1/text-to-speech/${VOICE}`, key, { text: "Hello" });
    expect(await chargesOf(appId)).toMatchObject([{ model: "eleven_multilingual_v2", cost_nano: 400_000 }]);
  });

  it("bills a stream by the header it sends before the audio", async () => {
    const { appId, slug, key } = await setup({ operations: ["elevenlabs.tts_stream"] });
    fetchSpy.mockResolvedValue(audio("7"));
    const { response } = await json(`/v2/apps/${appId}/proxy/${slug}/v1/text-to-speech/${VOICE}/stream`, key, {
      text: "Hello from the gateway cost test.",
      model_id: "eleven_flash_v2_5",
    });
    expect(response.status).toBe(200);
    // 33 characters at $40 per million, whatever the credits header says.
    expect(await chargesOf(appId)).toMatchObject([{ operation: "elevenlabs.tts_stream", model: "eleven_flash_v2_5", unit: "characters", cost_nano: 1_320_000 }]);
  });

  it("bills the request's characters exactly when the header is missing", async () => {
    const { appId, slug, key } = await setup({ operations: ["elevenlabs.tts"] });
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchSpy.mockResolvedValue(audio(null));
    await json(`/v2/apps/${appId}/proxy/${slug}/v1/text-to-speech/${VOICE}`, key, { text: "Hello", model_id: "eleven_flash_v2_5" });
    // 5 characters at $40 per million characters: the header is only a cross-check.
    expect(await chargesOf(appId)).toMatchObject([{ unit: "characters", measured: "complete", price_is_estimate: 0, cost_nano: 200_000 }]);
    expect(warnings).not.toHaveBeenCalled();
  });

  it("bills JSON with timestamps by its header too, without reading the body", async () => {
    const { appId, slug, key } = await setup({ operations: ["elevenlabs.tts_timestamps"] });
    fetchSpy.mockResolvedValue(Response.json({ audio_base64: "AAAA", alignment: {} }, { headers: { "character-cost": "33" } }));
    await json(`/v2/apps/${appId}/proxy/${slug}/v1/text-to-speech/${VOICE}/with-timestamps`, key, { text: "x".repeat(33) });
    expect(await chargesOf(appId)).toMatchObject([{ operation: "elevenlabs.tts_timestamps", cost_nano: 2_640_000 }]);
  });

  it("bills the request's characters when the header is not a plain decimal (4b S1)", async () => {
    const { appId, slug, key } = await setup({ operations: ["elevenlabs.tts"] });
    fetchSpy.mockResolvedValue(audio("0x21"));
    await json(`/v2/apps/${appId}/proxy/${slug}/v1/text-to-speech/${VOICE}`, key, { text: "Hello", model_id: "eleven_flash_v2_5" });
    expect(await chargesOf(appId)).toMatchObject([{ unit: "characters", measured: "complete", cost_nano: 200_000 }]);
  });

  it("bills the request's characters when the credits reported are too large to charge, never leaving the call unpriced (4b S2)", async () => {
    const { appId, slug, key } = await setup({ operations: ["elevenlabs.tts"] });
    fetchSpy.mockResolvedValue(audio("1e12"));
    await json(`/v2/apps/${appId}/proxy/${slug}/v1/text-to-speech/${VOICE}`, key, { text: "Hello", model_id: "eleven_multilingual_v2" });
    // 5 characters at $80 per million.
    expect(await chargesOf(appId)).toMatchObject([{ status: "ok", unit: "characters", measured: "complete", price_source: "list_rate", cost_nano: 400_000 }]);
  });

  it("bills characters at the customer's own rate, with credits only a cross-check beside them", async () => {
    // $0.00005 a credit, stored as nano-dollars; characters at $50 per million.
    const { appId, slug, key } = await setup(
      { operations: ["elevenlabs.tts"], models: ["eleven_multilingual_v2"] },
      { eleven_multilingual_v2: { per_credit: 50_000, per_million_characters: 50_000_000_000 } },
    );
    fetchSpy.mockResolvedValue(audio("13"));
    await json(`/v2/apps/${appId}/proxy/${slug}/v1/text-to-speech/${VOICE}`, key, { text: "x".repeat(33), model_id: "eleven_multilingual_v2" });
    // 33 characters at $50 per million, not 13 credits at $0.00005.
    expect(await chargesOf(appId)).toMatchObject([{ price_source: "customer_rate", unit: "characters", cost_nano: 1_650_000 }]);
  });
});

describe("speech to text through the proxy", () => {
  it("bills ElevenLabs' own dollar figure, and removes webhook fields so the answer comes back now", async () => {
    const { appId, slug, key } = await setup({ operations: ["elevenlabs.stt"] });
    fetchSpy.mockResolvedValue(
      Response.json(
        { text: "Hello.", audio_duration_secs: 4.7090625 },
        { headers: { "character-cost": "5", "fiat-cost-before-overages": "0.0005", "fiat-currency": "usd" } },
      ),
    );
    const { response } = await upload(`/v2/apps/${appId}/proxy/${slug}/v1/speech-to-text`, key, {
      model_id: "scribe_v2",
      file: new Blob([new Uint8Array(512).fill(1)], { type: "audio/wav" }),
      webhook: "true",
      webhook_id: "hook_1",
    });
    expect(response.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    const sent = await new Request("https://local.invalid", {
      method: "POST",
      body: init?.body as BodyInit,
      ...(headers.has("content-type") ? { headers: { "content-type": headers.get("content-type")! } } : {}),
    }).formData();
    expect(sent.get("model_id")).toBe("scribe_v2");
    expect(sent.has("webhook")).toBe(false);
    expect(sent.has("webhook_id")).toBe(false);
    expect(await chargesOf(appId)).toMatchObject([
      { operation: "elevenlabs.stt", model: "scribe_v2", status: "ok", price_source: "provider_usd", cost_nano: 500_000 },
    ]);
  });

  it("bills the audio's length at ElevenLabs' $0.20 an hour when the dollar figure is in another currency (4b F4)", async () => {
    const { appId, slug, key } = await setup({ operations: ["elevenlabs.stt"] });
    fetchSpy.mockResolvedValue(
      Response.json(
        { text: "Hello.", audio_duration_secs: 4.7090625 },
        { headers: { "character-cost": "5", "fiat-cost-before-overages": "0.0005", "fiat-currency": "eur" } },
      ),
    );
    await upload(`/v2/apps/${appId}/proxy/${slug}/v1/speech-to-text`, key, { model_id: "scribe_v2", file: new Blob([new Uint8Array(8)]) });
    // 4.7090625 s is 4,710 ms on whole milliseconds; at $0.20 an hour: 4,710 × 200,000,000 ÷ 3,600,000, rounded up.
    expect(await chargesOf(appId)).toMatchObject([{ status: "ok", price_source: "list_rate", unit: "audio_seconds", cost_nano: 261_667 }]);
  });

  it("bills the audio's length when ElevenLabs' dollar figure is too large to store, and never retries that figure (4b S2, F7)", async () => {
    const { appId, slug, key } = await setup({ operations: ["elevenlabs.stt"] });
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchSpy.mockResolvedValue(
      Response.json(
        { text: "Hello.", audio_duration_secs: 4.7090625 },
        { headers: { "character-cost": "5", "fiat-cost-before-overages": "1e300", "fiat-currency": "usd" } },
      ),
    );
    await upload(`/v2/apps/${appId}/proxy/${slug}/v1/speech-to-text`, key, { model_id: "scribe_v2", file: new Blob([new Uint8Array(8)]) });
    expect(await chargesOf(appId)).toMatchObject([{ status: "ok", price_source: "list_rate", unit: "audio_seconds", cost_nano: 261_667 }]);
    expect(warnings.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("provider_cost_unusable"));
  });

  it("reads a dollar figure of $0 beside positive credits as no report, so the audio's length bills (4b F5)", async () => {
    const { appId, slug, key } = await setup({ operations: ["elevenlabs.stt"] });
    fetchSpy.mockResolvedValue(
      Response.json(
        { text: "Hello.", audio_duration_secs: 4.7090625 },
        { headers: { "character-cost": "5", "fiat-cost-before-overages": "0", "fiat-currency": "usd" } },
      ),
    );
    await upload(`/v2/apps/${appId}/proxy/${slug}/v1/speech-to-text`, key, { model_id: "scribe_v2", file: new Blob([new Uint8Array(8)]) });
    expect(await chargesOf(appId)).toMatchObject([{ price_source: "list_rate", unit: "audio_seconds", cost_nano: 261_667 }]);
  });

  it("bills Scribe v3's audio at the list rate per hour when no dollar figure comes (4b S4, F4)", async () => {
    const { appId, slug, key } = await setup({ operations: ["elevenlabs.stt"] });
    fetchSpy.mockResolvedValue(Response.json({ text: "Hello.", audio_duration_secs: 4.7090625 }, { headers: { "character-cost": "5" } }));
    await upload(`/v2/apps/${appId}/proxy/${slug}/v1/speech-to-text`, key, { model_id: "scribe_v3", file: new Blob([new Uint8Array(8)]) });
    expect(await chargesOf(appId)).toMatchObject([{ model: "scribe_v3", price_source: "list_rate", unit: "audio_seconds", cost_nano: 261_667 }]);
  });

  it("never sends a client's single-use token, and keeps the other query options (4b S5)", async () => {
    const { appId, slug, key } = await setup({ operations: ["elevenlabs.stt"] });
    fetchSpy.mockResolvedValue(Response.json({ text: "Hello." }, { headers: { "character-cost": "5", "fiat-cost-before-overages": "0.0005", "fiat-currency": "usd" } }));
    await upload(`/v2/apps/${appId}/proxy/${slug}/v1/speech-to-text?token=sutkn_client&enable_logging=false`, key, {
      model_id: "scribe_v2",
      file: new Blob([new Uint8Array(8)]),
    });
    const sent = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(sent.searchParams.has("token")).toBe(false);
    expect(sent.searchParams.get("enable_logging")).toBe("false");
  });

  it("leaves a model with no price of ours and no dollar figure unresolved, and asks the sweep to price it later (4b F3)", async () => {
    const { appId, slug, key } = await setup({ operations: ["elevenlabs.stt"] });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchSpy.mockResolvedValue(Response.json({ text: "Hello." }, { headers: { "character-cost": "5" } }));
    await upload(`/v2/apps/${appId}/proxy/${slug}/v1/speech-to-text`, key, { model_id: "scribe_v9", file: new Blob([new Uint8Array(8)]) });
    const [charge] = await chargesOf(appId);
    expect(charge).toMatchObject({ status: "ok", price_source: "unresolved", cost_nano: null });
    expect(errors.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("no_cost_reported"));
    expect(await openWorkFor(String(charge!.id))).toMatchObject([{ kind: "unresolved" }]);
  });

  it("asks the sweep to price a charge whose reported unit the price cannot bill yet (4b F3)", async () => {
    const { appId, slug, key } = await setup({ operations: ["elevenlabs.stt"] }, { m: { per_credit: 100_000 } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // No credits header: only the audio's length, which a price in credits cannot bill.
    fetchSpy.mockResolvedValue(Response.json({ text: "Hello.", audio_duration_secs: 4.7 }));
    await upload(`/v2/apps/${appId}/proxy/${slug}/v1/speech-to-text`, key, { model_id: "m", file: new Blob([new Uint8Array(8)]) });
    const [charge] = await chargesOf(appId);
    expect(charge).toMatchObject({ status: "ok", price_source: "unresolved", cost_nano: null });
    expect(await openWorkFor(String(charge!.id))).toMatchObject([{ kind: "unresolved" }]);
  });

  it("bills the provider's own credits before the audio's length it reports beside them, even when the length is dearer (4b A1)", async () => {
    const { appId, slug, key } = await setup(
      { operations: ["elevenlabs.stt"], models: ["scribe_v2"] },
      { scribe_v2: { per_credit: 50_000, per_hour: 200_000_000 } },
    );
    fetchSpy.mockResolvedValue(
      Response.json(
        { text: "Hello.", audio_duration_secs: 4.7090625 },
        { headers: { "character-cost": "5", "fiat-cost-before-overages": "0.0005", "fiat-currency": "eur" } },
      ),
    );
    await upload(`/v2/apps/${appId}/proxy/${slug}/v1/speech-to-text`, key, { model_id: "scribe_v2", file: new Blob([new Uint8Array(8)]) });
    // 5 credits at $0.00005, not 4.71 s at $0.20 an hour (261,667).
    expect(await chargesOf(appId)).toMatchObject([{ price_source: "customer_rate", unit: "credits", cost_nano: 250_000 }]);
  });

  it("bills credits at the customer's rate when ElevenLabs sends no dollar figure", async () => {
    const { appId, slug, key } = await setup({ operations: ["elevenlabs.stt"], models: ["scribe_v2"] }, { scribe_v2: { per_credit: 100_000 } });
    fetchSpy.mockResolvedValue(Response.json({ text: "Hello." }, { headers: { "character-cost": "5" } }));
    await upload(`/v2/apps/${appId}/proxy/${slug}/v1/speech-to-text`, key, { model_id: "scribe_v2", file: new Blob([new Uint8Array(8)]) });
    expect(await chargesOf(appId)).toMatchObject([{ price_source: "customer_rate", unit: "credits", cost_nano: 500_000 }]);
  });
});

/**
 * Deepgram prerecorded speech to text and fal's `fal.run` through the proxy
 * (plan step 4c). The providers are mocked at `fetch`.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../src/index.ts";
import { billing, priceSources, servedNow } from "../src/pricing/billability.ts";
import { keyCandidates, listPrice } from "../src/pricing/prices.ts";
import { deepgram } from "../src/providers/deepgram.ts";
import { fal } from "../src/providers/fal.ts";
import { ProviderMatcher } from "../src/providers/matcher.ts";
import { deepgramListenUsage } from "../src/usage/readers.ts";
import { sealSecret } from "../src/vault/secrets.ts";
import { ACCOUNT_ID, clearCaches, seedAccount, seedAppKey, seedRoutedApp } from "./helpers.ts";

const ORIGIN = "https://gateway.test";
const SECRET = "sk-test-provider-key-4321";

async function setup(type: "deepgram" | "fal", routing: Record<string, unknown>, rates: Record<string, unknown> | null = null) {
  await seedAccount();
  const id = crypto.randomUUID().replaceAll("-", "");
  const slug = `${type}-${id.slice(0, 6)}`;
  const blob = await sealSecret(env, "providerKey", [ACCOUNT_ID, id, type, ""], SECRET);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO provider_connection
      (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, rates_json, revision, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, '4321', NULL, ?, 1, 'usr_test', ?, ?)`,
  )
    .bind(id, ACCOUNT_ID, type, slug, type, blob, rates === null ? null : JSON.stringify(rates), now, now)
    .run();
  const appId = await seedRoutedApp(
    { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
    { providers: { [slug]: routing } },
  );
  const { key } = await seedAppKey(appId);
  return { appId, slug, key };
}

async function send(path: string, key: string, body: BodyInit, headers: Record<string, string>) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "x-end-user-id": "user-1", ...headers }, body }),
    env,
    ctx,
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, text };
}

async function chargesOf(appId: string): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("SELECT * FROM charge WHERE app_id = ? ORDER BY written_at, id").bind(appId).all();
  return results;
}

/** A Deepgram prerecorded answer for audio of `duration` seconds on `channels` channels. */
function transcript(duration: number, channels = 1): Response {
  return Response.json({
    metadata: { request_id: "dg-req-1", duration, channels, models: ["m1"] },
    results: { channels: Array.from({ length: channels }, () => ({ alternatives: [{ transcript: "hello" }] })) },
  });
}

let fetchSpy: MockInstance<typeof fetch>;
let warnings: MockInstance<typeof console.warn>;

beforeEach(() => {
  clearCaches();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => vi.restoreAllMocks());

describe("Deepgram operations and prices", () => {
  it("matches prerecorded transcription and serves it now", () => {
    const match = new ProviderMatcher(deepgram).match("POST", "v1/listen");
    expect(match).toMatchObject({ kind: "operation", operation: { name: "deepgram.listen" } });
    for (const op of deepgram.operations) expect(servedNow(op), op.name).toBe(true);
  });

  it("refuses the project, key and token paths", () => {
    const matcher = new ProviderMatcher(deepgram);
    for (const path of ["v1/projects/p1/requests", "v1/auth/grant", "v1/keys/k1"]) expect(matcher.match("POST", path), path).toMatchObject({ kind: "refused" });
  });

  it("lists Nova-3 at Deepgram's prerecorded rates: monolingual $0.0043 and multilingual $0.0052 a minute", () => {
    const nova = listPrice("deepgram", "nova-3")!;
    // The add-ons off, as a request without them reads (each key's default).
    const off = { redact: "false", detect_entities: "false", keyterm: "false" };
    expect(nova.rates).toMatchObject({ per_minute: 4_300_000 });
    expect(keyCandidates(nova, { language: "multi", ...off })).toMatchObject({ estimated: false, candidates: [{ price: { rates: { per_minute: 5_200_000 } } }] });
    // Any other language is the monolingual rate, a known price, not an estimate.
    expect(keyCandidates(nova, { language: "es", ...off })).toMatchObject({ estimated: false, candidates: [{ price: { rates: { per_minute: 4_300_000 } } }] });
    expect(listPrice("deepgram", "whisper-large")!.rates).toMatchObject({ per_minute: 4_800_000 });
  });

  it("prices Deepgram's documented nova-3-general spelling as Nova-3", () => {
    expect(listPrice("deepgram", "nova-3-general")).toMatchObject({ rates: listPrice("deepgram", "nova-3")!.rates, keyed: listPrice("deepgram", "nova-3")!.keyed });
    expect(billing(deepgram.operations[0]!, priceSources({ type: "deepgram", rates: null }), "nova-3-general")).toMatchObject({ problem: null });
  });

  it("adds the per-minute add-ons on top of the rate the language chose, in any order", () => {
    const nova = listPrice("deepgram", "nova-3")!;
    const rateOf = (values: Record<string, string>) => keyCandidates(nova, values);
    const off = { redact: "false", detect_entities: "false", keyterm: "false" };
    expect(rateOf({ language: "en", ...off })).toMatchObject({ estimated: false, candidates: [{ price: { rates: { per_minute: 4_300_000 } } }] });
    // $0.0043 + $0.0020 redaction.
    expect(rateOf({ language: "en", ...off, redact: "true" })).toMatchObject({ estimated: false, candidates: [{ price: { rates: { per_minute: 6_300_000 } } }] });
    // $0.0052 + $0.0020 + $0.0017 + $0.0013: every add-on on the multilingual rate.
    expect(rateOf({ keyterm: "true", detect_entities: "true", redact: "true", language: "multi" })).toMatchObject({
      estimated: false,
      candidates: [{ price: { rates: { per_minute: 10_200_000 } } }],
    });
    // Every price saving checks has the add-ons in its rate once, never twice.
    const all = keyCandidates(nova).candidates.map((candidate) => candidate.price.rates.per_minute ?? 0);
    expect(Math.max(...all)).toBe(10_200_000);
    expect(Math.min(...all)).toBe(4_300_000);
  });

  it("reads the audio's length times its channels, as Deepgram bills multichannel audio", () => {
    expect(deepgramListenUsage({ metadata: { duration: 25.9, channels: 1 } })).toMatchObject({ audioSeconds: 25.9 });
    expect(deepgramListenUsage({ metadata: { duration: 600, channels: 2 } })).toMatchObject({ audioSeconds: 1200 });
    expect(deepgramListenUsage({ metadata: { duration: 10 } })).toMatchObject({ audioSeconds: 10 });
    expect(deepgramListenUsage({ results: {} })).toBeNull();
  });

  it("needs a price of ours or the customer's: Deepgram's default model has none", () => {
    const op = deepgram.operations[0]!;
    expect(billing(op, priceSources({ type: "deepgram", rates: null }), "nova-3")).toMatchObject({ problem: null });
    expect(billing(op, priceSources({ type: "deepgram", rates: null }), "base-general")).toMatchObject({ problem: "no_price" });
  });
});

describe("Deepgram through the proxy", () => {
  it("sends raw audio as the client's own bytes with the model in the query, the key as a token, and bills its seconds", async () => {
    const { appId, slug, key } = await setup("deepgram", { operations: ["deepgram.listen"] });
    fetchSpy.mockResolvedValue(transcript(30));
    const audio = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x01, 0x02, 0x03]);
    const { response } = await send(`/v2/apps/${appId}/proxy/${slug}/v1/listen?model=nova-3&smart_format=true`, key, audio, { "content-type": "audio/wav" });
    expect(response.status).toBe(200);
    const [input, init] = fetchSpy.mock.calls[0]!;
    expect(String(input)).toBe("https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Token ${SECRET}`);
    expect(headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(audio);
    // 30 seconds at $0.0043 a minute.
    expect(await chargesOf(appId)).toMatchObject([
      { operation: "deepgram.listen", model: "nova-3", status: "ok", unit: "audio_seconds", price_source: "list_rate", measured: "complete", price_is_estimate: 0, cost_nano: 2_150_000 },
    ]);
  });

  it("bills multilingual Nova-3 at its own rate, and stereo audio for both channels", async () => {
    const { appId, slug, key } = await setup("deepgram", { operations: ["deepgram.listen"] });
    fetchSpy.mockResolvedValue(transcript(30, 2));
    await send(`/v2/apps/${appId}/proxy/${slug}/v1/listen?model=nova-3&language=multi&multichannel=true`, key, new Uint8Array([1, 2]), { "content-type": "audio/wav" });
    // 60 seconds of audio across the two channels, at $0.0052 a minute.
    expect(await chargesOf(appId)).toMatchObject([{ unit: "audio_seconds", price_is_estimate: 0, cost_nano: 5_200_000 }]);
  });

  it("takes a JSON body naming the audio's URL, which Deepgram fetches", async () => {
    const { appId, slug, key } = await setup("deepgram", { operations: ["deepgram.listen"] });
    fetchSpy.mockResolvedValue(transcript(60));
    const { response } = await send(`/v2/apps/${appId}/proxy/${slug}/v1/listen?model=nova-3`, key, JSON.stringify({ url: "https://example.test/a.wav" }), {
      "content-type": "application/json",
    });
    expect(response.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse(await new Response(init?.body).text())).toEqual({ url: "https://example.test/a.wav" });
    expect(await chargesOf(appId)).toMatchObject([{ cost_nano: 4_300_000 }]);
  });

  it("removes a callback, so Deepgram never answers somewhere the budget cannot see", async () => {
    const { appId, slug, key } = await setup("deepgram", { operations: ["deepgram.listen"] });
    fetchSpy.mockResolvedValue(transcript(10));
    await send(`/v2/apps/${appId}/proxy/${slug}/v1/listen?model=nova-3&callback=https://evil.test/hook&callback_method=PUT`, key, new Uint8Array([1]), {
      "content-type": "audio/wav",
    });
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://api.deepgram.com/v1/listen?model=nova-3");
  });

  it("bills a priced add-on exactly, on top of the model's rate", async () => {
    const { appId, slug, key } = await setup("deepgram", { operations: ["deepgram.listen"] });
    fetchSpy.mockResolvedValue(transcript(60));
    const { response } = await send(`/v2/apps/${appId}/proxy/${slug}/v1/listen?model=nova-3&redact=pii&keyterm=gateway`, key, new Uint8Array([1]), {
      "content-type": "audio/wav",
    });
    expect(response.status).toBe(200);
    // A minute at $0.0043 + $0.0020 + $0.0013.
    expect(await chargesOf(appId)).toMatchObject([{ unit: "audio_seconds", price_is_estimate: 0, cost_nano: 7_600_000 }]);
  });

  it("does not bill diarization on top: it is included in the prerecorded rate", async () => {
    const { appId, slug, key } = await setup("deepgram", { operations: ["deepgram.listen"] });
    fetchSpy.mockResolvedValue(transcript(60));
    await send(`/v2/apps/${appId}/proxy/${slug}/v1/listen?model=nova-3&diarize=true`, key, new Uint8Array([1]), { "content-type": "audio/wav" });
    expect(await chargesOf(appId)).toMatchObject([{ price_is_estimate: 0, cost_nano: 4_300_000 }]);
  });

  it("serves an option billed by tokens the answer does not report, at the model's rate as an estimate", async () => {
    const { appId, slug, key } = await setup("deepgram", { operations: ["deepgram.listen"] });
    fetchSpy.mockResolvedValue(transcript(60));
    const { response } = await send(`/v2/apps/${appId}/proxy/${slug}/v1/listen?model=nova-3&summarize=v2`, key, new Uint8Array([1]), { "content-type": "audio/wav" });
    expect(response.status).toBe(200);
    expect(await chargesOf(appId)).toMatchObject([{ unit: "audio_seconds", price_is_estimate: 1, cost_nano: 4_300_000 }]);
  });

  it("bills Whisper Large's redaction at its published add-on: a redacted minute is $0.0068", async () => {
    const { appId, slug, key } = await setup("deepgram", { operations: ["deepgram.listen"] });
    fetchSpy.mockResolvedValue(transcript(60));
    await send(`/v2/apps/${appId}/proxy/${slug}/v1/listen?model=whisper-large&redact=pii`, key, new Uint8Array([1]), { "content-type": "audio/wav" });
    expect(await chargesOf(appId)).toMatchObject([{ price_is_estimate: 0, cost_nano: 6_800_000 }]);
  });

  it("reads each option as its kind: free text is on even as `false`, a flag is off only when false, and no text is stored", async () => {
    const { appId, slug, key } = await setup("deepgram", { operations: ["deepgram.listen"] });
    fetchSpy.mockImplementation(async () => transcript(60));
    const base = `/v2/apps/${appId}/proxy/${slug}/v1/listen?model=nova-3`;
    // A key term that reads `false` is still a key term: $0.0043 + $0.0013.
    await send(`${base}&keyterm=false`, key, new Uint8Array([1]), { "content-type": "audio/wav" });
    // A repeated flag is on when any of its values is: $0.0043 + $0.0020.
    await send(`${base}&redact=false&redact=pii`, key, new Uint8Array([1]), { "content-type": "audio/wav" });
    // A flag set to false is off.
    await send(`${base}&redact=false&keyterm=Acme%20secret%20project`, key, new Uint8Array([1]), { "content-type": "audio/wav" });
    const charges = await chargesOf(appId);
    expect(charges.map((charge) => [charge.cost_nano, charge.price_is_estimate])).toEqual([
      [5_600_000, 0],
      [6_300_000, 0],
      [5_600_000, 0],
    ]);
    const stored = charges.map((charge) => JSON.parse(String(charge.measures_json)) as Record<string, unknown>);
    expect(stored.map((measures) => [measures.key_keyterm, measures.key_redact])).toEqual([
      ["true", "false"],
      ["false", "true"],
      ["true", "false"],
    ]);
    expect(JSON.stringify(stored)).not.toContain("Acme");
  });

  it("estimates an add-on the price has no rate for: entity detection on Whisper, or a customer's own rate without it", async () => {
    const whisper = await setup("deepgram", { operations: ["deepgram.listen"] });
    fetchSpy.mockImplementation(async () => transcript(60));
    await send(`/v2/apps/${whisper.appId}/proxy/${whisper.slug}/v1/listen?model=whisper-large&detect_entities=true`, whisper.key, new Uint8Array([1]), {
      "content-type": "audio/wav",
    });
    expect(await chargesOf(whisper.appId)).toMatchObject([{ price_is_estimate: 1, cost_nano: 4_800_000 }]);
    const own = await setup("deepgram", { operations: ["deepgram.listen"] }, { "nova-3": { per_minute: 5_000_000 } });
    await send(`/v2/apps/${own.appId}/proxy/${own.slug}/v1/listen?model=nova-3&redact=pii`, own.key, new Uint8Array([1]), { "content-type": "audio/wav" });
    expect(await chargesOf(own.appId)).toMatchObject([{ price_source: "customer_rate", price_is_estimate: 1, cost_nano: 5_000_000 }]);
  });

  it("does not count an option turned off as one billed on top", async () => {
    const { appId, slug, key } = await setup("deepgram", { operations: ["deepgram.listen"] });
    fetchSpy.mockResolvedValue(transcript(60));
    await send(`/v2/apps/${appId}/proxy/${slug}/v1/listen?model=nova-3&redact=false`, key, new Uint8Array([1]), { "content-type": "audio/wav" });
    expect(await chargesOf(appId)).toMatchObject([{ price_is_estimate: 0 }]);
  });

  it("bills the language Deepgram detected, and the dearest language as an estimate when the answer names none", async () => {
    const { appId, slug, key } = await setup("deepgram", { operations: ["deepgram.listen"] });
    const detected = (language: string | null, arch = "nova-3") =>
      Response.json({
        metadata: { duration: 60, channels: 1, model_info: { "m-1": { arch, name: `general-${arch}`, version: "1" } } },
        results: { channels: [{ ...(language === null ? {} : { detected_language: language }), alternatives: [{ transcript: "bonjour" }] }] },
      });
    fetchSpy.mockResolvedValueOnce(detected("fr")).mockResolvedValueOnce(detected(null)).mockResolvedValueOnce(detected("fr", "enhanced"));
    const path = `/v2/apps/${appId}/proxy/${slug}/v1/listen?model=nova-3&detect_language=true`;
    for (let call = 0; call < 3; call += 1) await send(path, key, new Uint8Array([1]), { "content-type": "audio/wav" });
    const charges = await chargesOf(appId);
    expect(charges.map((charge) => [charge.cost_nano, charge.price_is_estimate])).toEqual([
      // French, detected: the monolingual rate, exact.
      [4_300_000, 0],
      // No language named: the dearest the request could bill, the multilingual rate.
      [5_200_000, 1],
      // Served by an older model Deepgram fell back to: an estimate.
      [4_300_000, 1],
    ]);
    expect(JSON.parse(String(charges[0]!.measures_json))).toMatchObject({ key_language: "fr" });
    const warned = warnings.mock.calls.map((call) => String(call[0]));
    expect(warned.some((line) => line.includes("price_key_unanswered"))).toBe(true);
    expect(warned.some((line) => line.includes("served_model_unexpected"))).toBe(true);
  });

  it("bills the latest utterance end when the answer names no duration, as an estimate", async () => {
    const { appId, slug, key } = await setup("deepgram", { operations: ["deepgram.listen"] });
    fetchSpy.mockResolvedValue(
      Response.json({ metadata: { channels: 1 }, results: { channels: [], utterances: [{ start: 0, end: 1.5 }, { start: 30, end: 42 }, { end: "x" }, { start: 20, end: 30 }] } }),
    );
    await send(`/v2/apps/${appId}/proxy/${slug}/v1/listen?model=nova-3&utterances=true`, key, new Uint8Array([1]), { "content-type": "audio/wav" });
    // 42 seconds at $0.0043 a minute.
    expect(await chargesOf(appId)).toMatchObject([{ price_is_estimate: 1, cost_nano: 3_010_000 }]);
    expect(warnings.mock.calls.some((call) => String(call[0]).includes("usage_measure_worked_out"))).toBe(true);
  });

  it("logs every reason a charge is an estimate: a fallback model and a worked-out duration together", async () => {
    const { appId, slug, key } = await setup("deepgram", { operations: ["deepgram.listen"] });
    fetchSpy.mockResolvedValue(
      Response.json({
        metadata: { channels: 1, model_info: { "m-1": { arch: "enhanced", name: "general-enhanced", version: "1" } } },
        results: { channels: [{ detected_language: "fr" }], utterances: [{ end: 60 }] },
      }),
    );
    await send(`/v2/apps/${appId}/proxy/${slug}/v1/listen?model=nova-3&detect_language=true&utterances=true`, key, new Uint8Array([1]), {
      "content-type": "audio/wav",
    });
    expect(await chargesOf(appId)).toMatchObject([{ price_is_estimate: 1, cost_nano: 4_300_000 }]);
    const warned = warnings.mock.calls.map((call) => String(call[0]));
    expect(warned.some((line) => line.includes("usage_measure_worked_out"))).toBe(true);
    expect(warned.some((line) => line.includes("served_model_unexpected"))).toBe(true);
  });

  it("bills a long answer by its duration exactly, however many utterances it has, and by the latest utterance only without one", async () => {
    const { appId, slug, key } = await setup("deepgram", { operations: ["deepgram.listen"] });
    const utterances = Array.from({ length: 10_000 }, (_, index) => ({ start: index * 0.5, end: index * 0.5 + 0.4, transcript: "word ".repeat(8) }));
    fetchSpy
      .mockResolvedValueOnce(Response.json({ metadata: { duration: 5_000, channels: 1 }, results: { channels: [], utterances } }))
      .mockResolvedValueOnce(Response.json({ metadata: { channels: 1 }, results: { channels: [], utterances } }));
    const path = `/v2/apps/${appId}/proxy/${slug}/v1/listen?model=nova-3&utterances=true`;
    await send(path, key, new Uint8Array([1]), { "content-type": "audio/wav" });
    await send(path, key, new Uint8Array([1]), { "content-type": "audio/wav" });
    expect((await chargesOf(appId)).map((charge) => [charge.cost_nano, charge.price_is_estimate])).toEqual([
      // 5,000 seconds at $0.0043 a minute, exact.
      [358_333_334, 0],
      // No duration: the latest utterance end, 4,999.9 seconds, as an estimate.
      [358_326_167, 1],
    ]);
  });

  it("bills a duration exactly beside an utterance end too large to read", async () => {
    const { appId, slug, key } = await setup("deepgram", { operations: ["deepgram.listen"] });
    fetchSpy.mockResolvedValue(
      Response.json({ metadata: { duration: 60, channels: 1 }, results: { channels: [], utterances: [{ end: "9".repeat(70 * 1024) }, { end: 59.5 }] } }),
    );
    await send(`/v2/apps/${appId}/proxy/${slug}/v1/listen?model=nova-3&utterances=true`, key, new Uint8Array([1]), { "content-type": "audio/wav" });
    expect(await chargesOf(appId)).toMatchObject([{ price_is_estimate: 0, cost_nano: 4_300_000 }]);
  });

  it("refuses a request naming its model twice in the query, so the provider never runs a model nobody priced", async () => {
    const { appId, slug, key } = await setup("deepgram", { operations: ["deepgram.listen"] });
    const { response } = await send(`/v2/apps/${appId}/proxy/${slug}/v1/listen?model=nova-3&model=base`, key, new Uint8Array([1]), { "content-type": "audio/wav" });
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("writes a rewritten model into the query", async () => {
    await seedAccount();
    const { appId, slug, key } = await setup("deepgram", { operations: ["deepgram.listen"] });
    await env.DB.prepare("UPDATE app SET config_json = json_set(config_json, '$.routing.model_rewrites', json('{\"fast\":\"nova-3\"}')) WHERE id = ?").bind(appId).run();
    clearCaches();
    fetchSpy.mockResolvedValue(transcript(60));
    const { response } = await send(`/v2/apps/${appId}/proxy/${slug}/v1/listen?model=fast&punctuate=true`, key, new Uint8Array([1]), { "content-type": "audio/wav" });
    expect(response.status).toBe(200);
    const sent = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(sent.searchParams.get("model")).toBe("nova-3");
    expect(sent.searchParams.get("punctuate")).toBe("true");
    expect(await chargesOf(appId)).toMatchObject([{ model: "nova-3", cost_nano: 4_300_000 }]);
  });
});

describe("fal.run", () => {
  it("lists a short set of image models priced per megapixel, the unit fal's header reports", () => {
    expect(listPrice("fal", "fal-ai/flux/schnell")!.rates).toEqual({ per_unit: 3_000_000 });
    expect(listPrice("fal", "fal-ai/flux/dev")!.rates).toMatchObject({ per_unit: 25_000_000 });
    expect(listPrice("fal", "fal-ai/flux-pro/v1.1")!.rates).toMatchObject({ per_unit: 40_000_000 });
  });

  it("routes any model in the path; whether it is priced is decided when the call is resolved", () => {
    const matcher = new ProviderMatcher(fal);
    expect(matcher.match("POST", "run/fal-ai/flux/dev")).toMatchObject({ kind: "operation", operation: { name: "fal.run" } });
    expect(billing(fal.operations[0]!, priceSources({ type: "fal", rates: null }), "fal-ai/flux/dev")).toMatchObject({ problem: null });
    expect(billing(fal.operations[0]!, priceSources({ type: "fal", rates: null }), "fal-ai/other/model")).toMatchObject({ problem: "no_price" });
  });

  it("calls fal.run with the model in the path and bills the units fal reports", async () => {
    const { appId, slug, key } = await setup("fal", { operations: ["fal.run"] });
    fetchSpy.mockResolvedValue(Response.json({ images: [{ url: "https://fal.media/x.png" }] }, { headers: { "x-fal-billable-units": "4" } }));
    const { response } = await send(`/v2/apps/${appId}/proxy/${slug}/run/fal-ai/flux/dev`, key, JSON.stringify({ prompt: "a cat", num_images: 2 }), {
      "content-type": "application/json",
    });
    expect(response.status).toBe(200);
    const [input, init] = fetchSpy.mock.calls[0]!;
    expect(String(input)).toBe("https://fal.run/fal-ai/flux/dev");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Key ${SECRET}`);
    // 4 megapixels at $0.025 each.
    expect(await chargesOf(appId)).toMatchObject([
      { operation: "fal.run", model: "fal-ai/flux/dev", status: "ok", unit: "model_units", measured: "complete", cost_nano: 100_000_000 },
    ]);
  });

  it("bills one unit per image as an estimate when fal sends no units and the request names no size, never as free", async () => {
    const { appId, slug, key } = await setup("fal", { operations: ["fal.run"] });
    fetchSpy.mockResolvedValue(Response.json({ images: [{ url: "https://fal.media/x.png" }] }));
    await send(`/v2/apps/${appId}/proxy/${slug}/run/fal-ai/flux/schnell`, key, JSON.stringify({ prompt: "a cat", num_images: 3 }), { "content-type": "application/json" });
    expect(await chargesOf(appId)).toMatchObject([{ unit: "model_units", measured: "estimated", price_is_estimate: 1, cost_nano: 9_000_000 }]);
  });

  it("works the units out from the requested size when fal sends none: megapixels rounded up, per image", async () => {
    const { appId, slug, key } = await setup("fal", { operations: ["fal.run"] });
    fetchSpy.mockImplementation(async () => Response.json({ images: [] }));
    const sizes: [unknown, number, number][] = [
      // 2048 × 2048 is 4 megapixels; two images are 8 units at $0.025.
      [{ width: 2048, height: 2048 }, 2, 200_000_000],
      // 1440 × 1440 is 1.98 megapixels, rounded up to 2 (T15).
      [{ width: 1440, height: 1440 }, 1, 50_000_000],
      // A size name: 1024 × 576, one unit.
      ["landscape_16_9", 1, 25_000_000],
      // A size name fal may add later counts one unit per image.
      ["cinema_wide", 2, 50_000_000],
    ];
    for (const [image_size, num_images] of sizes) {
      await send(`/v2/apps/${appId}/proxy/${slug}/run/fal-ai/flux/dev`, key, JSON.stringify({ prompt: "a cat", image_size, num_images }), { "content-type": "application/json" });
    }
    expect((await chargesOf(appId)).map((charge) => [charge.cost_nano, charge.measured])).toEqual(sizes.map(([, , cost]) => [cost, "estimated"]));
  });

  it("takes fal's default side, 512, for a width or height a size object leaves out", async () => {
    const { appId, slug, key } = await setup("fal", { operations: ["fal.run"] });
    fetchSpy.mockImplementation(async () => Response.json({ images: [] }));
    // 2048 × 512 is exactly one megapixel; 512 × 3000 rounds up to two.
    for (const image_size of [{ width: 2048 }, { height: 3000 }]) {
      await send(`/v2/apps/${appId}/proxy/${slug}/run/fal-ai/flux/dev`, key, JSON.stringify({ prompt: "a cat", image_size }), { "content-type": "application/json" });
    }
    expect((await chargesOf(appId)).map((charge) => charge.cost_nano)).toEqual([25_000_000, 50_000_000]);
  });

  it("keeps the image count beside the megapixels, so a customer's price per image saves and bills", async () => {
    const own = { "fal-ai/flux/dev": { per_image: 10_000_000 } };
    expect(billing(fal.operations[0]!, priceSources({ type: "fal", rates: own }), "fal-ai/flux/dev")).toMatchObject({ problem: null });
    const { appId, slug, key } = await setup("fal", { operations: ["fal.run"] }, own);
    fetchSpy.mockResolvedValue(Response.json({ images: [] }));
    await send(`/v2/apps/${appId}/proxy/${slug}/run/fal-ai/flux/dev`, key, JSON.stringify({ prompt: "a cat", num_images: 2 }), { "content-type": "application/json" });
    expect(await chargesOf(appId)).toMatchObject([{ unit: "images", price_source: "customer_rate", price_is_estimate: 1, cost_nano: 20_000_000 }]);
  });

  it("bills the units fal reports over the size the request names", async () => {
    const { appId, slug, key } = await setup("fal", { operations: ["fal.run"] });
    fetchSpy.mockResolvedValue(Response.json({ images: [] }, { headers: { "x-fal-billable-units": "1" } }));
    await send(`/v2/apps/${appId}/proxy/${slug}/run/fal-ai/flux/dev`, key, JSON.stringify({ prompt: "a cat", image_size: { width: 2048, height: 2048 } }), {
      "content-type": "application/json",
    });
    expect(await chargesOf(appId)).toMatchObject([{ measured: "complete", price_is_estimate: 0, cost_nano: 25_000_000 }]);
  });

  it("refuses a model with no price, before sending anything", async () => {
    const { appId, slug, key } = await setup("fal", { operations: ["fal.run"] });
    const { response } = await send(`/v2/apps/${appId}/proxy/${slug}/run/fal-ai/unpriced/model`, key, JSON.stringify({ prompt: "x" }), { "content-type": "application/json" });
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

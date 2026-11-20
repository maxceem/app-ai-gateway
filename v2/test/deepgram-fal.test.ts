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

beforeEach(() => {
  clearCaches();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
    expect(nova.rates).toMatchObject({ per_minute: 4_300_000 });
    expect(keyCandidates(nova, { language: "multi" })).toMatchObject({ estimated: false, candidates: [{ price: { rates: { per_minute: 5_200_000 } } }] });
    // Any other language is the monolingual rate, a known price, not an estimate.
    expect(keyCandidates(nova, { language: "es" })).toMatchObject({ estimated: false, candidates: [{ price: { rates: { per_minute: 4_300_000 } } }] });
    expect(listPrice("deepgram", "whisper-large")!.rates).toMatchObject({ per_minute: 4_800_000 });
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

  it("serves an option billed on top at a price the gateway lacks, at the model's rate as an estimate", async () => {
    const { appId, slug, key } = await setup("deepgram", { operations: ["deepgram.listen"] });
    fetchSpy.mockResolvedValue(transcript(60));
    const { response } = await send(`/v2/apps/${appId}/proxy/${slug}/v1/listen?model=nova-3&redact=pii`, key, new Uint8Array([1]), { "content-type": "audio/wav" });
    expect(response.status).toBe(200);
    expect(await chargesOf(appId)).toMatchObject([{ unit: "audio_seconds", price_is_estimate: 1, cost_nano: 4_300_000 }]);
  });

  it("does not count an option turned off as one billed on top", async () => {
    const { appId, slug, key } = await setup("deepgram", { operations: ["deepgram.listen"] });
    fetchSpy.mockResolvedValue(transcript(60));
    await send(`/v2/apps/${appId}/proxy/${slug}/v1/listen?model=nova-3&redact=false`, key, new Uint8Array([1]), { "content-type": "audio/wav" });
    expect(await chargesOf(appId)).toMatchObject([{ price_is_estimate: 0 }]);
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
    expect(listPrice("fal", "fal-ai/flux/schnell")!.rates).toMatchObject({ per_unit: 3_000_000, per_image: 3_000_000 });
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

  it("bills the images asked for as an estimate when fal sends no units, never as free", async () => {
    const { appId, slug, key } = await setup("fal", { operations: ["fal.run"] });
    fetchSpy.mockResolvedValue(Response.json({ images: [{ url: "https://fal.media/x.png" }] }));
    await send(`/v2/apps/${appId}/proxy/${slug}/run/fal-ai/flux/schnell`, key, JSON.stringify({ prompt: "a cat", num_images: 3 }), { "content-type": "application/json" });
    expect(await chargesOf(appId)).toMatchObject([{ unit: "images", measured: "estimated", cost_nano: 9_000_000 }]);
  });

  it("refuses a model with no price, before sending anything", async () => {
    const { appId, slug, key } = await setup("fal", { operations: ["fal.run"] });
    const { response } = await send(`/v2/apps/${appId}/proxy/${slug}/run/fal-ai/unpriced/model`, key, JSON.stringify({ prompt: "x" }), { "content-type": "application/json" });
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

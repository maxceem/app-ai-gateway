/**
 * Today's providers' other APIs through the proxy (plan step 3a, part 2):
 * transcription, images, embeddings and speech, with v1's billing. The
 * provider is mocked at `fetch`.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../src/index.ts";
import { fromDollars, priceUnitsPer, rate } from "../src/money.ts";
import { listPrice } from "../src/pricing/prices.ts";
import { priceTokens, priceUsage } from "../src/pricing/tokens.ts";
import { BUILT_IN_PROVIDERS } from "../src/providers/index.ts";
import { ProviderMatcher } from "../src/providers/matcher.ts";
import { audioUsage, imagesUsage } from "../src/usage/readers.ts";
import { usageFromMeasures, usageMeasures } from "../src/usage/measures.ts";
import { STANDARD_MODE } from "../src/usage/service-modes.ts";
import { priceUnresolvedCharge } from "../src/ledger/corrections.ts";
import { sealSecret } from "../src/vault/secrets.ts";
import { ACCOUNT_ID, clearCaches, seedAccount, seedAppKey, seedRoutedApp } from "./helpers.ts";

const ORIGIN = "https://gateway.test";
const SECRET = "sk-test-provider-key-5678";

async function setup(type: string, routing: Record<string, unknown>): Promise<{ appId: string; slug: string; key: string }> {
  await seedAccount();
  const id = crypto.randomUUID().replaceAll("-", "");
  const slug = `${type}-${id.slice(0, 6)}`;
  const blob = await sealSecret(env, "providerKey", [ACCOUNT_ID, id, type, ""], SECRET);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO provider_connection
      (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, rates_json, revision, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, '5678', NULL, NULL, 1, 'usr_test', ?, ?)`,
  )
    .bind(id, ACCOUNT_ID, type, slug, type, blob, now, now)
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
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, text };
}

const json = (path: string, key: string, body: Record<string, unknown>) => send(path, key, JSON.stringify(body), { "content-type": "application/json" });

/** A multipart body as the client would send it: its bytes and content type. */
async function multipart(fields: Record<string, string | Blob | readonly string[]>): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string }> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const one of value) form.append(name, one);
    else form.append(name, value as string | Blob);
  }
  const request = new Request("https://local.invalid", { method: "POST", body: form });
  return { bytes: new Uint8Array(await request.arrayBuffer()), contentType: request.headers.get("content-type")! };
}

async function upload(path: string, key: string, fields: Record<string, string | Blob | readonly string[]>) {
  const { bytes, contentType } = await multipart(fields);
  return { ...(await send(path, key, bytes, { "content-type": contentType })), bytes, contentType };
}

async function chargesOf(appId: string): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("SELECT * FROM charge WHERE app_id = ? ORDER BY written_at, id").bind(appId).all();
  return results;
}

let fetchSpy: MockInstance<typeof fetch>;

/** The form the provider was sent, parsed back. */
async function sentForm(index = 0): Promise<{ url: string; headers: Headers; form: FormData }> {
  const [input, init] = fetchSpy.mock.calls[index]!;
  const headers = new Headers(init?.headers);
  const request = new Request("https://local.invalid", {
    method: "POST",
    body: init?.body as BodyInit,
    ...(headers.has("content-type") ? { headers: { "content-type": headers.get("content-type")! } } : {}),
  });
  return { url: String(input), headers, form: await request.formData() };
}

const AUDIO = new Blob([new Uint8Array(2048).fill(7)], { type: "audio/mpeg" });

beforeEach(() => {
  clearCaches();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => vi.restoreAllMocks());

describe("paths v1 served", () => {
  it("declares transcription at v1's three paths on every provider but OpenRouter", () => {
    for (const description of Object.values(BUILT_IN_PROVIDERS)) {
      if (description.type === "elevenlabs" || description.type === "fal") continue;
      const matcher = new ProviderMatcher(description);
      for (const path of ["v1/audio/transcriptions", "openai/v1/audio/transcriptions", "v1/stt"]) {
        const match = matcher.match("POST", path);
        if (description.type === "openrouter") expect(match, path).toMatchObject({ kind: "refused" });
        else expect(match, `${description.type} ${path}`).toMatchObject({ kind: "operation", operation: { style: "openai-transcription" } });
      }
    }
  });

  it("declares each provider's own image, embedding and speech paths, as v1 served them", () => {
    const cases: [string, string, string][] = [
      ["openai", "v1/images/generations", "openai-images"],
      ["openai", "v1/images/edits", "openai-images"],
      ["openai", "v1/embeddings", "openai-embeddings"],
      ["openai", "v1/audio/speech", "openai-speech"],
      ["xai", "v1/images/edits", "openai-images"],
      ["xai", "v1/embeddings", "openai-embeddings"],
      ["gemini", "v1beta/models/gemini-embedding-001:embedContent", "gemini-embed"],
      ["gemini", "v1/models/gemini-embedding-001:embedContent", "gemini-embed"],
      ["perplexity", "v1/contextualizedembeddings", "openai-embeddings"],
      ["groq", "openai/v1/audio/speech", "openai-speech"],
      ["mistral", "v1/audio/speech", "openai-speech"],
      ["together", "v1/images/generations", "openai-images"],
      ["fireworks", "inference/v1/embeddings", "openai-embeddings"],
      ["bytedance", "images/generations", "openai-images"],
      ["bytedance", "embeddings/multimodal", "openai-embeddings"],
    ];
    for (const [type, path, style] of cases) {
      expect(new ProviderMatcher(BUILT_IN_PROVIDERS[type]!).match("POST", path), `${type} ${path}`).toMatchObject({
        kind: "operation",
        operation: { style },
      });
    }
  });
});

describe("transcription", () => {
  it("bills a time-priced model on the seconds it reports, forwarding the upload's own bytes", async () => {
    const { appId, slug, key } = await setup("openai", { operations: ["openai.transcription"] });
    // The upload is read in place, never parsed whole: parsing it would copy every byte.
    const parsedWhole = vi.spyOn(Request.prototype, "formData");
    fetchSpy.mockResolvedValue(Response.json({ text: "hello", usage: { type: "duration", seconds: 12.34 } }));
    const { response, bytes, contentType } = await upload(`/v2/apps/${appId}/proxy/${slug}/v1/audio/transcriptions`, key, {
      model: "whisper-1",
      file: AUDIO,
    });
    expect(response.status).toBe(200);
    const [input, init] = fetchSpy.mock.calls[0]!;
    expect(String(input)).toBe("https://api.openai.com/v1/audio/transcriptions");
    // Untouched: the same bytes, with the client's boundary.
    expect(new Uint8Array(init?.body as Uint8Array)).toEqual(bytes);
    expect(new Headers(init?.headers).get("content-type")).toBe(contentType);
    // $0.006 a minute on 12.34 s, priced once on the milliseconds and rounded up.
    const cost = priceUnitsPer(12_340, listPrice("openai", "whisper-1")!.rates.per_minute!, 60_000);
    expect(cost).toBe(1_234_000);
    expect(await chargesOf(appId)).toMatchObject([
      { operation: "openai.transcription", model: "whisper-1", status: "ok", price_source: "list_rate", cost_nano: cost, unit: "audio_seconds", units: 12_340 },
    ]);
    expect(parsedWhole).not.toHaveBeenCalled();
  });

  it("serves forms the fast scanner cannot read through the platform's parser, with the model read right", async () => {
    const { appId, slug, key } = await setup("openai", { operations: ["openai.transcription"] });
    fetchSpy.mockImplementation(async () => Response.json({ text: "hi", usage: { type: "duration", seconds: 6 } }));
    const parsedWhole = vi.spyOn(Request.prototype, "formData");
    const boundary = "fallbackB";
    const forms = [
      // A folded Content-Disposition header.
      `--${boundary}\r\nContent-Disposition: form-data;\r\n name="model"\r\n\r\nwhisper-1\r\n`,
      // A filename in Latin-1, which is not UTF-8.
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="caf\u00e9.mp3"\r\n\r\naudio\r\n`,
    ];
    for (const [index, text] of forms.entries()) {
      // Latin-1 bytes, one per character, so é is the single byte 0xE9.
      const bytes = Uint8Array.from(`${text}--${boundary}--\r\n`, (character) => character.charCodeAt(0));
      const { response } = await send(`/v2/apps/${appId}/proxy/${slug}/v1/audio/transcriptions`, key, bytes, { "content-type": `multipart/form-data; boundary=${boundary}` });
      expect(response.status, `form ${index}`).toBe(200);
      // Untouched: the client's own bytes go on.
      expect(new Uint8Array(fetchSpy.mock.calls[index]![1]?.body as Uint8Array)).toEqual(bytes);
    }
    expect(parsedWhole).toHaveBeenCalledTimes(2);
    expect(await chargesOf(appId)).toMatchObject([
      { model: "whisper-1", unit: "audio_seconds", units: 6000 },
      { model: "whisper-1", unit: "audio_seconds", units: 6000 },
    ]);
  });

  it("refuses a form the platform's parser refuses too", async () => {
    const { appId, slug, key } = await setup("openai", { operations: ["openai.transcription"] });
    const { response, text } = await send(`/v2/apps/${appId}/proxy/${slug}/v1/audio/transcriptions`, key, "--b\r\nno disposition\r\n\r\nx\r\n--b--", {
      "content-type": "multipart/form-data; boundary=b",
    });
    expect(response.status).toBe(400);
    expect(text).toContain("invalid_request");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serves an xAI form with only the audio, billed as grok-transcribe and sent unchanged, as v1", async () => {
    const { appId, slug, key } = await setup("xai", { operations: ["xai.transcription"] });
    fetchSpy.mockResolvedValue(Response.json({ text: "hello", duration: 1.25 }));
    const { response, bytes } = await upload(`/v2/apps/${appId}/proxy/${slug}/v1/stt`, key, { file: AUDIO });
    expect(response.status).toBe(200);
    expect(new Uint8Array(fetchSpy.mock.calls[0]![1]?.body as Uint8Array)).toEqual(bytes);
    expect(await chargesOf(appId)).toMatchObject([
      { model: "grok-transcribe", unit: "audio_seconds", units: 1250, cost_nano: priceUnitsPer(1250, listPrice("xai", "grok-transcribe")!.rates.per_hour!, 3_600_000) },
    ]);
  });

  it("refuses a call to an operation that cannot bill the listed model's unit, though the app lists it for another", async () => {
    const { appId, slug, key } = await setup("openai", { operations: ["openai.chat", "openai.transcription"], models: ["gpt-4o-mini", "whisper-1"] });
    const { response, text } = await json(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, key, { model: "whisper-1", messages: [] });
    expect(response.status).toBe(400);
    expect(text).toContain("pricing_not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("bills a token-priced model on its tokens, even when the answer also states a duration", async () => {
    const { appId, slug, key } = await setup("openai", { operations: ["openai.transcription"] });
    fetchSpy.mockResolvedValue(Response.json({ text: "hi", duration: 3, usage: { input_tokens: 40, output_tokens: 6, total_tokens: 46 } }));
    await upload(`/v2/apps/${appId}/proxy/${slug}/v1/audio/transcriptions`, key, { model: "gpt-4o-transcribe", file: AUDIO });
    const usage = { inputTokens: 40, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 6 };
    expect(await chargesOf(appId)).toMatchObject([
      { cost_nano: priceTokens(listPrice("openai", "gpt-4o-transcribe")!, usage)!.cost, unit: "tokens", units: 46, input_tokens: 40 },
    ]);
  });

  it("leaves a time-priced answer that reports only tokens unpriced, with nothing for the sweep", async () => {
    const { appId, slug, key } = await setup("openai", { operations: ["openai.transcription"] });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchSpy.mockResolvedValue(Response.json({ text: "hi", usage: { input_tokens: 40, output_tokens: 6 } }));
    await upload(`/v2/apps/${appId}/proxy/${slug}/v1/audio/transcriptions`, key, { model: "whisper-1", file: AUDIO });
    const [charge] = await chargesOf(appId);
    expect(charge).toMatchObject({ price_source: "unresolved", cost_nano: null, input_tokens: 40 });
    expect(await env.DB.prepare("SELECT 1 FROM open_work WHERE charge_id = ?").bind(charge!.id).first()).toBeNull();
    expect(errors.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("no_priced_measure"));
  });

  it("refuses a format whose answer carries no usage, before the provider and before admission", async () => {
    const { appId, slug, key } = await setup("openai", { operations: ["openai.transcription"] });
    const { response, text } = await upload(`/v2/apps/${appId}/proxy/${slug}/v1/audio/transcriptions`, key, {
      model: "whisper-1",
      response_format: "text",
      file: AUDIO,
    });
    expect(response.status).toBe(400);
    expect(text).toContain("json or verbose_json or diarized_json");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends Groq's json as the verbose_json that extends it, in a fresh form, and bills it by the hour", async () => {
    const { appId, slug, key } = await setup("groq", { operations: ["groq.transcription.openai"] });
    fetchSpy.mockResolvedValue(Response.json({ text: "hi", duration: 90, segments: [] }));
    const { response } = await upload(`/v2/apps/${appId}/proxy/${slug}/openai/v1/audio/transcriptions`, key, {
      model: "whisper-large-v3",
      file: AUDIO,
    });
    expect(response.status).toBe(200);
    const { url, form, headers } = await sentForm();
    expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("model")).toBe("whisper-large-v3");
    expect(form.get("file")).toBeInstanceOf(File);
    expect(headers.get("content-type")).toBeNull();
    // $0.111 an hour on 90 s.
    expect(await chargesOf(appId)).toMatchObject([
      { unit: "audio_seconds", units: 90_000, cost_nano: priceUnitsPer(90_000, listPrice("groq", "whisper-large-v3")!.rates.per_hour!, 3_600_000) },
    ]);
  });

  it("refuses a form it must rebuild but cannot parse before admission, so it spends no request limit", async () => {
    const { appId, slug, key } = await setup("groq", { operations: ["groq.transcription.openai"] });
    await env.DB.prepare("UPDATE app SET config_json = json_set(config_json, '$.limits', json(?)) WHERE id = ?")
      .bind(JSON.stringify({ per_app: { requests: { per_minute: 1 } } }), appId)
      .run();
    clearCaches();
    // A form the scanner reads that the platform's parser still refuses.
    vi.spyOn(Request.prototype, "formData").mockRejectedValueOnce(new TypeError("unreadable form"));
    const refused = await upload(`/v2/apps/${appId}/proxy/${slug}/openai/v1/audio/transcriptions`, key, { model: "whisper-large-v3", file: AUDIO });
    expect(refused.response.status).toBe(400);
    expect(refused.text).toContain("invalid_request");
    expect(fetchSpy).not.toHaveBeenCalled();
    // The app's one request a minute is still there.
    fetchSpy.mockResolvedValue(Response.json({ text: "hi", duration: 3 }));
    const served = await upload(`/v2/apps/${appId}/proxy/${slug}/openai/v1/audio/transcriptions`, key, { model: "whisper-large-v3", file: AUDIO });
    expect(served.response.status).toBe(200);
  });

  it("refuses a form that names its model twice, and a transcription sent as JSON to a provider that judges its format", async () => {
    const { appId, slug, key } = await setup("openai", { operations: ["openai.transcription"] });
    const twice = await upload(`/v2/apps/${appId}/proxy/${slug}/v1/audio/transcriptions`, key, { model: ["whisper-1", "gpt-4o-transcribe"], file: AUDIO });
    expect(twice.response.status).toBe(400);
    expect(twice.text).toContain("more than once");
    const asJson = await json(`/v2/apps/${appId}/proxy/${slug}/v1/audio/transcriptions`, key, { model: "whisper-1" });
    expect(asJson.response.status).toBe(400);
    expect(asJson.text).toContain("multipart/form-data");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forwards a JSON transcription to a provider that does not judge its format, as v1, priced by the hour", async () => {
    const { appId, slug, key } = await setup("xai", { operations: ["xai.transcription"] });
    fetchSpy.mockResolvedValue(Response.json({ text: "hi", duration: 36 }));
    const { response } = await json(`/v2/apps/${appId}/proxy/${slug}/v1/stt`, key, { model: "grok-transcribe", url: "https://example.com/a.mp3" });
    expect(response.status).toBe(200);
    expect(new Headers(fetchSpy.mock.calls[0]![1]?.headers).get("content-type")).toBe("application/json");
    expect(await chargesOf(appId)).toMatchObject([
      { unit: "audio_seconds", units: 36_000, cost_nano: priceUnitsPer(36_000, listPrice("xai", "grok-transcribe")!.rates.per_hour!, 3_600_000) },
    ]);
  });
});

describe("images", () => {
  it("bills OpenAI's image tokens at the image rate", async () => {
    const { appId, slug, key } = await setup("openai", { operations: ["openai.images"] });
    const usage = { input_tokens: 50, output_tokens: 4160, input_tokens_details: { text_tokens: 20, image_tokens: 30 } };
    fetchSpy.mockResolvedValue(Response.json({ data: [{ b64_json: "AAAA" }], usage }));
    const { response } = await json(`/v2/apps/${appId}/proxy/${slug}/v1/images/generations`, key, { model: "gpt-image-1", prompt: "a cat", background: "transparent" });
    expect(response.status).toBe(200);
    const expected = priceTokens(listPrice("openai", "gpt-image-1")!, {
      inputTokens: 50,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 4160,
      modalityTokens: { input: { image: 30 } },
    })!.cost;
    expect(await chargesOf(appId)).toMatchObject([{ operation: "openai.images", unit: "tokens", cost_nano: expected }]);
  });

  it("reads the model of an image edit from its form", async () => {
    const { appId, slug, key } = await setup("openai", { operations: ["openai.images.edits"] });
    fetchSpy.mockResolvedValue(Response.json({ data: [], usage: { input_tokens: 10, output_tokens: 100 } }));
    const { response } = await upload(`/v2/apps/${appId}/proxy/${slug}/v1/images/edits`, key, { model: "gpt-image-1", prompt: "hat", image: AUDIO });
    expect(response.status).toBe(200);
    expect(await chargesOf(appId)).toMatchObject([{ model: "gpt-image-1", price_source: "list_rate" }]);
  });

  it("bills Seedream per image made", async () => {
    const { appId, slug, key } = await setup("bytedance", { operations: ["bytedance.images"] });
    fetchSpy.mockResolvedValue(Response.json({ data: [{}, {}], usage: { generated_images: 2, output_tokens: 16384, total_tokens: 16384 } }));
    await json(`/v2/apps/${appId}/proxy/${slug}/images/generations`, key, { model: "seedream-4-0-250828", prompt: "a cat" });
    expect(await chargesOf(appId)).toMatchObject([{ unit: "images", units: 2, cost_nano: fromDollars(0.06) }]);
  });

  it("never bills an image answer with no token counts as $0 for a token-priced model", async () => {
    const { appId, slug, key } = await setup("openai", { operations: ["openai.images"] });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchSpy.mockResolvedValue(Response.json({ data: [{}], usage: { generated_images: 1 } }));
    await json(`/v2/apps/${appId}/proxy/${slug}/v1/images/generations`, key, { model: "gpt-image-1", prompt: "a cat" });
    const [charge] = await chargesOf(appId);
    expect(charge).toMatchObject({ price_source: "unresolved", cost_nano: null, unit: "tokens", units: 0 });
    expect(errors.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("no_priced_measure"));
    // Nor later, when the sweep tries: the measures say no tokens were reported.
    expect(await priceUnresolvedCharge(env.DB, { chargeId: String(charge!.id), now: Date.now() })).toMatchObject({ status: "no_price" });
  });

  it("bills xAI's images at the cost it reports", async () => {
    const { appId, slug, key } = await setup("xai", { operations: ["xai.images"] });
    fetchSpy.mockResolvedValue(Response.json({ data: [{}], usage: { cost_in_usd_ticks: 200_000_000 } }));
    await json(`/v2/apps/${appId}/proxy/${slug}/v1/images/generations`, key, { model: "grok-imagine-image", prompt: "a cat" });
    expect(await chargesOf(appId)).toMatchObject([{ price_source: "provider_usd", cost_nano: fromDollars(0.02) }]);
  });
});

describe("embeddings and speech", () => {
  it("bills OpenAI embeddings on their input tokens", async () => {
    const { appId, slug, key } = await setup("openai", { operations: ["openai.embeddings"] });
    fetchSpy.mockResolvedValue(Response.json({ data: [], usage: { prompt_tokens: 1000, total_tokens: 1000 } }));
    await json(`/v2/apps/${appId}/proxy/${slug}/v1/embeddings`, key, { model: "text-embedding-3-small", input: "hi" });
    expect(await chargesOf(appId)).toMatchObject([{ operation: "openai.embeddings", input_tokens: 1000, output_tokens: 0, cost_nano: 20_000 }]);
  });

  it("reads Gemini's embedding model from the path", async () => {
    const { appId, slug, key } = await setup("gemini", { operations: ["gemini.embed.v1beta"] });
    fetchSpy.mockResolvedValue(Response.json({ embedding: { values: [0.1] }, usageMetadata: { promptTokenCount: 2000 } }));
    const { response } = await json(`/v2/apps/${appId}/proxy/${slug}/v1beta/models/gemini-embedding-001:embedContent`, key, { content: { parts: [] } });
    expect(response.status).toBe(200);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent");
    expect(await chargesOf(appId)).toMatchObject([{ model: "gemini-embedding-001", input_tokens: 2000, cost_nano: 300_000 }]);
  });

  it("prices speech streamed as events from its usage, and leaves plain audio's cost unknown, as v1", async () => {
    const { appId, slug, key } = await setup("openai", { operations: ["openai.speech"] });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const events = `data: ${JSON.stringify({ type: "speech.audio.delta", audio: "AAAA" })}\n\ndata: ${JSON.stringify({ type: "speech.audio.done", usage: { input_tokens: 10, output_tokens: 200, total_tokens: 210 } })}\n\n`;
    fetchSpy.mockResolvedValueOnce(new Response(events, { headers: { "content-type": "text/event-stream" } }));
    fetchSpy.mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xf3, 0x44, 0xc4]), { headers: { "content-type": "audio/mpeg" } }));
    await json(`/v2/apps/${appId}/proxy/${slug}/v1/audio/speech`, key, { model: "gpt-4o-mini-tts", input: "hi", stream_format: "sse" });
    await json(`/v2/apps/${appId}/proxy/${slug}/v1/audio/speech`, key, { model: "gpt-4o-mini-tts", input: "hi" });
    const usage = { inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 200 };
    expect(await chargesOf(appId)).toMatchObject([
      { status: "ok", cost_nano: priceTokens(listPrice("openai", "gpt-4o-mini-tts")!, usage)!.cost },
      { status: "ok", measured: "estimated", price_source: "unresolved", cost_nano: null },
    ]);
    expect(errors.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("no_usage_reported"));
  });
});

describe("usage in other units", () => {
  it("reads every measure a transcription reports, usage.seconds before duration", () => {
    expect(audioUsage({ usage: { type: "duration", seconds: 4 }, duration: 9 })).toMatchObject({ audioSeconds: 4, noTokens: true });
    expect(audioUsage({ duration: 9 })).toMatchObject({ audioSeconds: 9, inputTokens: 0 });
    expect(audioUsage({ usage: { prompt_tokens: 5, completion_tokens: 1, prompt_audio_seconds: 2.5 } })).toMatchObject({ audioSeconds: 2.5, inputTokens: 5 });
    expect(audioUsage({ text: "no measure" })).toBeNull();
    expect(imagesUsage({ usage: { generated_images: 3 } })).toMatchObject({ images: 3, inputTokens: 0, noTokens: true });
    expect(imagesUsage({ usage: { generated_images: 2, output_tokens: 10 } })).toEqual(expect.not.objectContaining({ noTokens: true }));
    // A count is a whole number: 0.5 images is no count at all.
    expect(imagesUsage({ usage: { generated_images: 0.5 } })).toBeNull();
  });

  it("prices time once on whole milliseconds, rounding up, and never bills a missing measure", () => {
    const whisper = listPrice("openai", "whisper-1")!;
    // 1 ms at $0.006 a minute is a tenth of a nano-dollar: it rounds up to 1, never 0.
    expect(priceUsage(whisper, { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, audioSeconds: 0.001 })!.cost).toBe(100);
    expect(priceUnitsPer(1, rate(6_000_000), 60_000)).toBe(100);
    expect(priceUnitsPer(1, rate(1), 60_000)).toBe(1);
    expect(priceUsage(whisper, { inputTokens: 5, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 })).toBeNull();
    expect(priceUsage(listPrice("openai", "gpt-4o-transcribe")!, { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, audioSeconds: 3, noTokens: true })).toBeNull();
  });

  it("keeps the seconds and images in the charge's measures, so the sweep prices them exactly", () => {
    const usage = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, audioSeconds: 12.345, images: 2, noTokens: true as const };
    const back = usageFromMeasures(usageMeasures(usage, STANDARD_MODE))!;
    expect(back.usage).toMatchObject({ audioSeconds: 12.345, images: 2, noTokens: true });
  });

  it("lets the sweep price an unresolved time-priced charge on its stored seconds", async () => {
    const { appId, slug, key } = await setup("openai", { operations: ["openai.transcription"], models: ["whisper-1"] });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchSpy.mockResolvedValue(Response.json({ text: "hi", usage: { type: "duration", seconds: 60 } }));
    await upload(`/v2/apps/${appId}/proxy/${slug}/v1/audio/transcriptions`, key, { model: "whisper-1", file: AUDIO });
    const [charge] = await chargesOf(appId);
    // As if the price had been missing when the call was made.
    await env.DB.prepare("UPDATE charge SET price_source = 'unresolved', cost_nano = NULL WHERE id = ?").bind(charge!.id).run();
    const result = await priceUnresolvedCharge(env.DB, { chargeId: String(charge!.id), now: Date.now() });
    expect(result).toMatchObject({ status: "priced", correction: { costNano: 6_000_000 } });
  });
});

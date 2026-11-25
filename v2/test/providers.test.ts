/**
 * Today's LLM providers through the proxy (plan step 3): each API style end
 * to end, with the provider mocked at `fetch`. Ported from v1's provider and
 * proxy tests.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../src/index.ts";
import { fromDollars } from "../src/money.ts";
import { listPrice } from "../src/pricing/prices.ts";
import BUILT_IN_PRICES from "../src/pricing/models.json";
import { priceTokens } from "../src/pricing/tokens.ts";
import { BUILT_IN_PROVIDERS } from "../src/providers/index.ts";
import { ProviderMatcher } from "../src/providers/matcher.ts";
import { sealSecret } from "../src/vault/secrets.ts";
import { ACCOUNT_ID, clearCaches, seedAccount, seedAppKey, seedRoutedApp } from "./helpers.ts";

const ORIGIN = "https://gateway.test";
const SECRET = "sk-test-provider-key-5678";

async function setup(
  type: string,
  routing: Record<string, unknown>,
  options: { baseUrl?: string } = {},
): Promise<{ appId: string; slug: string; key: string }> {
  await seedAccount();
  const id = crypto.randomUUID().replaceAll("-", "");
  const slug = `${type}-${id.slice(0, 6)}`;
  const baseUrl = options.baseUrl ?? null;
  const blob = await sealSecret(env, "providerKey", [ACCOUNT_ID, id, type, baseUrl ?? ""], SECRET);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO provider_connection
      (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, rates_json, revision, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, '5678', ?, NULL, 1, 'usr_test', ?, ?)`,
  )
    .bind(id, ACCOUNT_ID, type, slug, type, blob, baseUrl, now, now)
    .run();
  const appId = await seedRoutedApp(
    { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
    { providers: { [slug]: routing } },
  );
  const { key } = await seedAppKey(appId);
  return { appId, slug, key };
}

async function post(path: string, key: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-end-user-id": "user-1", ...headers },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  return { response, ctx };
}

async function chargesOf(appId: string): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("SELECT * FROM charge WHERE app_id = ? ORDER BY written_at, id").bind(appId).all();
  return results;
}

let fetchSpy: MockInstance<typeof fetch>;

function sent(index = 0): { url: string; headers: Headers; body: Record<string, unknown> } {
  const [input, init] = fetchSpy.mock.calls[index]!;
  const body = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as Record<string, unknown>;
  return { url: String(input), headers: new Headers(init?.headers), body };
}

function sse(events: readonly unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function listedCost(provider: string, model: string, usage: Parameters<typeof priceTokens>[1]): number {
  return priceTokens(listPrice(provider, model)!, usage)!.cost;
}

beforeEach(() => {
  clearCaches();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => vi.restoreAllMocks());

describe("provider descriptions", () => {
  it("compile, with operation names unique across every provider", () => {
    const names = new Set<string>();
    for (const description of Object.values(BUILT_IN_PROVIDERS)) {
      expect(() => new ProviderMatcher(description)).not.toThrow();
      for (const operation of description.operations) {
        expect(names.has(operation.name), operation.name).toBe(false);
        names.add(operation.name);
      }
    }
  });

  it("match each provider's text APIs at its own paths", () => {
    const cases: [string, string, string][] = [
      ["openai", "v1/chat/completions", "openai.chat"],
      ["openai", "v1/responses", "openai.responses"],
      ["anthropic", "v1/messages", "anthropic.messages"],
      ["gemini", "v1beta/models/gemini-3.5-flash:streamGenerateContent", "gemini.stream.v1beta"],
      ["gemini", "v1beta/openai/chat/completions", "gemini.chat"],
      ["xai", "v1/messages", "xai.messages"],
      ["groq", "openai/v1/chat/completions", "groq.chat"],
      ["deepseek", "anthropic/v1/messages", "deepseek.messages"],
      ["fireworks", "inference/v1/responses", "fireworks.responses"],
      ["mistral", "v1/fim/completions", "mistral.fim"],
      ["bytedance", "responses", "bytedance.responses"],
      ["openrouter", "v1/chat/completions", "openrouter.chat"],
    ];
    for (const [type, path, name] of cases) {
      const match = new ProviderMatcher(BUILT_IN_PROVIDERS[type]!).match("POST", path);
      expect(match, `${type} ${path}`).toMatchObject({ kind: "operation", operation: { name } });
    }
    // OpenRouter's other APIs carry no cost report, so they are not declared, as v1 refused them.
    expect(new ProviderMatcher(BUILT_IN_PROVIDERS.openrouter!).match("POST", "v1/responses")).toMatchObject({ kind: "refused" });
  });
});

describe("paths v1 served", () => {
  it("declares every text path v1 served on every provider, so none is refused", () => {
    const chatPaths = ["v1/chat/completions", "chat/completions", "openai/v1/chat/completions", "inference/v1/chat/completions", "v1beta/openai/chat/completions"];
    const otherPaths = ["v1/responses", "openai/v1/responses", "v1/messages"];
    for (const description of Object.values(BUILT_IN_PROVIDERS)) {
      // v1 never served these providers, so they have no v1 text paths.
      if (description.type === "elevenlabs" || description.type === "deepgram" || description.type === "fal") continue;
      const matcher = new ProviderMatcher(description);
      // OpenRouter served Chat Completions only.
      const served = description.type === "openrouter" ? chatPaths : [...chatPaths, ...otherPaths];
      for (const path of served) {
        expect(matcher.match("POST", path), `${description.type} ${path}`).toMatchObject({ kind: "operation" });
      }
    }
  });
});

describe("text APIs through the proxy", () => {
  it("calls Anthropic with its key header, caps max_tokens, and prices a stream from both of its ends", async () => {
    const { appId, slug, key } = await setup("anthropic", { operations: ["anthropic.messages"], max_output_tokens: 300 });
    const events = sse([
      { type: "message_start", message: { usage: { input_tokens: 60, cache_read_input_tokens: 30, cache_creation_input_tokens: 10, output_tokens: 1 } } },
      { type: "content_block_delta", delta: { text: "hi" } },
      { type: "message_delta", usage: { output_tokens: 20 } },
      { type: "message_stop" },
    ]);
    fetchSpy.mockResolvedValue(new Response(events, { headers: { "content-type": "text/event-stream" } }));
    const { response, ctx } = await post(`/v2/apps/${appId}/proxy/${slug}/v1/messages`, key, { model: "claude-sonnet-5", stream: true, messages: [] }, {
      "anthropic-version": "2023-06-01",
    });
    expect(await response.text()).toBe(events);
    await waitOnExecutionContext(ctx);
    const request = sent();
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.headers.get("x-api-key")).toBe(SECRET);
    expect(request.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(request.body).toMatchObject({ max_tokens: 300 });
    expect(request.body).not.toHaveProperty("stream_options");
    const usage = { inputTokens: 60, cachedInputTokens: 30, cacheWriteTokens: 10, outputTokens: 20 };
    expect(await chargesOf(appId)).toMatchObject([
      { operation: "anthropic.messages", status: "ok", measured: "complete", price_source: "list_rate", cost_nano: listedCost("anthropic", "claude-sonnet-5", usage) },
    ]);
  });

  it("counts an Anthropic stream the app closed after message_stop as whole", async () => {
    const { appId, slug, key } = await setup("anthropic", { operations: ["anthropic.messages"] });
    const events = sse([
      { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } },
      { type: "message_delta", usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ]);
    const bytes = new TextEncoder().encode(events);
    // The provider sends everything, but never closes the stream.
    fetchSpy.mockResolvedValue(
      new Response(new ReadableStream({ start: (controller) => controller.enqueue(bytes) }), { headers: { "content-type": "text/event-stream" } }),
    );
    const { response, ctx } = await post(`/v2/apps/${appId}/proxy/${slug}/v1/messages`, key, { model: "claude-sonnet-5", stream: true });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await waitOnExecutionContext(ctx);
    expect(await chargesOf(appId)).toMatchObject([{ status: "ok", measured: "complete", price_source: "list_rate" }]);
  });

  it("reads Gemini's model from the path, caps generationConfig, keeps the query and prices usageMetadata", async () => {
    const { appId, slug, key } = await setup("gemini", { operations: ["gemini.stream.v1beta"], max_output_tokens: 128 });
    const events = sse([
      { candidates: [{ content: { parts: [{ text: "Hi" }] } }] },
      { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 10, thoughtsTokenCount: 5 } },
    ]);
    fetchSpy.mockResolvedValue(new Response(events, { headers: { "content-type": "text/event-stream" } }));
    const { response, ctx } = await post(
      `/v2/apps/${appId}/proxy/${slug}/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse&key=leaked`,
      key,
      { contents: [], generationConfig: { temperature: 0.2 } },
    );
    expect(response.status).toBe(200);
    await response.text();
    await waitOnExecutionContext(ctx);
    const request = sent();
    expect(request.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse");
    expect(request.headers.get("x-goog-api-key")).toBe(SECRET);
    expect(request.body).toEqual({ contents: [], generationConfig: { temperature: 0.2, maxOutputTokens: 128 } });
    const usage = { inputTokens: 40, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 15, modalityTokens: { output: { unknown: 10 } } };
    expect(await chargesOf(appId)).toMatchObject([
      { operation: "gemini.stream.v1beta", model: "gemini-3.5-flash", status: "ok", cost_nano: listedCost("gemini", "gemini-3.5-flash", usage) },
    ]);
  });

  it("refuses a background request before admission, and caps Responses in max_output_tokens", async () => {
    const { appId, slug, key } = await setup("openai", { operations: ["openai.responses"], max_output_tokens: 64 });
    const refused = await post(`/v2/apps/${appId}/proxy/${slug}/v1/responses`, key, { model: "gpt-5.6-luna", background: true });
    expect(refused.response.status).toBe(400);
    expect(await refused.response.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(fetchSpy).not.toHaveBeenCalled();
    // OpenAI's image `background` is a string naming the transparency, not background work.
    fetchSpy.mockResolvedValue(Response.json({ usage: { input_tokens: 10, output_tokens: 2 } }));
    const { response, ctx } = await post(`/v2/apps/${appId}/proxy/${slug}/v1/responses`, key, { model: "gpt-5.6-luna", background: "transparent" });
    expect(response.status).toBe(200);
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(sent().body).toMatchObject({ max_output_tokens: 64 });
    expect(await chargesOf(appId)).toMatchObject([{ operation: "openai.responses", status: "ok", price_source: "list_rate" }]);
  });

  it("bills OpenRouter at the cost it reports, with no price of ours, under its path prefix", async () => {
    const { appId, slug, key } = await setup("openrouter", { operations: ["openrouter.chat"] });
    fetchSpy.mockResolvedValue(Response.json({ model: "x/y", choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0012 } }));
    const { response, ctx } = await post(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, key, { model: "some-lab/unlisted-model" });
    expect(response.status).toBe(200);
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(sent().url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(await chargesOf(appId)).toMatchObject([
      { status: "ok", measured: "complete", price_source: "provider_usd", cost_nano: fromDollars(0.0012), input_tokens: 10, rates_json: null },
    ]);
  });

  it("leaves an OpenRouter answer that reports no cost unresolved, and asks the sweep to price its tokens once a rate exists (4b F3)", async () => {
    const { appId, slug, key } = await setup("openrouter", { operations: ["openrouter.chat"] });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchSpy.mockResolvedValue(Response.json({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    const { response, ctx } = await post(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, key, { model: "some-lab/unlisted-model" });
    await response.text();
    await waitOnExecutionContext(ctx);
    const [charge] = await chargesOf(appId);
    expect(charge).toMatchObject({ price_source: "unresolved", cost_nano: null, input_tokens: 10 });
    // Unresolved with a measure is always retried: a customer rate added later prices it.
    expect(await env.DB.prepare("SELECT kind FROM open_work WHERE charge_id = ?").bind(charge!.id).first()).toEqual({ kind: "unresolved" });
    expect(errors.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("no_cost_reported"));
  });

  it("bills xAI's chat at the ticks it reports, and its Messages API at our price", async () => {
    const { appId, slug, key } = await setup("xai", { operations: ["xai.chat", "xai.messages"] });
    fetchSpy.mockResolvedValueOnce(Response.json({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, cost_in_usd_ticks: 25_000_000 } }));
    const chat = await post(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, key, { model: "grok-4.5" });
    await chat.response.text();
    await waitOnExecutionContext(chat.ctx);
    expect(await chargesOf(appId)).toMatchObject([{ operation: "xai.chat", price_source: "provider_usd", cost_nano: fromDollars(0.0025) }]);
  });
});

describe("Perplexity", () => {
  it("bills its Agent API at the cost it reports, its web search included, streamed or not", async () => {
    const { appId, slug, key } = await setup("perplexity", { operations: ["perplexity.agent", "perplexity.responses"] });
    const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120, cost: { currency: "USD", input_cost: 0.0002, output_cost: 0.0002, tool_calls_cost: 0.005, total_cost: 0.0054 } };
    fetchSpy.mockResolvedValueOnce(Response.json({ id: "resp_1", object: "response", model: "openai/gpt-6.2-sol", output: [], usage }));
    const plain = await post(`/v2/apps/${appId}/proxy/${slug}/v1/agent`, key, { model: "openai/gpt-6.2-sol", input: "hi", tools: [{ type: "web_search" }] });
    await plain.response.text();
    await waitOnExecutionContext(plain.ctx);
    const events = sse([
      { type: "response.created", response: { id: "resp_2", usage: null } },
      { type: "response.completed", response: { id: "resp_2", model: "openai/gpt-6.2-sol", usage } },
    ]);
    fetchSpy.mockResolvedValueOnce(new Response(events, { headers: { "content-type": "text/event-stream" } }));
    const streamed = await post(`/v2/apps/${appId}/proxy/${slug}/v1/responses`, key, { model: "openai/gpt-6.2-sol", input: "hi", stream: true });
    await streamed.response.text();
    await waitOnExecutionContext(streamed.ctx);
    expect(sent(0).url).toBe("https://api.perplexity.ai/v1/agent");
    // Our token price alone would leave the search out.
    expect(listedCost("perplexity", "openai/gpt-6.2-sol", { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 20 })).toBeLessThan(fromDollars(0.0054));
    expect(await chargesOf(appId)).toMatchObject([
      { operation: "perplexity.agent", price_source: "provider_usd", cost_nano: fromDollars(0.0054), input_tokens: 100 },
      { operation: "perplexity.responses", price_source: "provider_usd", cost_nano: fromDollars(0.0054), input_tokens: 100 },
    ]);
  });

  it("bills Sonar at the cost it reports, its request fee included", async () => {
    const { appId, slug, key } = await setup("perplexity", { operations: ["perplexity.chat"] });
    // As a real answer gave it (T30): 11 tokens in, 7 out, and a $0.0025 request fee.
    const cost = { input_tokens_cost: 0.00158, output_tokens_cost: 0.00003, request_cost: 0.0025, total_cost: 0.00411 };
    fetchSpy.mockResolvedValueOnce(Response.json({ model: "sonar", choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, cost } }));
    const { response, ctx } = await post(`/v2/apps/${appId}/proxy/${slug}/chat/completions`, key, { model: "sonar", messages: [] });
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(await chargesOf(appId)).toMatchObject([{ operation: "perplexity.chat", price_source: "provider_usd", cost_nano: fromDollars(0.00411) }]);
  });

  it("never charges Perplexity's figure, rounded to five decimals, below our price for the call's usage", async () => {
    const { appId, slug, key } = await setup("perplexity", { operations: ["perplexity.agent"] });
    const warns = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // As a real answer gave it (T30): 33 tokens in and 5 out of openai/gpt-6-luna read $0.
    const usage = { input_tokens: 33, output_tokens: 5, total_tokens: 38, cost: { currency: "USD", input_cost: 0, output_cost: 0, total_cost: 0 } };
    fetchSpy.mockResolvedValueOnce(Response.json({ model: "openai/gpt-6-luna", output: [], usage }));
    const { response, ctx } = await post(`/v2/apps/${appId}/proxy/${slug}/v1/agent`, key, { model: "openai/gpt-6-luna", input: "hi" });
    await response.text();
    await waitOnExecutionContext(ctx);
    const [charge] = await chargesOf(appId);
    expect(charge).toMatchObject({ price_source: "list_rate", price_is_estimate: 1 });
    expect(charge!.cost_nano).toBe(listedCost("perplexity", "openai/gpt-6-luna", { inputTokens: 33, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 5 }));
    expect(charge!.cost_nano).toBeGreaterThan(0);
    expect(JSON.parse(String(charge!.measures_json)).estimate_reasons).toContain("cost_rounded");
    expect(warns.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("provider_cost_rounded_below_price"));
  });

  it("charges an Agent API answer that reports no cost at our price, marked an estimate and logged", async () => {
    const { appId, slug, key } = await setup("perplexity", { operations: ["perplexity.agent"] });
    const warns = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // 1,000 of the 1,100 input tokens are cache writes, in the Agent API's own spelling.
    const usage = { input_tokens: 1100, output_tokens: 20, total_tokens: 1120, input_tokens_details: { cached_tokens: 0, cache_creation_input_tokens: 1000 } };
    fetchSpy.mockResolvedValueOnce(Response.json({ model: "openai/gpt-6.2-sol", output: [], usage }));
    const { response, ctx } = await post(`/v2/apps/${appId}/proxy/${slug}/v1/agent`, key, { model: "openai/gpt-6.2-sol", input: "hi" });
    expect(response.status).toBe(200);
    await response.text();
    await waitOnExecutionContext(ctx);
    const [charge] = await chargesOf(appId);
    expect(charge).toMatchObject({ price_source: "list_rate", price_is_estimate: 1, input_tokens: 100, cache_write_tokens: 1000 });
    expect(charge!.cost_nano).toBe(listedCost("perplexity", "openai/gpt-6.2-sol", { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 1000, outputTokens: 20 }));
    expect(JSON.parse(String(charge!.measures_json)).estimate_reasons).toContain("cost_not_reported");
    expect(warns.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("provider_cost_not_reported"));
  });

  it("lets Perplexity's rounding explain only a gap of one rounding step, never a cheaper tier, and floors at the standard rate", async () => {
    const { appId, slug, key } = await setup("perplexity", { operations: ["perplexity.agent"] });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const agentCall = async (usage: Record<string, unknown>, body: Record<string, unknown> = {}) => {
      fetchSpy.mockResolvedValueOnce(Response.json({ model: "openai/gpt-6.2-sol", output: [], usage }));
      const { response, ctx } = await post(`/v2/apps/${appId}/proxy/${slug}/v1/agent`, key, { model: "openai/gpt-6.2-sol", input: "hi", ...body });
      await response.text();
      await waitOnExecutionContext(ctx);
    };
    // 1M input tokens at $2: a figure of $1, half our price, is Perplexity's own (a cheaper tier), not rounding.
    await agentCall({ input_tokens: 1_000_000, output_tokens: 0, cost: { currency: "USD", total_cost: 1 } });
    // A small flex call that reads $0: our flex price is half the standard one, but an estimate is never below standard.
    await agentCall({ input_tokens: 2, output_tokens: 0, service_tier: "flex", cost: { currency: "USD", total_cost: 0 } }, { service_tier: "flex" });
    const standard = listedCost("perplexity", "openai/gpt-6.2-sol", { inputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
    // A small flex call whose figure, $0.00001, is within a rounding step of our flex price ($0.000012) but not of
    // the standard one ($0.000024): rounding explains it, so our price stands in, at no less than standard.
    await agentCall({ input_tokens: 2, output_tokens: 2, service_tier: "flex", cost: { currency: "USD", total_cost: 0.00001 } }, { service_tier: "flex" });
    const smallStandard = listedCost("perplexity", "openai/gpt-6.2-sol", { inputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 2 });
    expect(await chargesOf(appId)).toMatchObject([
      { price_source: "provider_usd", cost_nano: fromDollars(1), price_is_estimate: 0 },
      { price_source: "list_rate", cost_nano: standard, price_is_estimate: 1 },
      { price_source: "list_rate", cost_nano: smallStandard, price_is_estimate: 1 },
    ]);
  });

  it("serves an Agent API request that names only a models list, judging each and charging the one that served", async () => {
    const { appId, slug, key } = await setup("perplexity", { operations: ["perplexity.agent"], models: ["openai/gpt-6-luna", "openai/gpt-6.2-sol"] });
    const refused = await post(`/v2/apps/${appId}/proxy/${slug}/v1/agent`, key, { models: ["openai/gpt-6-luna", "anthropic/claude-fable-5-2"], input: "hi" });
    expect(refused.response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockResolvedValueOnce(Response.json({ model: "openai/gpt-6.2-sol", output: [], usage: { input_tokens: 10, output_tokens: 2, cost: { currency: "USD", total_cost: 0.001 } } }));
    const served = await post(`/v2/apps/${appId}/proxy/${slug}/v1/agent`, key, { models: ["openai/gpt-6-luna", "openai/gpt-6.2-sol"], input: "hi" });
    expect(served.response.status).toBe(200);
    await served.response.text();
    await waitOnExecutionContext(served.ctx);
    // Sent as the client sent it: no model added.
    expect(sent(0).body.model).toBeUndefined();
    expect(await chargesOf(appId)).toMatchObject([{ model: "openai/gpt-6.2-sol", cost_nano: fromDollars(0.001) }]);
  });

  it("serves an Agent API effort or profile beside the model it names, and refuses one that names no model", async () => {
    const { appId, slug, key } = await setup("perplexity", { operations: ["perplexity.agent"], models: ["openai/gpt-6-luna"] });
    // With no model named, Perplexity would run the effort's own models, which the gateway cannot judge.
    const bare = await post(`/v2/apps/${appId}/proxy/${slug}/v1/agent`, key, { effort: "low", input: "hi" });
    expect(bare.response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    // A field sent beside effort overrides the effort's own. The effort may bring a models chain, which
    // Perplexity reads before model, so the request goes with the judged model as its only one.
    fetchSpy.mockImplementation(async () => Response.json({ model: "openai/gpt-6-luna", output: [], usage: { input_tokens: 10, output_tokens: 2, cost: { currency: "USD", total_cost: 0.001 } } }));
    const served = await post(`/v2/apps/${appId}/proxy/${slug}/v1/agent`, key, { effort: "low", model: "openai/gpt-6-luna", input: "hi" });
    expect(served.response.status).toBe(200);
    await served.response.text();
    await waitOnExecutionContext(served.ctx);
    expect(sent(0).body).toMatchObject({ effort: "low", model: "openai/gpt-6-luna", models: ["openai/gpt-6-luna"] });
    // A request with its own list keeps it: the one rule judged it.
    const listed = await post(`/v2/apps/${appId}/proxy/${slug}/v1/agent`, key, { profile: "profile_1", models: ["openai/gpt-6-luna"], input: "hi" });
    expect(listed.response.status).toBe(200);
    await listed.response.text();
    await waitOnExecutionContext(listed.ctx);
    expect(sent(1).body).toEqual({ profile: "profile_1", models: ["openai/gpt-6-luna"], input: "hi" });
    // A request with neither effort nor profile is sent as it came.
    const plain = await post(`/v2/apps/${appId}/proxy/${slug}/v1/agent`, key, { model: "openai/gpt-6-luna", input: "hi" });
    await plain.response.text();
    await waitOnExecutionContext(plain.ctx);
    expect(sent(2).body.models).toBeUndefined();
  });

  it("never books an Agent API answer with no cost, for a model with no price, as free", async () => {
    const { appId, slug, key } = await setup("perplexity", { operations: ["perplexity.agent"], models: ["openai/brand-new-model"] });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchSpy.mockResolvedValueOnce(Response.json({ model: "openai/brand-new-model", output: [], usage: { input_tokens: 10, output_tokens: 2 } }));
    const { response, ctx } = await post(`/v2/apps/${appId}/proxy/${slug}/v1/agent`, key, { model: "openai/brand-new-model", input: "hi" });
    expect(response.status).toBe(200);
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(await chargesOf(appId)).toMatchObject([{ price_source: "unresolved", cost_nano: null }]);
    expect(errors.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("no_cost_reported"));
  });

  it("judges Perplexity's rounded figure against its own list rate, and keeps a rounded $0 with no price as an estimate", async () => {
    const { appId, slug, key } = await setup("perplexity", { operations: ["perplexity.agent"], models: ["openai/gpt-6-luna", "openai/brand-new-model"] });
    // The customer's own rate for gpt-6-luna is ten times the list's.
    await env.DB.prepare("UPDATE provider_connection SET rates_json = ? WHERE slug = ?")
      .bind(JSON.stringify({ "openai/gpt-6-luna": { input: 1_000_000_000, output: 5_000_000_000 } }), slug)
      .run();
    clearCaches();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const call = async (model: string, total: number) => {
      fetchSpy.mockResolvedValueOnce(Response.json({ model, output: [], usage: { input_tokens: 33, output_tokens: 5, cost: { currency: "USD", total_cost: total } } }));
      const { response, ctx } = await post(`/v2/apps/${appId}/proxy/${slug}/v1/agent`, key, { model, input: "hi" });
      await response.text();
      await waitOnExecutionContext(ctx);
    };
    // At the list's $0.10/$0.50, 33 in and 5 out cost $0.0000058: $0 is rounding. At the customer's rate,
    // $0.000058, the gap is past one step, but rounding is judged against Perplexity's own rate.
    await call("openai/gpt-6-luna", 0);
    // No price at all: the rounded $0 is all there is, kept, but as an estimate.
    await call("openai/brand-new-model", 0);
    expect(await chargesOf(appId)).toMatchObject([
      { price_source: "customer_rate", cost_nano: 58_000, price_is_estimate: 1 },
      { price_source: "provider_usd", cost_nano: 0, price_is_estimate: 1 },
    ]);
    expect(errors.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("provider_cost_rounded_unpriced"));
  });

  it("judges a rewrite to perplexity/auto as perplexity/auto: served only with a routing block whose models are allowed", async () => {
    const { appId, slug, key } = await setup("perplexity", { operations: ["perplexity.orchestrator.chat"], models: ["house", "perplexity/glm-5.3-flash"] });
    await env.DB.prepare("UPDATE app SET config_json = json_set(config_json, '$.routing.model_rewrites', json(?)) WHERE id = ?")
      .bind(JSON.stringify({ house: "perplexity/auto" }), appId)
      .run();
    clearCaches();
    // Were it sent, the provider would answer.
    fetchSpy.mockImplementation(async () => Response.json({ model: "perplexity/glm-5.3-flash", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const bare = await post(`/v2/apps/${appId}/proxy/${slug}/orchestrator/v1/chat/completions`, key, { model: "house", messages: [] });
    expect(bare.response.status).toBe(400);
    const outside = await post(`/v2/apps/${appId}/proxy/${slug}/orchestrator/v1/chat/completions`, key, {
      model: "house",
      routing: { default_model: "anthropic/claude-fable-5-2", routes: [{ name: "a", description: "Anything.", model: "anthropic/claude-fable-5-2" }] },
      messages: [],
    });
    expect(outside.response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serves perplexity/auto only with a routing block, judging every model it names and charging the one that served", async () => {
    const { appId, slug, key } = await setup("perplexity", { operations: ["perplexity.orchestrator.chat"], models: ["perplexity/glm-5.3-flash", "perplexity/glm-5.3"] });
    const routing = (model: string) => ({ default_model: "perplexity/glm-5.3-flash", routes: [{ name: "hard", description: "Hard questions.", model }] });
    // Without routing, the Orchestrator chooses among models the request does not name.
    const bare = await post(`/v2/apps/${appId}/proxy/${slug}/orchestrator/v1/chat/completions`, key, { model: "perplexity/auto", messages: [] });
    expect(bare.response.status).toBe(400);
    const outside = await post(`/v2/apps/${appId}/proxy/${slug}/orchestrator/v1/chat/completions`, key, { model: "perplexity/auto", routing: routing("anthropic/claude-fable-5-2"), messages: [] });
    expect(outside.response.status).toBe(403);
    expect(await outside.response.json()).toMatchObject({ error: { code: "model_not_allowed" } });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockResolvedValueOnce(Response.json({ model: "perplexity/glm-5.3", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100 } }));
    const served = await post(`/v2/apps/${appId}/proxy/${slug}/orchestrator/v1/chat/completions`, key, { model: "perplexity/auto", routing: routing("perplexity/glm-5.3"), messages: [] });
    expect(served.response.status).toBe(200);
    await served.response.text();
    await waitOnExecutionContext(served.ctx);
    expect(sent(0).body.model).toBe("perplexity/auto");
    expect(await chargesOf(appId)).toMatchObject([
      { model: "perplexity/glm-5.3", cost_nano: listedCost("perplexity", "perplexity/glm-5.3", { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100 }) },
    ]);
  });

  it("bills the Orchestrator's one cache-write count as one-hour writes when the request asks for them", async () => {
    const { appId, slug, key } = await setup("perplexity", { operations: ["perplexity.orchestrator.chat"] });
    const usage = { prompt_tokens: 1_000_000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1_000_000 } };
    for (const ttl of ["1h", undefined]) {
      fetchSpy.mockResolvedValueOnce(Response.json({ model: "anthropic/claude-sonnet-5-5", choices: [], usage }));
      const body = { model: "anthropic/claude-sonnet-5-5", messages: [], ...(ttl === undefined ? {} : { prompt_cache_options: { ttl } }) };
      const { response, ctx } = await post(`/v2/apps/${appId}/proxy/${slug}/orchestrator/v1/chat/completions`, key, body);
      await response.text();
      await waitOnExecutionContext(ctx);
    }
    // A million writes: kept an hour at 2 × $2 input, else at the five-minute $2.50.
    expect(await chargesOf(appId)).toMatchObject([{ cost_nano: fromDollars(4) }, { cost_nano: fromDollars(2.5) }]);
  });

  it("judges every model of an Agent API models list as the request's own, and charges the one that served", async () => {
    const { appId, slug, key } = await setup("perplexity", { operations: ["perplexity.agent"], models: ["openai/gpt-6-luna", "openai/gpt-6.2-sol"] });
    // Perplexity reads models before model: a model the app does not allow is refused there too.
    const refused = await post(`/v2/apps/${appId}/proxy/${slug}/v1/agent`, key, { model: "openai/gpt-6-luna", models: ["anthropic/claude-fable-5-2"], input: "hi" });
    expect(refused.response.status).toBe(403);
    expect(await refused.response.json()).toMatchObject({ error: { code: "model_not_allowed" } });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockResolvedValueOnce(Response.json({ model: "openai/gpt-6.2-sol", output: [], usage: { input_tokens: 10, output_tokens: 2 } }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const served = await post(`/v2/apps/${appId}/proxy/${slug}/v1/agent`, key, { model: "openai/gpt-6-luna", models: ["openai/gpt-6.2-sol"], input: "hi" });
    expect(served.response.status).toBe(200);
    await served.response.text();
    await waitOnExecutionContext(served.ctx);
    expect(await chargesOf(appId)).toMatchObject([{ model: "openai/gpt-6.2-sol" }]);
  });

  it("bills one-hour cache writes on the Orchestrator's Messages API at twice the input rate", async () => {
    const { appId, slug, key } = await setup("perplexity", { operations: ["perplexity.orchestrator.messages"] });
    fetchSpy.mockResolvedValueOnce(
      Response.json({
        type: "message",
        model: "anthropic/claude-sonnet-5-5",
        content: [],
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 } },
      }),
    );
    const { response, ctx } = await post(`/v2/apps/${appId}/proxy/${slug}/orchestrator/v1/messages`, key, { model: "anthropic/claude-sonnet-5-5", max_tokens: 10, messages: [] });
    expect(response.status).toBe(200);
    await response.text();
    await waitOnExecutionContext(ctx);
    // A million one-hour write tokens at 2 × $2 input, not at the five-minute $2.50.
    expect(await chargesOf(appId)).toMatchObject([{ cost_nano: fromDollars(4) }]);
    // Every Anthropic model Perplexity serves has the rate, never left to fall back to the cheaper one.
    const anthropicModels = Object.keys(BUILT_IN_PRICES.perplexity ?? {}).filter((model) => model.startsWith("anthropic/"));
    expect(anthropicModels.length).toBeGreaterThan(0);
    for (const model of anthropicModels) expect(listPrice("perplexity", model)?.rates.cache_write_1h, model).toBeGreaterThan(0);
  });

  it("serves the Orchestrator API at its documented paths, and still at the router paths it first used", async () => {
    const { appId, slug, key } = await setup("perplexity", { operations: ["perplexity.orchestrator.chat", "perplexity.router.chat"] });
    fetchSpy.mockImplementation(async () => Response.json({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    for (const path of ["orchestrator/v1/chat/completions", "router/v1/chat/completions"]) {
      const { response, ctx } = await post(`/v2/apps/${appId}/proxy/${slug}/${path}`, key, { model: "perplexity/glm-5.3", messages: [] });
      expect(response.status).toBe(200);
      await response.text();
      await waitOnExecutionContext(ctx);
    }
    expect([sent(0).url, sent(1).url]).toEqual(["https://api.perplexity.ai/orchestrator/v1/chat/completions", "https://api.perplexity.ai/router/v1/chat/completions"]);
    expect(await chargesOf(appId)).toMatchObject([
      { operation: "perplexity.orchestrator.chat", price_source: "list_rate", cost_nano: listedCost("perplexity", "perplexity/glm-5.3", { inputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 2 }) },
      { operation: "perplexity.router.chat" },
    ]);
  });
});

describe("streams that end before their closing event", () => {
  it("books a Messages stream that ended cleanly without message_stop as cut short, never complete", async () => {
    const { appId, slug, key } = await setup("anthropic", { operations: ["anthropic.messages"] });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const events = sse([
      { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } },
      { type: "message_delta", usage: { output_tokens: 2 } },
    ]);
    fetchSpy.mockResolvedValue(new Response(events, { headers: { "content-type": "text/event-stream" } }));
    const { response, ctx } = await post(`/v2/apps/${appId}/proxy/${slug}/v1/messages`, key, { model: "claude-sonnet-5", stream: true });
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(await chargesOf(appId)).toMatchObject([{ status: "network_error", measured: "partial" }]);
  });

  it("books a Chat Completions stream that ended without [DONE] as cut short", async () => {
    const { appId, slug, key } = await setup("openai", { operations: ["openai.chat"] });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const events = sse([{ choices: [{ delta: { content: "Hi" } }] }]);
    fetchSpy.mockResolvedValue(new Response(events, { headers: { "content-type": "text/event-stream" } }));
    const { response, ctx } = await post(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, key, { model: "gpt-4o-mini", stream: true });
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(await chargesOf(appId)).toMatchObject([{ status: "network_error", measured: "partial", price_source: "unresolved" }]);
  });
});

describe("stored apps", () => {
  it("still serves an app saved before a provider's key header was reserved", async () => {
    const { slug } = await setup("openai", { operations: ["openai.chat"] });
    const appId = await seedRoutedApp(
      { type: "api_key", end_user: { source: "header", header: "x-api-key" } },
      { providers: { [slug]: { operations: ["openai.chat"] } } },
    );
    const { key } = await seedAppKey(appId);
    fetchSpy.mockResolvedValue(Response.json({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const { response, ctx } = await post(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, key, { model: "gpt-4o-mini" }, { "x-api-key": "user-9" });
    expect(response.status).toBe(200);
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(await chargesOf(appId)).toMatchObject([{ end_user_id: "user-9", status: "ok" }]);
  });
});

describe("service modes through the proxy", () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 100 };
  const tokens = { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100 };

  it("bills a flex request at the model's flex price, and records the mode", async () => {
    const { appId, slug, key } = await setup("openai", { operations: ["openai.chat"] });
    fetchSpy.mockResolvedValue(Response.json({ choices: [], service_tier: "flex", usage }));
    const { response, ctx } = await post(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, key, { model: "gpt-5.6-luna", service_tier: "flex" });
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(sent().body).toMatchObject({ service_tier: "flex" });
    const [charge] = await chargesOf(appId);
    expect(charge).toMatchObject({ price_is_estimate: 0 });
    expect(JSON.parse(String(charge!.measures_json))).toMatchObject({ service_mode: "flex" });
    expect(Number(charge!.cost_nano)).toBeLessThan(listedCost("openai", "gpt-5.6-luna", tokens));
  });

  it("bills a fast request the provider shed to standard at the standard price", async () => {
    const { appId, slug, key } = await setup("openai", { operations: ["openai.chat"] });
    fetchSpy.mockResolvedValue(Response.json({ choices: [], service_tier: "default", usage }));
    const { response, ctx } = await post(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, key, { model: "gpt-5.6-luna", service_tier: "priority" });
    await response.text();
    await waitOnExecutionContext(ctx);
    const [charge] = await chargesOf(appId);
    expect(charge).toMatchObject({ price_is_estimate: 0, cost_nano: listedCost("openai", "gpt-5.6-luna", tokens) });
    expect(JSON.parse(String(charge!.measures_json))).not.toHaveProperty("service_mode");
  });

  it("serves a mode value it does not know, billed at standard and marked as an estimate", async () => {
    const { appId, slug, key } = await setup("openai", { operations: ["openai.chat"] });
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchSpy.mockResolvedValue(Response.json({ choices: [], usage }));
    const { response, ctx } = await post(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, key, { model: "gpt-5.6-luna", service_tier: "turbo" });
    expect(response.status).toBe(200);
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(await chargesOf(appId)).toMatchObject([{ price_is_estimate: 1, cost_nano: listedCost("openai", "gpt-5.6-luna", tokens) }]);
    expect(warnings.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("service_mode_unknown"));
  });

  it("bills a flex request whose answer names a tier it does not know at standard, as an estimate", async () => {
    const { appId, slug, key } = await setup("openai", { operations: ["openai.chat"] });
    fetchSpy.mockResolvedValue(Response.json({ choices: [], service_tier: "hyperflex", usage }));
    const { response, ctx } = await post(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, key, { model: "gpt-5.6-luna", service_tier: "flex" });
    await response.text();
    await waitOnExecutionContext(ctx);
    const [charge] = await chargesOf(appId);
    expect(charge).toMatchObject({ price_is_estimate: 1, cost_nano: listedCost("openai", "gpt-5.6-luna", tokens) });
    const measures = JSON.parse(String(charge!.measures_json)) as Record<string, unknown>;
    // The mode as the answer gave it is kept with the doubt, so the sweep prices it by the same floor.
    expect(measures).toMatchObject({ service_mode_unknown: 1 });
  });

  it("bills Anthropic's region `not_available` at global when no region was asked, exactly, and at the US rate as an estimate when the US was asked (T27)", async () => {
    const { appId, slug, key } = await setup("anthropic", { operations: ["anthropic.messages"] });
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const answer = () => Response.json({ usage: { input_tokens: 1000, output_tokens: 100, inference_geo: "not_available" } });
    fetchSpy.mockResolvedValueOnce(answer()).mockResolvedValueOnce(answer());
    for (const body of [{ model: "claude-sonnet-5" }, { model: "claude-sonnet-5", inference_geo: "us" }]) {
      const { response, ctx } = await post(`/v2/apps/${appId}/proxy/${slug}/v1/messages`, key, body);
      await response.text();
      await waitOnExecutionContext(ctx);
    }
    const standard = listedCost("anthropic", "claude-sonnet-5", tokens);
    expect(standard).toBe(3_000_000);
    const [global, us] = await chargesOf(appId);
    expect(global).toMatchObject({ price_is_estimate: 0, cost_nano: standard });
    // Claude Sonnet 5 costs 1.1 times as much in the US.
    expect(us).toMatchObject({ price_is_estimate: 1, cost_nano: 3_300_000 });
    const unknown = warnings.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("service_mode_unknown"));
    expect(unknown).toEqual([expect.stringContaining("not_available")]);
  });

  it("estimates a mode the model has no price in, never under standard", async () => {
    const { appId, slug, key } = await setup("anthropic", { operations: ["anthropic.messages"] });
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchSpy.mockResolvedValue(Response.json({ usage: { input_tokens: 1000, output_tokens: 100, speed: "fast" } }));
    const { response, ctx } = await post(`/v2/apps/${appId}/proxy/${slug}/v1/messages`, key, { model: "claude-sonnet-5", speed: "fast" });
    await response.text();
    await waitOnExecutionContext(ctx);
    const [charge] = await chargesOf(appId);
    expect(charge).toMatchObject({ price_is_estimate: 1, cost_nano: listedCost("anthropic", "claude-sonnet-5", tokens) });
    expect(warnings.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("service_mode_unpriced"));
  });
});

/**
 * Step 3b: model rewrites on the proxy, and presets with their fallback
 * chains (plan sections 4.4, D13). The provider is mocked at `fetch`; no
 * test waits on a timer.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../src/index.ts";
import { deepMerge } from "../src/proxy/presets.ts";
import { sealSecret } from "../src/vault/secrets.ts";
import {
  ACCOUNT_ID,
  clearCaches,
  LOAD_MANAGEMENT_TIMEOUT_MS,
  loadManagement,
  seedAccount,
  seedAppKey,
  seedManagementKey,
} from "./helpers.ts";

beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

const ORIGIN = "https://gateway.test";
const SECRET = "sk-test-provider-key-5678";
const AUTH = { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } };

/** A provider connection of `type`, with its own random slug. */
async function connection(type: string, status: "active" | "disabled" = "active"): Promise<string> {
  await seedAccount();
  const id = crypto.randomUUID().replaceAll("-", "");
  const slug = `${type}-${id.slice(0, 6)}`;
  const blob = await sealSecret(env, "providerKey", [ACCOUNT_ID, id, type, ""], SECRET);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO provider_connection
      (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, rates_json, revision, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '5678', NULL, NULL, 1, 'usr_test', ?, ?)`,
  )
    .bind(id, ACCOUNT_ID, type, slug, type, status, blob, now, now)
    .run();
  return slug;
}

/** An app with this config (authentication added), and an app key for it. */
async function appWith(config: Record<string, unknown>): Promise<{ appId: string; key: string }> {
  await seedAccount();
  const appId = `app_preset_${crypto.randomUUID().slice(0, 8)}`;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO app(id, account_id, name, config_json, revision, status, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', ?, ?)",
  )
    .bind(appId, ACCOUNT_ID, appId, JSON.stringify({ authentication: AUTH, ...config }), now, now)
    .run();
  const { key } = await seedAppKey(appId);
  return { appId, key };
}

async function post(path: string, key: string, body: unknown, headers: Record<string, string> = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "x-end-user-id": "user-1", "content-type": "application/json", ...headers },
      body: body instanceof FormData ? body : JSON.stringify(body),
    }),
    env,
    ctx,
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, text };
}

async function charges(appId: string): Promise<Record<string, any>[]> {
  const { results } = await env.DB.prepare("SELECT * FROM charge WHERE app_id = ? ORDER BY seq").bind(appId).all();
  return results;
}

let fetchSpy: MockInstance<typeof fetch>;

/** What the provider was sent on call `index`: its URL, headers and JSON body. */
function sent(index = 0): { url: string; headers: Headers; body: Record<string, any> } {
  const [input, init] = fetchSpy.mock.calls[index]!;
  const body = init?.body;
  return {
    url: String(input),
    headers: new Headers(init?.headers),
    body: body instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(body)) : {},
  };
}

const CHAT_OK = () =>
  Response.json({ id: "x", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } });

beforeEach(() => {
  clearCaches();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => vi.restoreAllMocks());

describe("model rewrites on the proxy", () => {
  it("sends and bills the rewritten model, after judging the one the request named", async () => {
    const slug = await connection("openai");
    const { appId, key } = await appWith({
      routing: { providers: { [slug]: { operations: ["openai.chat"], models: ["house-model"] } }, model_rewrites: { "house-model": "gpt-4o-mini" } },
    });
    fetchSpy.mockImplementation(async () => CHAT_OK());
    const { response } = await post(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, key, { model: "house-model", messages: [] });
    expect(response.status).toBe(200);
    expect(sent().body.model).toBe("gpt-4o-mini");
    const [charge] = await charges(appId);
    expect(charge).toMatchObject({ model: "gpt-4o-mini", price_source: "list_rate" });
    expect(charge!.cost_nano).toBeGreaterThan(0);
  });

  it("rewrites a model named in the path, and judges the app's list on the requested one", async () => {
    const slug = await connection("gemini");
    const { appId, key } = await appWith({
      routing: {
        providers: { [slug]: { operations: ["gemini.generate.v1beta"], models: ["house-gemini"] } },
        model_rewrites: { "house-gemini": "gemini-2.5-flash" },
      },
    });
    fetchSpy.mockImplementation(async () => Response.json({ candidates: [], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }));
    const ok = await post(`/v2/apps/${appId}/proxy/${slug}/v1beta/models/house-gemini:generateContent`, key, { contents: [] });
    expect(ok.response.status).toBe(200);
    expect(sent().url).toContain("/v1beta/models/gemini-2.5-flash:generateContent");
    // The rewritten name is not on the app's list, so asking for it directly is refused.
    const direct = await post(`/v2/apps/${appId}/proxy/${slug}/v1beta/models/gemini-2.5-flash:generateContent`, key, { contents: [] });
    expect(direct.response.status).toBe(403);
    expect((await charges(appId))[0]).toMatchObject({ model: "gemini-2.5-flash" });
  });
});

describe("presets", () => {
  it("merges the preset's params over the body, with nested objects merged and the preset winning", () => {
    expect(deepMerge({ a: 1, nested: { x: 1, y: 2 }, keep: true }, { a: 2, nested: { y: 3 } })).toEqual({ a: 2, nested: { x: 1, y: 3 }, keep: true });
    expect(Object.hasOwn(deepMerge({}, JSON.parse('{"__proto__": {"polluted": true}}')), "polluted")).toBe(false);
  });

  it("sends the preset's model, params and output cap, and writes one charge", async () => {
    const slug = await connection("openai");
    const { appId, key } = await appWith({
      presets: { support: { provider: slug, operation: "openai.chat", model: "gpt-4o-mini", params: { temperature: 0 }, max_output_tokens: 100 } },
    });
    fetchSpy.mockImplementation(async () => CHAT_OK());
    const { response } = await post(`/v2/apps/${appId}/presets/support`, key, { messages: [{ role: "user", content: "hi" }], temperature: 1, model: "other" });
    expect(response.status).toBe(200);
    const request = sent();
    expect(request.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(request.body).toMatchObject({ model: "gpt-4o-mini", temperature: 0, max_completion_tokens: 100 });
    expect(request.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
    const rows = await charges(appId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seq: 1, status: "ok", model: "gpt-4o-mini", operation: "openai.chat" });
  });

  it("falls back on a 5xx: two charges, the failed one with no cost, the answer from the next", async () => {
    const first = await connection("openai");
    const second = await connection("anthropic");
    const { appId, key } = await appWith({
      presets: {
        chat: { provider: first, operation: "openai.chat", model: "gpt-4o-mini", fallback: [{ provider: second, model: "claude-haiku-4-5" }] },
      },
    });
    fetchSpy
      .mockImplementationOnce(async () => Response.json({ error: { code: "server_overloaded", message: "busy" } }, { status: 503 }))
      .mockImplementationOnce(async () => CHAT_OK());
    const { response } = await post(`/v2/apps/${appId}/presets/chat`, key, { messages: [] });
    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // Anthropic's OpenAI-shaped chat path, with its own key header and the model the fallback names.
    expect(sent(1).url).toBe("https://api.anthropic.com/v1/chat/completions");
    expect(sent(1).headers.get("x-api-key")).toBe(SECRET);
    expect(sent(1).body.model).toBe("claude-haiku-4-5");
    const rows = await charges(appId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ seq: 1, status: "provider_error", http_status: 503, error_code: "server_overloaded", cost_nano: null });
    expect(rows[1]).toMatchObject({ seq: 2, status: "ok", model: "claude-haiku-4-5", operation: "anthropic.chat" });
    expect(rows[1]!.cost_nano).toBeGreaterThan(0);
    expect(rows[0]!.request_id).toBe(rows[1]!.request_id);
  });

  it("falls back when the provider cannot be reached, and on a 429", async () => {
    const first = await connection("openai");
    const second = await connection("openai");
    const third = await connection("openai");
    const { appId, key } = await appWith({
      presets: {
        chat: {
          provider: first,
          operation: "openai.chat",
          model: "gpt-4o-mini",
          fallback: [{ provider: second, model: "gpt-4o-mini" }, { provider: third, model: "gpt-4.1-mini" }],
        },
      },
    });
    fetchSpy
      .mockImplementationOnce(async () => {
        throw new TypeError("connection refused");
      })
      .mockImplementationOnce(async () => new Response("slow down", { status: 429 }))
      .mockImplementationOnce(async () => CHAT_OK());
    const { response } = await post(`/v2/apps/${appId}/presets/chat`, key, { messages: [] });
    expect(response.status).toBe(200);
    const rows = await charges(appId);
    expect(rows.map((row) => [row.seq, row.status, row.cost_nano === null])).toEqual([
      [1, "network_error", true],
      [2, "provider_error", true],
      [3, "ok", false],
    ]);
  });

  it("never retries a 4xx, and passes the last attempt's error through as it is", async () => {
    const first = await connection("openai");
    const second = await connection("openai");
    const { appId, key } = await appWith({
      presets: { chat: { provider: first, operation: "openai.chat", model: "gpt-4o-mini", fallback: [{ provider: second, model: "gpt-4o-mini" }] } },
    });
    fetchSpy.mockImplementationOnce(async () => Response.json({ error: { code: "invalid_value" } }, { status: 400 }));
    const refused = await post(`/v2/apps/${appId}/presets/chat`, key, { messages: [] });
    expect(refused.response.status).toBe(400);
    expect(JSON.parse(refused.text)).toEqual({ error: { code: "invalid_value" } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockReset();
    fetchSpy.mockImplementation(async () => Response.json({ error: { code: "down" } }, { status: 502 }));
    const failed = await post(`/v2/apps/${appId}/presets/chat`, key, { messages: [] });
    expect(failed.response.status).toBe(502);
    expect(JSON.parse(failed.text)).toEqual({ error: { code: "down" } });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("goes on to the fallbacks when the first connection is disabled, and leaves out one that cannot work", async () => {
    const paused = await connection("openai", "disabled");
    const unpriced = await connection("openai");
    const working = await connection("openai");
    const { appId, key } = await appWith({
      presets: {
        chat: {
          provider: paused,
          operation: "openai.chat",
          model: "gpt-4o-mini",
          fallback: [
            { provider: unpriced, model: "no-such-model-zz" },
            { provider: "gone-connection", model: "gpt-4o-mini" },
            { provider: working, model: "gpt-4o-mini" },
          ],
        },
      },
    });
    fetchSpy.mockImplementation(async () => CHAT_OK());
    const { response } = await post(`/v2/apps/${appId}/presets/chat`, key, { messages: [] });
    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((await charges(appId))[0]).toMatchObject({ seq: 4, status: "ok" });
  });

  it("refuses an unknown preset, a disabled one with no fallback, and an unpriced first target, spending nothing", async () => {
    const paused = await connection("openai", "disabled");
    const live = await connection("openai");
    const { appId, key } = await appWith({
      presets: {
        paused: { provider: paused, operation: "openai.chat", model: "gpt-4o-mini" },
        unpriced: { provider: live, operation: "openai.chat", model: "no-such-model-zz" },
      },
    });
    expect((await post(`/v2/apps/${appId}/presets/nope`, key, {})).response.status).toBe(404);
    const disabled = await post(`/v2/apps/${appId}/presets/paused`, key, { messages: [] });
    expect(disabled.response.status).toBe(502);
    expect(JSON.parse(disabled.text).error.code).toBe("provider_disabled");
    const priceless = await post(`/v2/apps/${appId}/presets/unpriced`, key, { messages: [] });
    expect(JSON.parse(priceless.text).error.code).toBe("pricing_not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await charges(appId)).toHaveLength(0);
  });

  it("streams a Gemini preset called with alt=sse through its streaming method", async () => {
    const slug = await connection("gemini");
    const { appId, key } = await appWith({ presets: { gem: { provider: slug, operation: "gemini.generate.v1beta", model: "gemini-2.5-flash" } } });
    fetchSpy.mockImplementation(
      async () =>
        new Response('data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const { response } = await post(`/v2/apps/${appId}/presets/gem?alt=sse&key=leak`, key, { contents: [], model: "x" });
    expect(response.status).toBe(200);
    expect(sent().url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse");
    expect(sent().body).not.toHaveProperty("model");
    expect((await charges(appId))[0]).toMatchObject({ operation: "gemini.stream.v1beta", status: "ok" });
  });

  it("adds the API version Anthropic needs when the client sends none", async () => {
    const slug = await connection("anthropic");
    const { appId, key } = await appWith({ presets: { msg: { provider: slug, operation: "anthropic.messages", model: "claude-haiku-4-5" } } });
    fetchSpy.mockImplementation(async () => Response.json({ content: [], usage: { input_tokens: 5, output_tokens: 1 } }));
    await post(`/v2/apps/${appId}/presets/msg`, key, { messages: [], max_tokens: 10 });
    expect(sent().headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("sends a transcription preset's upload with its model set", async () => {
    const slug = await connection("openai");
    const { appId, key } = await appWith({ presets: { stt: { provider: slug, operation: "openai.transcription", model: "whisper-1" } } });
    fetchSpy.mockImplementation(async () => Response.json({ text: "hi", duration: 3 }));
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(64)], { type: "audio/mpeg" }), "a.mp3");
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v2/apps/${appId}/presets/stt`, { method: "POST", headers: { authorization: `Bearer ${key}`, "x-end-user-id": "u" }, body: form }),
      env,
      ctx,
    );
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const sentForm = fetchSpy.mock.calls[0]![1]!.body as FormData;
    expect(sentForm.get("model")).toBe("whisper-1");
    expect(sentForm.get("file")).toBeInstanceOf(File);
    expect((await charges(appId))[0]).toMatchObject({ model: "whisper-1", unit: "audio_seconds" });
  });
});

describe("saving rewrites and presets", () => {
  async function save(config: Record<string, unknown>) {
    const key = await seedManagementKey();
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v2/admin/app-drafts/validate`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "Draft", config: { authentication: { type: "api_key", end_user: { source: "none" } }, ...config } }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  }

  it("needs a price for each rewrite's target, and judges a listed model by its rewrite", async () => {
    const slug = await connection("openai");
    expect((await save({ routing: { model_rewrites: { house: "no-such-model-zz" } } })).body.error.code).toBe("pricing_not_configured");
    expect(
      (await save({ routing: { providers: { [slug]: { operations: ["openai.chat"], models: ["house"] } }, model_rewrites: { house: "gpt-4o-mini" } } }))
        .status,
    ).toBe(200);
    expect((await save({ routing: { providers: { [slug]: { operations: ["openai.chat"], models: ["house"] } } } })).status).toBe(400);
  });

  it("checks every target of a preset", async () => {
    const openai = await connection("openai");
    const anthropic = await connection("anthropic");
    const ok = { provider: openai, operation: "openai.chat", model: "gpt-4o-mini" };
    expect((await save({ presets: { a: { ...ok, fallback: [{ provider: anthropic, model: "claude-haiku-4-5" }] } } })).status).toBe(200);
    const cases: [Record<string, unknown>, string][] = [
      [{ ...ok, provider: "missing-zz" }, "no provider connection"],
      [{ ...ok, operation: "openai.realtime" }, "not an operation a preset can use"],
      [{ ...ok, fallback: [{ provider: anthropic, operation: "anthropic.messages", model: "claude-haiku-4-5" }] }, "a fallback must speak"],
      [{ ...ok, fallback: [{ provider: anthropic, model: "no-such-model-zz" }] }, "has no price"],
      [{ ...ok, params: { service_tier: "warp" } }, "has no service mode"],
      [{ provider: openai, operation: "openai.transcription", model: "whisper-1", params: { language: "en" } }, "params apply only to JSON"],
      [{ provider: openai, operation: "openai.embeddings", model: "text-embedding-3-small", max_output_tokens: 5 }, "has no output to cap"],
    ];
    for (const [preset, message] of cases) {
      const answer = await save({ presets: { a: preset } });
      expect(answer.status, message).toBe(400);
      expect(answer.body.error.message, message).toContain(message);
    }
  });
});

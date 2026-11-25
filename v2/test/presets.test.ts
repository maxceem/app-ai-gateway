/**
 * Step 3b: model rewrites on the proxy, and presets with their fallback
 * chains (plan sections 4.4, D13). The provider is mocked at `fetch`; no
 * test waits on a timer.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../src/index.ts";
import { BUILT_IN_PROVIDERS } from "../src/providers/index.ts";
import { deepMerge, targetAttempt } from "../src/proxy/presets.ts";
import { presetOperation } from "../src/providers/presets.ts";
import { requestFacts } from "../src/proxy/request-fields.ts";
import { listPrice } from "../src/pricing/prices.ts";
import { openai } from "../src/providers/openai.ts";
import type { ConnectionRecord } from "../src/providers/connections.ts";
import type { OperationDescription, ProviderDescription } from "../src/providers/operation.ts";
import type { Preset } from "../src/contracts/app-config.ts";
import type { Caller } from "../src/proxy/serve.ts";
import type { UpstreamCredentials } from "../src/providers/connections.ts";
import { providerTtfbTimeoutMs, sendAttempts, type ClientSide, type ProxyContext } from "../src/proxy/serve.ts";
import { STANDARD_MODE } from "../src/usage/service-modes.ts";
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
/** A caller whose request carried no credential header to strip. */
const NO_CLIENT: ClientSide = { stripped: [], credential: "agw_unit_test_credential", credentialHeaders: [], identityHeaders: [] };
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

/** Removes the account's connections that report their own cost, which can bill any rewrite target. */
async function withoutCostReporters(): Promise<void> {
  await env.DB.prepare("DELETE FROM provider_connection WHERE account_id = ? AND type IN ('openrouter', 'xai', 'perplexity')").bind(ACCOUNT_ID).run();
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

/** A request context for calling the attempt loop directly; `done` waits for its background work. */
function fakeContext(environment: Env = env): { c: ProxyContext; done: () => Promise<unknown> } {
  const waits: Promise<unknown>[] = [];
  const raw = new Request(`${ORIGIN}/v2/apps/app_unit/presets/unit`, { method: "POST" });
  const c = { env: environment, req: { raw, method: "POST" }, executionCtx: { waitUntil: (promise: Promise<unknown>) => waits.push(promise) } } as unknown as ProxyContext;
  return { c, done: () => Promise.allSettled(waits) };
}

/** The charge rows one call wrote. */
async function chargesOfCall(requestId: string): Promise<Record<string, any>[]> {
  const { results } = await env.DB.prepare("SELECT * FROM charge WHERE owner_id = ? ORDER BY seq").bind(requestId).all();
  return results;
}

const jsonBody = () => ({ bytes: new TextEncoder().encode('{"messages":[]}'), contentType: "application/json" });

/** An OpenAI chat attempt for the loop alone, with a key and a body that can be watched. */
function unitAttempt(
  seq: number,
  overrides: Partial<{
    credentials: () => Promise<UpstreamCredentials>;
    body: () => ReturnType<typeof jsonBody>;
    requestId: string;
    operation: OperationDescription;
  }> = {},
) {
  const description = BUILT_IN_PROVIDERS.openai!;
  return {
    connection: { id: `conn_${seq}`, accountId: ACCOUNT_ID, type: "openai", slug: `openai-unit-${seq}`, status: "active" as const, baseUrl: null, secretBlob: null, rates: null, cloudflareGateway: null, servingProviders: null },
    description,
    operation: overrides.operation ?? description.operations.find((operation) => operation.name === "openai.chat")!,
    hostKey: "main",
    path: "/v1/chat/completions",
    query: "",
    credentials: overrides.credentials ?? vi.fn(async (): Promise<UpstreamCredentials> => ({ providerKey: SECRET, cloudflareToken: null })),
    body: overrides.body ?? vi.fn(jsonBody),
    attempt: {
      requestId: overrides.requestId ?? "req_unit",
      seq,
      accountId: ACCOUNT_ID,
      appId: "app_unit",
      identity: { appId: "app_unit", userId: null, credentialType: "api_key" as const, authMethod: "api_key" as const, installId: null, appleAccountId: null },
      providerType: "openai",
      connectionId: `conn_${seq}`,
      providerSlug: `openai-unit-${seq}`,
      operation: "openai.chat",
      model: "gpt-4o-mini",
      price: null,
      reportsCost: false,
      requestedMode: STANDARD_MODE,
      startedAt: Date.now(),
      appVersion: null,
      clientTraceId: null,
    },
  };
}

/** Every provider host, as a URL's host. */
const PROVIDER_HOSTS = new Set(Object.values(BUILT_IN_PROVIDERS).flatMap((description) => Object.values(description.hosts).map((host) => host.split("/")[0]!)));

/**
 * The calls sent to a provider, in order. Picked by URL, not by position in
 * every `fetch` the test saw: another call to `fetch` (one still running from
 * the test before, say) is never taken for the provider's.
 */
function upstreamCalls(): Parameters<typeof fetch>[] {
  return fetchSpy.mock.calls.filter(([input]) => PROVIDER_HOSTS.has(new URL(input instanceof Request ? input.url : String(input)).host));
}

/** What the provider was sent on its call `index`: its URL, headers and JSON body. */
function sent(index = 0): { url: string; headers: Headers; body: Record<string, any> } {
  const [input, init] = upstreamCalls()[index]!;
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
  it("defaults a target with no operation to the provider's own path, before the paths v1 served by their shape", () => {
    // Groq documents only openai/v1/...: v1/audio/transcriptions is a 404 there.
    expect(presetOperation(BUILT_IN_PROVIDERS.groq!, "openai-transcription", undefined, "whisper-large-v3")?.name).toBe("groq.transcription.openai");
    expect(presetOperation(BUILT_IN_PROVIDERS.groq!, "openai-chat", undefined, "llama-3.3-70b-versatile")?.name).toBe("groq.chat");
    // A provider's own operation always comes first, and a named one is used as named.
    expect(presetOperation(BUILT_IN_PROVIDERS.openai!, "openai-transcription", undefined, "whisper-1")?.name).toBe("openai.transcription");
    expect(presetOperation(BUILT_IN_PROVIDERS.groq!, "openai-transcription", "groq.transcription", "whisper-large-v3")?.name).toBe("groq.transcription");
  });

  it("defaults a Perplexity target to the API that serves its model's id: Sonar for its own names, the Orchestrator or Agent API for maker/model ids", () => {
    const perplexity = BUILT_IN_PROVIDERS.perplexity!;
    expect(presetOperation(perplexity, "openai-chat", undefined, "sonar-pro")?.name).toBe("perplexity.chat");
    expect(presetOperation(perplexity, "openai-chat", undefined, "openai/gpt-6.2-sol")?.name).toBe("perplexity.orchestrator.chat");
    expect(presetOperation(perplexity, "openai-responses", undefined, "openai/gpt-6.2-sol")?.name).toBe("perplexity.agent");
    expect(presetOperation(perplexity, "anthropic-messages", undefined, "perplexity/glm-5.3")?.name).toBe("perplexity.orchestrator.messages");
    // A named operation is used as named: saving judges its model, serving never starts refusing it.
    expect(presetOperation(perplexity, "openai-chat", "perplexity.chat", "openai/gpt-6.2-sol")?.name).toBe("perplexity.chat");
    // An Agent-only model goes to the Agent API for Responses. For Chat Completions no Perplexity API serves
    // it: serving sends it where it always went, and saving refuses it (below).
    expect(presetOperation(perplexity, "openai-responses", undefined, "perplexity/sonar")?.name).toBe("perplexity.agent");
    expect(presetOperation(perplexity, "openai-chat", undefined, "perplexity/sonar")?.name).toBe("perplexity.chat");
    // An Orchestrator-only model goes to the Orchestrator for Responses, not to the Agent API.
    expect(presetOperation(perplexity, "openai-responses", undefined, "openai/gpt-5.4-mini")?.name).toBe("perplexity.orchestrator.responses");
    // One the Agent API's own pages show it serving, though its model list does not, counts as served there.
    expect(presetOperation(perplexity, "openai-responses", undefined, "openai/gpt-6.1-terra")?.name).toBe("perplexity.agent");
    // Every other provider's operations serve any id.
    expect(presetOperation(BUILT_IN_PROVIDERS.openrouter!, "openai-chat", undefined, "openai/gpt-4o")?.name).toBe("openrouter.chat");
  });

  it("bills a target with the same request facts as a direct call: options billed on top, answered keys, switch keys", () => {
    // No built-in preset reaches an operation with these yet, so a test operation stands in.
    const chatOperation = openai.operations.find((one) => one.name === "openai.chat")!;
    const operation: OperationDescription = {
      ...chatOperation,
      unpricedOptions: [{ in: "body", field: "web_search", kind: "flag" }],
      priceKeys: [
        { name: "language", from: { in: "body", field: "language" }, default: "en", answeredWhen: { in: "body", field: "detect_language" } },
        { name: "boost", from: { in: "body", field: "boost" }, kind: "text" },
      ],
    };
    // A type of its own: matchers are kept by provider type, and OpenAI's must stay whole for the other tests.
    const description: ProviderDescription = { ...openai, type: "preset-facts-test", operations: [operation] };
    const connection: ConnectionRecord = {
      id: "conn-1",
      accountId: "acct-1",
      type: "openai",
      slug: "oa",
      status: "active",
      baseUrl: null,
      secretBlob: null,
      rates: null,
      cloudflareGateway: null,
      servingProviders: null,
    };
    const body = { messages: [{ role: "user", content: "hi" }], web_search: true, detect_language: true, boost: "false" };
    const caller = { identity: { appId: "app-1" }, credentialHeader: "authorization", credentialToken: "agw_test", appVersion: null, clientTraceId: null, facts: { operation: null, model: null } };
    const prepared = targetAttempt({
      slug: "p1",
      caller: caller as unknown as Caller,
      preset: { provider: "oa", model: "gpt-4o-mini" } as Preset,
      style: "openai-chat",
      body: { kind: "json", body },
      streaming: false,
      connection,
      description,
      credentials: () => Promise.reject(new Error("not opened in this test")),
      target: { model: "gpt-4o-mini" },
      primary: true,
      requestId: "req-1",
      seq: 1,
      startedAt: 0,
    });
    const direct = requestFacts(operation, { body: { ...body, model: "gpt-4o-mini" }, query: new URLSearchParams() }, listPrice("openai", "gpt-4o-mini"), {});
    const want = { unpricedOptions: ["web_search"], answeredKeys: ["language"], priceKeys: { boost: "true" } };
    expect(direct).toMatchObject(want);
    expect(prepared.attempt).toMatchObject(direct);
  });

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
    expect(rows[0]!.owner_id).toBe(rows[1]!.owner_id);
    expect(rows.map((row) => row.preset)).toEqual(["chat", "chat"]);
  });

  it("sends a Perplexity fallback with a maker/model id to the Orchestrator API, not to Sonar's chat/completions", async () => {
    const first = await connection("openai");
    const second = await connection("perplexity");
    const { appId, key } = await appWith({
      presets: {
        chat: { provider: first, operation: "openai.chat", model: "gpt-4o-mini", fallback: [{ provider: second, model: "openai/gpt-6.2-sol" }] },
      },
    });
    fetchSpy
      .mockImplementationOnce(async () => Response.json({ error: { code: "server_overloaded", message: "busy" } }, { status: 503 }))
      .mockImplementationOnce(async () => CHAT_OK());
    const { response } = await post(`/v2/apps/${appId}/presets/chat`, key, { messages: [] });
    expect(response.status).toBe(200);
    expect(sent(1).url).toBe("https://api.perplexity.ai/orchestrator/v1/chat/completions");
    expect(sent(1).body.model).toBe("openai/gpt-6.2-sol");
    const rows = await charges(appId);
    expect(rows[1]).toMatchObject({ seq: 2, status: "ok", model: "openai/gpt-6.2-sol", operation: "perplexity.orchestrator.chat" });
    expect(rows[1]!.cost_nano).toBeGreaterThan(0);
  });

  it("refuses a Perplexity Agent preset call whose models list names another model than the preset's", async () => {
    const slug = await connection("perplexity");
    const { appId, key } = await appWith({ presets: { agent: { provider: slug, operation: "perplexity.agent", model: "openai/gpt-6-luna" } } });
    fetchSpy.mockImplementation(async () => Response.json({ model: "openai/gpt-6-luna", output: [], usage: { input_tokens: 10, output_tokens: 2, cost: { currency: "USD", total_cost: 0.00001 } } }));
    // Perplexity reads models before model, so it would serve the dearer one.
    const other = await post(`/v2/apps/${appId}/presets/agent`, key, { input: "hi", models: ["anthropic/claude-fable-5-2"] });
    expect(other.response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    const same = await post(`/v2/apps/${appId}/presets/agent`, key, { input: "hi", models: ["openai/gpt-6-luna"] });
    expect(same.response.status).toBe(200);
  });

  it("sends a Perplexity Agent preset whose fixed parameters name an effort with its own model as the only one", async () => {
    const slug = await connection("perplexity");
    const { appId, key } = await appWith({ presets: { agent: { provider: slug, operation: "perplexity.agent", model: "openai/gpt-6-luna", params: { effort: "low" } } } });
    fetchSpy.mockImplementation(async () => Response.json({ model: "openai/gpt-6-luna", output: [], usage: { input_tokens: 10, output_tokens: 2, cost: { currency: "USD", total_cost: 0.00002 } } }));
    const answer = await post(`/v2/apps/${appId}/presets/agent`, key, { input: "hi" });
    expect(answer.response.status).toBe(200);
    expect(sent(0).body).toMatchObject({ effort: "low", model: "openai/gpt-6-luna", models: ["openai/gpt-6-luna"] });
  });

  it("refuses a Perplexity Orchestrator preset call whose routing block names another model than the preset's", async () => {
    const slug = await connection("perplexity");
    const { appId, key } = await appWith({ presets: { chat: { provider: slug, operation: "perplexity.orchestrator.chat", model: "perplexity/glm-5.3-flash" } } });
    const routing = { default_model: "anthropic/claude-fable-5-2", routes: [{ name: "a", description: "Anything.", model: "anthropic/claude-fable-5-2" }] };
    const answer = await post(`/v2/apps/${appId}/presets/chat`, key, { messages: [], routing });
    expect(answer.response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
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

  it("refuses an unknown preset and a disabled one with no fallback, spending nothing", async () => {
    const paused = await connection("openai", "disabled");
    const { appId, key } = await appWith({ presets: { paused: { provider: paused, operation: "openai.chat", model: "gpt-4o-mini" } } });
    expect((await post(`/v2/apps/${appId}/presets/nope`, key, {})).response.status).toBe(404);
    const disabled = await post(`/v2/apps/${appId}/presets/paused`, key, { messages: [] });
    expect(disabled.response.status).toBe(502);
    expect(JSON.parse(disabled.text).error.code).toBe("provider_disabled");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await charges(appId)).toHaveLength(0);
  });

  it("serves a first target whose price has gone since the preset was saved, priced later", async () => {
    const live = await connection("openai");
    const { appId, key } = await appWith({ presets: { gone: { provider: live, operation: "openai.chat", model: "no-such-model-zz" } } });
    fetchSpy.mockImplementation(async () => CHAT_OK());
    expect((await post(`/v2/apps/${appId}/presets/gone`, key, { messages: [] })).response.status).toBe(200);
    expect((await charges(appId))[0]).toMatchObject({ status: "ok", price_source: "unresolved", cost_nano: null, preset: "gone" });
  });

  it("refuses a first target whose key cannot be opened, and leaves out a fallback's, so the last usable answer passes through", async () => {
    const first = await connection("openai");
    const broken = await connection("openai");
    await env.DB.prepare("UPDATE provider_connection SET secret_blob = 'not-a-sealed-secret' WHERE slug = ?").bind(broken).run();
    const { appId, key } = await appWith({
      presets: {
        primary: { provider: broken, operation: "openai.chat", model: "gpt-4o-mini", fallback: [{ provider: first, model: "gpt-4o-mini" }] },
        fallback: { provider: first, operation: "openai.chat", model: "gpt-4o-mini", fallback: [{ provider: broken, model: "gpt-4o-mini" }] },
      },
    });
    const refused = await post(`/v2/apps/${appId}/presets/primary`, key, { messages: [] });
    expect(refused.response.status).toBe(502);
    expect(JSON.parse(refused.text).error.code).toBe("provider_unavailable");
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockImplementation(async () => Response.json({ error: { code: "busy" } }, { status: 503 }));
    const passed = await post(`/v2/apps/${appId}/presets/fallback`, key, { messages: [] });
    expect(passed.response.status).toBe(503);
    expect(JSON.parse(passed.text)).toEqual({ error: { code: "busy" } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((await charges(appId)).map((row) => [row.seq, row.http_status])).toEqual([[1, 503]]);
  });

  it("sends nothing more once the app went away", async () => {
    const first = await connection("openai");
    const second = await connection("openai");
    const { appId, key } = await appWith({
      presets: { chat: { provider: first, operation: "openai.chat", model: "gpt-4o-mini", fallback: [{ provider: second, model: "gpt-4o-mini" }] } },
    });
    const app = new AbortController();
    let providerSignal: AbortSignal | null | undefined;
    fetchSpy.mockImplementation(async (_input, init) => {
      providerSignal = init?.signal;
      app.abort();
      return Response.json({ error: { code: "busy" } }, { status: 503 });
    });
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v2/apps/${appId}/presets/chat`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "x-end-user-id": "user-1", "content-type": "application/json" },
        body: JSON.stringify({ messages: [] }),
        signal: app.signal,
      }),
      env,
      ctx,
    );
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await charges(appId)).toHaveLength(1);
    // The provider's own signal is untouched when the app goes away: its answer is read to the end.
    expect(providerSignal?.aborted).toBe(false);
  });

  it("passes the held 503 on when the budget is gone before a fallback, never building its body", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { c, done } = fakeContext();
      const requestId = `req_${crypto.randomUUID()}`;
      const fallback = unitAttempt(2, { body: vi.fn(jsonBody), requestId });
      fetchSpy.mockImplementation(async () => {
        vi.setSystemTime(Date.now() + 121_000);
        return Response.json({ error: { code: "busy" } }, { status: 503 });
      });
      const response = await sendAttempts(c, NO_CLIENT, [unitAttempt(1, { requestId }), fallback]);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: "busy" } });
      await done();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fallback.body).not.toHaveBeenCalled();
      expect(fallback.credentials).not.toHaveBeenCalled();
      expect((await chargesOfCall(requestId)).map((row) => [row.seq, row.http_status])).toEqual([[1, 503]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits as long as an operation declares for the provider's answer, and 120 s otherwise", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      // The provider answers after 150 s, honouring the request's abort signal.
      fetchSpy.mockImplementation(
        (_input, init) =>
          new Promise<Response>((resolve, reject) => {
            const answer = () => resolve(Response.json({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
            const timer = setTimeout(answer, 150_000); // real-timer: faked by vi.useFakeTimers above; the provider's 150 s, advanced by the test.
            init?.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      );
      const chat = BUILT_IN_PROVIDERS.openai!.operations.find((operation) => operation.name === "openai.chat")!;
      const patient = fakeContext();
      const waited = sendAttempts(patient.c, NO_CLIENT, [unitAttempt(1, { operation: { ...chat, responseDeadlineMs: 20 * 60 * 1000 } })]);
      await vi.advanceTimersByTimeAsync(150_001);
      const got = await waited;
      expect(got.status).toBe(200);
      // The charge is written once the answer has been read.
      await got.text();
      await patient.done();
      const hurried = fakeContext();
      const cut = sendAttempts(hurried.c, NO_CLIENT, [unitAttempt(1)]).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(150_001);
      expect(await cut).toMatchObject({ status: 504 });
      await hurried.done();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits as long as the deployment's PROVIDER_TTFB_TIMEOUT_SECONDS says, for an operation with no time of its own (as v1)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      fetchSpy.mockImplementation(
        (_input, init) =>
          new Promise<Response>((resolve, reject) => {
            const answer = () => resolve(Response.json({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
            const timer = setTimeout(answer, 150_000); // real-timer: faked by vi.useFakeTimers above; the provider's 150 s, advanced by the test.
            init?.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      );
      const raised = fakeContext({ ...env, PROVIDER_TTFB_TIMEOUT_SECONDS: "200" } as Env);
      const waited = sendAttempts(raised.c, NO_CLIENT, [unitAttempt(1)]);
      await vi.advanceTimersByTimeAsync(150_001);
      const got = await waited;
      expect(got.status).toBe(200);
      await got.text();
      await raised.done();
      const lowered = fakeContext({ ...env, PROVIDER_TTFB_TIMEOUT_SECONDS: "30" } as Env);
      const cut = sendAttempts(lowered.c, NO_CLIENT, [unitAttempt(1)]).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await cut).toMatchObject({ status: 504 });
      await lowered.done();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the first-byte time with the provider attempt: opening the key first keeps its own budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      // The provider answers 20 s after it is asked.
      fetchSpy.mockImplementation(
        (_input, init) =>
          new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(() => resolve(Response.json({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })), 20_000); // real-timer: faked by vi.useFakeTimers above.
            init?.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      );
      // Opening the key takes 45 s, longer than the deployment's 30 s first-byte time.
      const slowKey = () =>
        new Promise<UpstreamCredentials>((resolve) => {
          setTimeout(() => resolve({ providerKey: "sk-test-slow-open", cloudflareToken: null }), 45_000); // real-timer: faked by vi.useFakeTimers above.
        });
      const context = fakeContext({ ...env, PROVIDER_TTFB_TIMEOUT_SECONDS: "30" } as Env);
      const answered = sendAttempts(context.c, NO_CLIENT, [unitAttempt(1, { credentials: vi.fn(slowKey) })]);
      await vi.advanceTimersByTimeAsync(45_000 + 20_001);
      const response = await answered;
      expect(response.status).toBe(200);
      await response.text();
      await context.done();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads PROVIDER_TTFB_TIMEOUT_SECONDS as v1 does: any positive number of seconds, 120 otherwise", () => {
    const ms = (value: unknown) => providerTtfbTimeoutMs({ ...env, PROVIDER_TTFB_TIMEOUT_SECONDS: value } as unknown as Env);
    expect(ms(undefined)).toBe(120_000);
    expect(ms("")).toBe(120_000);
    expect(ms("300")).toBe(300_000);
    expect(ms(45)).toBe(45_000);
    expect(ms("1.5")).toBe(1_500);
    expect(ms("99999")).toBe(99_999_000);
    expect(ms("0")).toBe(120_000);
    expect(ms("-5")).toBe(120_000);
    expect(ms("ninety")).toBe(120_000);
  });

  it("passes the held 503 on when a fallback's key uses up the budget, sending nothing after it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const { c, done } = fakeContext();
      const requestId = `req_${crypto.randomUUID()}`;
      const hanging = unitAttempt(2, { credentials: vi.fn(() => new Promise<UpstreamCredentials>(() => undefined)), requestId });
      const after = unitAttempt(3, { requestId });
      fetchSpy.mockImplementation(async () => Response.json({ error: { code: "busy" } }, { status: 503 }));
      const answered = sendAttempts(c, NO_CLIENT, [unitAttempt(1, { requestId }), hanging, after]);
      await vi.advanceTimersByTimeAsync(120_001);
      const response = await answered;
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: "busy" } });
      await done();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(after.credentials).not.toHaveBeenCalled();
      expect(after.body).not.toHaveBeenCalled();
      expect((await chargesOfCall(requestId)).map((row) => row.seq)).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes the held 503 on when building a fallback's body uses up the budget", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { c, done } = fakeContext();
      const requestId = `req_${crypto.randomUUID()}`;
      const slow = unitAttempt(2, {
        requestId,
        body: vi.fn(() => {
          vi.setSystemTime(Date.now() + 121_000);
          return jsonBody();
        }),
      });
      fetchSpy.mockImplementation(async () => Response.json({ error: { code: "busy" } }, { status: 503 }));
      const response = await sendAttempts(c, NO_CLIENT, [unitAttempt(1, { requestId }), slow]);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: "busy" } });
      await done();
      expect(slow.body).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect((await chargesOfCall(requestId)).map((row) => [row.seq, row.http_status])).toEqual([[1, 503]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers from the first attempt at once, never opening a fallback's key it does not need", async () => {
    const { c, done } = fakeContext();
    const hanging = unitAttempt(2, { credentials: vi.fn(() => new Promise<UpstreamCredentials>(() => undefined)) });
    fetchSpy.mockImplementation(async () => CHAT_OK());
    const response = await sendAttempts(c, NO_CLIENT, [unitAttempt(1), hanging]);
    expect(response.status).toBe(200);
    await response.text();
    await done();
    expect(hanging.credentials).not.toHaveBeenCalled();
  });

  it("passes the 503 on as it is when the last fallback's key cannot be opened in the time left", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const { c, done } = fakeContext();
      const requestId = `req_${crypto.randomUUID()}`;
      const hanging = unitAttempt(2, { credentials: vi.fn(() => new Promise<UpstreamCredentials>(() => undefined)), requestId });
      fetchSpy.mockImplementation(async () => Response.json({ error: { code: "busy" } }, { status: 503 }));
      const answered = sendAttempts(c, NO_CLIENT, [unitAttempt(1, { requestId }), hanging]);
      await vi.advanceTimersByTimeAsync(120_001);
      const response = await answered;
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: "busy" } });
      await done();
      expect(hanging.credentials).toHaveBeenCalledTimes(1);
      expect(hanging.body).not.toHaveBeenCalled();
      expect((await chargesOfCall(requestId)).map((row) => row.seq)).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes a failed attempt's charge even when cancelling the rest of its body never settles", async () => {
    const first = await connection("openai");
    const second = await connection("openai");
    const { appId, key } = await appWith({
      presets: { chat: { provider: first, operation: "openai.chat", model: "gpt-4o-mini", fallback: [{ provider: second, model: "gpt-4o-mini" }] } },
    });
    const stuck = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"error":{"code":"busy","pad":"${"x".repeat(9000)}"}}`));
      },
      cancel: () => new Promise<void>(() => undefined),
    });
    fetchSpy.mockImplementationOnce(async () => new Response(stuck, { status: 503 })).mockImplementationOnce(async () => CHAT_OK());
    expect((await post(`/v2/apps/${appId}/presets/chat`, key, { messages: [] })).response.status).toBe(200);
    expect((await charges(appId)).map((row) => row.status)).toEqual(["provider_error", "ok"]);
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

  it("sends alt=sse to a preset that names Gemini's streaming method itself", async () => {
    const slug = await connection("gemini");
    const { appId, key } = await appWith({ presets: { gem: { provider: slug, operation: "gemini.stream.v1beta", model: "gemini-2.5-flash" } } });
    fetchSpy.mockImplementation(async () => new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } }));
    await post(`/v2/apps/${appId}/presets/gem?alt=sse`, key, { contents: [] });
    expect(sent().url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse");
  });

  it("adds the API version Anthropic needs when the client sends none", async () => {
    const slug = await connection("anthropic");
    const { appId, key } = await appWith({ presets: { msg: { provider: slug, operation: "anthropic.messages", model: "claude-haiku-4-5" } } });
    fetchSpy.mockImplementation(async () => Response.json({ content: [], usage: { input_tokens: 5, output_tokens: 1 } }));
    await post(`/v2/apps/${appId}/presets/msg`, key, { messages: [], max_tokens: 10 });
    expect(sent().headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("logs a fallback that refuses this request apart from one that cannot work", async () => {
    const xai = await connection("xai");
    const openai = await connection("openai");
    const { appId, key } = await appWith({
      presets: {
        stt: {
          provider: xai,
          operation: "xai.transcription",
          model: "grok-transcribe",
          fallback: [{ provider: openai, model: "whisper-1" }, { provider: "gone-connection", model: "whisper-1" }],
        },
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchSpy.mockImplementation(async () => Response.json({ text: "hi", duration: 3 }));
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(64)], { type: "audio/mpeg" }), "a.mp3");
    // OpenAI cannot price a plain-text answer, so its fallback refuses this request; xAI has no such rule.
    form.append("response_format", "text");
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v2/apps/${appId}/presets/stt`, { method: "POST", headers: { authorization: `Bearer ${key}`, "x-end-user-id": "u" }, body: form }),
      env,
      ctx,
    );
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const logged = warn.mock.calls.map(([line]) => (typeof line === "string" ? line : JSON.stringify(line)));
    expect(logged.filter((line) => line.includes('"preset_fallback_refused_request"') && line.includes(openai))).toHaveLength(1);
    expect(logged.filter((line) => line.includes('"preset_fallback_skipped"') && line.includes("gone-connection"))).toHaveLength(1);
  });

  it("sends an image-edit preset's upload as a form, with each attempt's model set", async () => {
    const slug = await connection("openai");
    const { appId, key } = await appWith({ presets: { edit: { provider: slug, operation: "openai.images.edits", model: "gpt-image-2" } } });
    fetchSpy.mockImplementation(async () => Response.json({ data: [], usage: { input_tokens: 10, output_tokens: 20 } }));
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(64)], { type: "image/png" }), "a.png");
    form.append("prompt", "a hat");
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v2/apps/${appId}/presets/edit`, { method: "POST", headers: { authorization: `Bearer ${key}`, "x-end-user-id": "u" }, body: form }),
      env,
      ctx,
    );
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const sentForm = upstreamCalls()[0]![1]!.body as FormData;
    expect(sentForm.get("model")).toBe("gpt-image-2");
    expect(sentForm.get("prompt")).toBe("a hat");
    expect(sentForm.get("image")).toBeInstanceOf(File);
    expect((await charges(appId))[0]).toMatchObject({ model: "gpt-image-2", status: "ok" });
  });

  it("refuses a form for a preset whose API takes JSON, so its output cap always applies", async () => {
    const slug = await connection("openai");
    const { appId, key } = await appWith({ presets: { chat: { provider: slug, operation: "openai.chat", model: "gpt-4o-mini", max_output_tokens: 64 } } });
    const form = new FormData();
    form.append("max_tokens", "1000");
    form.append("messages", "[]");
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v2/apps/${appId}/presets/chat`, { method: "POST", headers: { authorization: `Bearer ${key}`, "x-end-user-id": "u" }, body: form }),
      env,
      ctx,
    );
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
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
    const sentForm = upstreamCalls()[0]![1]!.body as FormData;
    expect(sentForm.get("model")).toBe("whisper-1");
    expect(sentForm.get("file")).toBeInstanceOf(File);
    expect((await charges(appId))[0]).toMatchObject({ model: "whisper-1", unit: "audio_seconds" });
  });
});

describe("saving rewrites and presets", () => {
  it("does not store or return empty rewrites and presets", async () => {
    const key = await seedManagementKey();
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v2/admin/apps`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Empty",
          config: { authentication: { type: "api_key", end_user: { source: "none" } }, routing: { model_rewrites: {} }, presets: {} },
        }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const created = (await response.json()) as { app: { id: string; config: Record<string, any> } };
    expect(created.app.config).not.toHaveProperty("presets");
    expect(created.app.config.routing).not.toHaveProperty("model_rewrites");
    const stored = await env.DB.prepare("SELECT config_json FROM app WHERE id = ?").bind(created.app.id).first<{ config_json: string }>();
    expect(stored!.config_json).not.toContain("presets");
    expect(stored!.config_json).not.toContain("model_rewrites");
  });

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

  it("lets an app with a stored rewrite whose price has gone be saved, if the rewrite is unchanged", async () => {
    await withoutCostReporters();
    const { appId } = await appWith({ routing: { model_rewrites: { house: "no-such-model-zz" } } });
    const key = await seedManagementKey();
    const put = async (rewrites: Record<string, string>) => {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(`${ORIGIN}/v2/admin/apps/${appId}`, {
          method: "PUT",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ name: "Renamed", revision: 1, config: { authentication: AUTH, routing: { model_rewrites: rewrites } } }),
        }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return response.status;
    };
    expect(await put({ house: "no-such-model-yy" })).toBe(400);
    expect(await put({ house: "no-such-model-zz" })).toBe(200);
  });

  it("lets an app whose listed, rewritten model lost its price be saved unchanged, but checks a newly listed one", async () => {
    const slug = await connection("openai");
    const routing = { providers: { [slug]: { operations: ["openai.chat"], models: ["house"] } }, model_rewrites: { house: "no-such-model-zz" } };
    const { appId } = await appWith({ routing });
    const key = await seedManagementKey();
    const put = async (config: Record<string, unknown>) => {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(`${ORIGIN}/v2/admin/apps/${appId}`, {
          method: "PUT",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ name: "Renamed", revision: 1, config: { authentication: AUTH, ...config } }),
        }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return response.status;
    };
    expect(await put({ routing: { ...routing, providers: { [slug]: { operations: ["openai.chat"], models: ["house", "other-zz"] } } } })).toBe(400);
    expect(await put({ routing })).toBe(200);
  });

  it("accepts a rewrite to a model a connection that reports its own cost can bill, as v1", async () => {
    await connection("openrouter");
    expect((await save({ routing: { model_rewrites: { house: "some-router-model-zz" } } })).status).toBe(200);
  });

  it("accepts a service mode in a preset's params on an operation that reports its own cost", async () => {
    const slug = await connection("xai");
    expect((await save({ presets: { a: { provider: slug, operation: "xai.chat", model: "grok-4.6", params: { service_tier: "priority" } } } })).status).toBe(200);
  });

  it("needs a price for each rewrite's target, and judges a listed model by its rewrite", async () => {
    await withoutCostReporters();
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
    const perplexity = await connection("perplexity");
    const ok = { provider: openai, operation: "openai.chat", model: "gpt-4o-mini" };
    expect((await save({ presets: { a: { ...ok, fallback: [{ provider: anthropic, model: "claude-haiku-4-5" }] } } })).status).toBe(200);
    expect((await save({ presets: { a: { ...ok, fallback: [{ provider: perplexity, model: "openai/gpt-6.2-sol" }] } } })).status).toBe(200);
    expect((await save({ presets: { a: { provider: perplexity, operation: "perplexity.agent", model: "perplexity/sonar" } } })).status).toBe(200);
    const cases: [Record<string, unknown>, string][] = [
      [{ ...ok, provider: "missing-zz" }, "no provider connection"],
      [{ ...ok, operation: "openai.realtime" }, "not an operation a preset can use"],
      [{ ...ok, fallback: [{ provider: anthropic, operation: "anthropic.messages", model: "claude-haiku-4-5" }] }, "a fallback must speak"],
      [{ ...ok, fallback: [{ provider: anthropic, model: "no-such-model-zz" }] }, "has no price"],
      [{ ...ok, params: { service_tier: "warp" } }, "has no service mode"],
      [{ provider: openai, operation: "openai.transcription", model: "whisper-1", params: { language: "en" } }, "params apply only to JSON"],
      [{ provider: openai, operation: "openai.embeddings", model: "text-embedding-3-small", max_output_tokens: 5 }, "has no output to cap"],
      [{ ...ok, max_output_tokens: 100, params: { max_completion_tokens: 200 } }, "exceeds the configured max_output_tokens"],
      [{ provider: openai, operation: "openai.responses", model: "gpt-4o-mini", params: { background: true } }, "Background"],
      // Sonar's chat/completions serves only Perplexity's own names; the Orchestrator API only maker/model ids.
      [{ provider: perplexity, operation: "perplexity.chat", model: "openai/gpt-6.2-sol" }, "serves only the provider's own model names"],
      [{ provider: perplexity, operation: "perplexity.orchestrator.chat", model: "sonar-pro" }, "serves only maker/model ids"],
      [{ ...ok, fallback: [{ provider: perplexity, operation: "perplexity.chat", model: "openai/gpt-6.2-sol" }] }, "serves only the provider's own model names"],
      // perplexity/sonar is on the Agent API only: no Chat Completions operation serves it.
      [{ ...ok, fallback: [{ provider: perplexity, model: "perplexity/sonar" }] }, "has no openai-chat operation a preset can use that serves perplexity/sonar"],
      [{ ...ok, fallback: [{ provider: perplexity, operation: "perplexity.orchestrator.chat", model: "perplexity/sonar" }] }, "does not serve perplexity/sonar"],
      [{ provider: perplexity, operation: "perplexity.agent", model: "openai/gpt-5.4-mini" }, "does not serve openai/gpt-5.4-mini"],
      // A preset may fix perplexity/auto, the customer's choice to let Perplexity pick, but only with a price for it.
      [{ provider: perplexity, operation: "perplexity.orchestrator.chat", model: "perplexity/auto" }, "has no price"],
      // Fixed parameters naming another model than the preset's would refuse every call: refused by the save-time rule.
      [{ provider: perplexity, operation: "perplexity.agent", model: "openai/gpt-6-luna", params: { models: ["openai/gpt-6.2-sol"] } }, "a preset fixes its model to openai/gpt-6-luna"],
      [{ provider: perplexity, operation: "perplexity.agent", model: "openai/gpt-6-luna", params: { Models: ["openai/gpt-6.2-sol"] } }, "Models must be spelled models"],
    ];
    for (const [preset, message] of cases) {
      const answer = await save({ presets: { a: preset } });
      expect(answer.status, message).toBe(400);
      expect(answer.body.error.message, message).toContain(message);
    }
  });
});

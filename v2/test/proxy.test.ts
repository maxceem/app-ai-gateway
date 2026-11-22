/**
 * The first complete call: OpenAI chat through the proxy, end to end, with
 * the provider mocked at `fetch`.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../src/index.ts";
import { sealSecret } from "../src/vault/secrets.ts";
import {
  ACCOUNT_ID,
  attestAuthentication,
  clearCaches,
  registerTestInstall,
  seedAccount,
  seedAppKey,
  seedRoutedApp,
  signedProof,
  tokenForInstall,
} from "./helpers.ts";

const ORIGIN = "https://gateway.test";
const SECRET = "sk-test-provider-key-1234";

async function seedConnection(
  options: {
    slug?: string;
    baseUrl?: string | null;
    rates?: Record<string, unknown> | null;
    status?: "active" | "disabled";
    secret?: string;
  } = {},
): Promise<{ id: string; slug: string }> {
  await seedAccount();
  const id = crypto.randomUUID().replaceAll("-", "");
  const slug = options.slug ?? `openai-${id.slice(0, 6)}`;
  const baseUrl = options.baseUrl ?? null;
  const blob = await sealSecret(env, "providerKey", [ACCOUNT_ID, id, "openai", baseUrl ?? ""], options.secret ?? SECRET);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO provider_connection
      (id, account_id, type, slug, name, status, secret_blob, secret_hint, base_url, rates_json, revision, created_by, created_at, updated_at)
     VALUES (?, ?, 'openai', ?, 'OpenAI', ?, ?, '1234', ?, ?, 1, 'usr_test', ?, ?)`,
  )
    .bind(id, ACCOUNT_ID, slug, options.status ?? "active", blob, baseUrl, options.rates === undefined || options.rates === null ? null : JSON.stringify(options.rates), now, now)
    .run();
  return { id, slug };
}

/** A server app with an app key, allowed to call chat on one connection. */
async function setup(routing: Record<string, unknown> = {}, connection: Parameters<typeof seedConnection>[0] = {}) {
  const { id: connectionId, slug } = await seedConnection(connection);
  const appId = await seedRoutedApp(
    { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
    { providers: { [slug]: { operations: ["openai.chat"], ...routing } } },
  );
  const key = await seedAppKey(appId);
  return { appId, slug, connectionId, key: key.key };
}

async function call(path: string, init: RequestInit = {}, environment: Env = env): Promise<{ response: Response; ctx: ExecutionContext }> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${ORIGIN}${path}`, init), environment, ctx);
  return { response, ctx };
}

function chatRequest(key: string, body: Record<string, unknown>, extra: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-end-user-id": "user-7", "x-private": "no", ...extra },
    body: JSON.stringify(body),
  };
}

const USAGE = { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 200 } };

/** gpt-4o-mini on our list: $0.15 input, $0.075 cached input, $0.6 output per million. */
async function expectedCost(): Promise<number> {
  const { listPrice } = await import("../src/pricing/prices.ts");
  const { priceTokens } = await import("../src/pricing/tokens.ts");
  return priceTokens(listPrice("openai", "gpt-4o-mini")!, {
    inputTokens: 800,
    cachedInputTokens: 200,
    cacheWriteTokens: 0,
    outputTokens: 100,
  })!.cost;
}

async function chargesOf(appId: string): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("SELECT * FROM charge WHERE app_id = ? ORDER BY written_at, id").bind(appId).all();
  return results;
}

let fetchSpy: MockInstance<typeof fetch>;

function upstreamRequest(index = 0): { url: string; headers: Headers; body: Record<string, unknown> } {
  const [input, init] = fetchSpy.mock.calls[index]!;
  const body = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as Record<string, unknown>;
  return { url: String(input), headers: new Headers(init?.headers), body };
}

beforeEach(() => {
  clearCaches();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => vi.restoreAllMocks());

describe("OpenAI chat through the proxy", () => {
  it("passes a JSON answer through and writes one priced charge", async () => {
    const { appId, slug, connectionId, key } = await setup();
    fetchSpy.mockResolvedValue(
      Response.json({ id: "chatcmpl-1", choices: [], usage: USAGE }, { headers: { "openai-organization": "org-x", "set-cookie": "a=b" } }),
    );
    const { response, ctx } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, chatRequest(key, { model: "gpt-4o-mini", messages: [] }));
    expect(response.status).toBe(200);
    expect(response.headers.get("openai-organization")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toMatchObject({ id: "chatcmpl-1" });
    await waitOnExecutionContext(ctx);

    const sent = upstreamRequest();
    expect(sent.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(sent.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
    expect(sent.headers.get("x-end-user-id")).toBeNull();
    expect(sent.headers.get("x-private")).toBeNull();
    expect(sent.body).not.toHaveProperty("stream_options");

    const charges = await chargesOf(appId);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({
      kind: "attempt",
      owner_type: "call",
      seq: 1,
      status: "ok",
      http_status: 200,
      provider_type: "openai",
      provider_connection_id: connectionId,
      operation: "openai.chat",
      model: "gpt-4o-mini",
      end_user_id: "user-7",
      measured: "complete",
      price_source: "list_rate",
      cost_nano: await expectedCost(),
      input_tokens: 800,
      cached_input_tokens: 200,
      output_tokens: 100,
      unit: "tokens",
      units: 1100,
    });
  });

  it("asks a stream for its usage, and prices the final usage chunk", async () => {
    const { appId, slug, key } = await setup();
    const events = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: USAGE })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    fetchSpy.mockResolvedValue(new Response(events, { headers: { "content-type": "text/event-stream" } }));
    const { response, ctx } = await call(
      `/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`,
      chatRequest(key, { model: "gpt-4o-mini", stream: true, messages: [] }),
    );
    expect(await response.text()).toBe(events);
    await waitOnExecutionContext(ctx);
    expect(upstreamRequest().body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(await chargesOf(appId)).toMatchObject([{ status: "ok", measured: "complete", cost_nano: await expectedCost() }]);
  });

  it("passes a provider error through, and records a failed attempt with no cost", async () => {
    const { appId, slug, key } = await setup();
    const body = JSON.stringify({ error: { message: "Slow down", code: "rate_limit_exceeded" } });
    fetchSpy.mockResolvedValue(new Response(body, { status: 429, headers: { "content-type": "application/json", "retry-after": "2" } }));
    const { response, ctx } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, chatRequest(key, { model: "gpt-4o-mini" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(await response.text()).toBe(body);
    await waitOnExecutionContext(ctx);
    expect(await chargesOf(appId)).toMatchObject([
      { status: "provider_error", http_status: 429, error_code: "rate_limit_exceeded", cost_nano: null, measured: "complete" },
    ]);
  });

  it("records a stream the app left early as partial, with no cost", async () => {
    const { appId, slug, key } = await setup();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [] })}\n\n`));
      },
      cancel() {
        cancelled = true;
      },
    });
    fetchSpy.mockResolvedValue(new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    const { response, ctx } = await call(
      `/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`,
      chatRequest(key, { model: "gpt-4o-mini", stream: true }),
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await waitOnExecutionContext(ctx);
    expect(cancelled).toBe(true);
    expect(await chargesOf(appId)).toMatchObject([
      { status: "client_aborted", measured: "partial", price_source: "unresolved", cost_nano: null },
    ]);
    expect(errors.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("usage_unresolved_cost"));
  });

  it("serves a listed model whose price disappeared, and leaves its charge for the sweep to price", async () => {
    const { appId, slug, key } = await setup({ models: ["gpt-retired-zz"] });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchSpy.mockResolvedValue(Response.json({ choices: [], usage: USAGE }));
    const { response, ctx } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, chatRequest(key, { model: "gpt-retired-zz" }));
    expect(response.status).toBe(200);
    await response.text();
    await waitOnExecutionContext(ctx);
    const [charge] = await chargesOf(appId);
    expect(charge).toMatchObject({ price_source: "unresolved", cost_nano: null, measured: "complete", input_tokens: 800 });
    const work = await env.DB.prepare("SELECT kind, charge_id FROM open_work WHERE charge_id = ?").bind(charge!.id).first();
    expect(work).toEqual({ kind: "unresolved", charge_id: charge!.id });
  });

  it("refuses a model with no price that the app does not name, before calling the provider", async () => {
    const { appId, slug, key } = await setup();
    const { response } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, chatRequest(key, { model: "gpt-unknown-zz" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "pricing_not_configured" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a model the app does not allow, and records a rejection event", async () => {
    const { appId, slug, key } = await setup({ models: ["gpt-4o-mini"] });
    const { response, ctx } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, chatRequest(key, { model: "gpt-4o" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "model_not_allowed", data: { model: "gpt-4o" } } });
    await waitOnExecutionContext(ctx);
    expect(fetchSpy).not.toHaveBeenCalled();
    const event = await env.DB.prepare("SELECT reason, model, operation, user_id FROM app_rejection_event WHERE app_id = ?").bind(appId).first();
    expect(event).toEqual({ reason: "model_not_allowed", model: "gpt-4o", operation: "openai.chat", user_id: "user-7" });
  });

  it("records a path the app does not allow, samples once a minute per user and reason, and records nothing for an unproven caller (v1 config-refusals)", async () => {
    const { appId, slug, key } = await setup({ models: ["gpt-4o-mini"] });
    const rejections = async () =>
      (await env.DB.prepare("SELECT reason, user_id, operation FROM app_rejection_event WHERE app_id = ? ORDER BY id").bind(appId).all()).results;
    const send = async (path: string, model: string, extra: Record<string, string> = {}, bearer = key) => {
      const { response, ctx } = await call(`/v2/apps/${appId}/proxy/${slug}/${path}`, chatRequest(bearer, { model }, extra));
      await waitOnExecutionContext(ctx);
      return response.status;
    };
    // A path the app does not allow: recorded, with no operation, since none matched.
    expect(await send("v1/files", "gpt-4o-mini")).toBe(403);
    // Two refused models in the same minute: one sample. Another reason for the same user is still recorded.
    expect(await send("v1/chat/completions", "gpt-4o")).toBe(403);
    expect(await send("v1/chat/completions", "gpt-4.1")).toBe(403);
    // Another user is sampled on their own.
    expect(await send("v1/chat/completions", "gpt-4o", { "x-end-user-id": "user-8" })).toBe(403);
    // A caller that never proved who it is records nothing.
    expect(await send("v1/chat/completions", "gpt-4o", {}, "agw_app_not-a-real-key")).toBe(401);
    expect(await rejections()).toEqual([
      { reason: "path_not_allowed", user_id: "user-7", operation: null },
      { reason: "model_not_allowed", user_id: "user-7", operation: "openai.chat" },
      { reason: "model_not_allowed", user_id: "user-8", operation: "openai.chat" },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an operation the app does not allow, a refused path and an undeclared path", async () => {
    const { appId, slug, key } = await setup({ operations: ["openai.realtime"] });
    for (const path of ["v1/chat/completions", "v1/organization/users", "v1/files", "v1/../v1/chat/completions"]) {
      const { response } = await call(`/v2/apps/${appId}/proxy/${slug}/${path}`, chatRequest(key, { model: "gpt-4o-mini" }));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "path_not_allowed" } });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("writes the output cap into a request that names none, and refuses one that asks for more", async () => {
    const { appId, slug, key } = await setup({ max_output_tokens: 256 });
    fetchSpy.mockResolvedValue(Response.json({ choices: [], usage: USAGE }));
    const first = await call(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, chatRequest(key, { model: "gpt-4o-mini" }));
    await first.response.text();
    await waitOnExecutionContext(first.ctx);
    expect(upstreamRequest().body).toMatchObject({ max_completion_tokens: 256 });
    const { response } = await call(
      `/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`,
      chatRequest(key, { model: "gpt-4o-mini", max_tokens: 1000 }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "max_output_tokens_exceeded" } });
    // `null` asks for no limit: the cap is written instead, so it cannot be skipped.
    const unlimited = await call(
      `/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`,
      chatRequest(key, { model: "gpt-4o-mini", max_completion_tokens: null }),
    );
    await unlimited.response.text();
    await waitOnExecutionContext(unlimited.ctx);
    expect(upstreamRequest(1).body).toMatchObject({ max_completion_tokens: 256 });
  });

  it("sends a connection with its own base URL there, and refuses a disabled connection", async () => {
    const { appId, slug, key } = await setup({}, { baseUrl: "https://llm.example.com/openai/" });
    fetchSpy.mockResolvedValue(Response.json({ choices: [], usage: USAGE }));
    const routed = await call(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, chatRequest(key, { model: "gpt-4o-mini" }));
    await routed.response.text();
    await waitOnExecutionContext(routed.ctx);
    expect(upstreamRequest().url).toBe("https://llm.example.com/openai/v1/chat/completions");

    const disabled = await setup({}, { status: "disabled" });
    const { response } = await call(
      `/v2/apps/${disabled.appId}/proxy/${disabled.slug}/v1/chat/completions`,
      chatRequest(disabled.key, { model: "gpt-4o-mini" }),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "provider_disabled" } });
  });

  it("uses the customer's own rate before ours", async () => {
    const { appId, slug, key } = await setup({}, { rates: { "gpt-4o-mini": { input: 1_000_000_000, output: 2_000_000_000 } } });
    fetchSpy.mockResolvedValue(Response.json({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }));
    const priced = await call(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, chatRequest(key, { model: "gpt-4o-mini" }));
    await priced.response.text();
    await waitOnExecutionContext(priced.ctx);
    // 1000 × $1/M + 1000 × $2/M = $0.003
    expect(await chargesOf(appId)).toMatchObject([{ price_source: "customer_rate", cost_nano: 3_000_000 }]);
  });

  it("answers before a slow ledger write finishes", async () => {
    const { appId, slug, key } = await setup();
    fetchSpy.mockResolvedValue(Response.json({ choices: [], usage: USAGE }));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let written = false;
    const slowDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            await held;
            const result = await target.batch(statements);
            written = true;
            return result;
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const { response, ctx } = await call(
      `/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`,
      chatRequest(key, { model: "gpt-4o-mini" }),
      { ...env, DB: slowDb } as Env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ choices: [] });
    expect(written).toBe(false);
    release();
    await waitOnExecutionContext(ctx);
    expect(written).toBe(true);
    expect(await chargesOf(appId)).toHaveLength(1);
  });

  it("records a provider that never answered as a failed attempt, and answers 504 or 502", async () => {
    const { appId, slug, key } = await setup();
    fetchSpy.mockRejectedValue(new Error("connection refused"));
    const { response, ctx } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, chatRequest(key, { model: "gpt-4o-mini" }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "provider_error" } });
    await waitOnExecutionContext(ctx);
    expect(await chargesOf(appId)).toMatchObject([{ status: "network_error", cost_nano: null }]);
  });

  it("needs a valid app key, and names no connection to a caller who has none", async () => {
    const { appId, slug } = await setup();
    const { response } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, chatRequest("agw_wrong", { model: "gpt-4o-mini" }));
    expect(response.status).toBe(401);
    const missing = await call(`/v2/apps/${appId}/proxy/no-such-slug/v1/chat/completions`, chatRequest("agw_wrong", { model: "x" }));
    expect(missing.response.status).toBe(401);
  });
});

describe("review fixes", () => {
  it("never sends the app's credential, end-user id or a query key to the provider (S1)", async () => {
    const { id: _connection, slug } = await seedConnection();
    void _connection;
    const appId = await seedRoutedApp(
      { type: "api_key", end_user: { source: "header", header: "x-stainless-user" } },
      { providers: { [slug]: { operations: ["openai.chat"] } } },
    );
    const { key } = await seedAppKey(appId);
    fetchSpy.mockResolvedValue(Response.json({ choices: [], usage: USAGE }));
    const { response, ctx } = await call(
      `/v2/apps/${appId}/proxy/${slug}/v1/chat/completions?key=client-key&api_key=other&keep=1`,
      chatRequest(key, { model: "gpt-4o-mini" }, { "x-stainless-user": "user-7", "x-stainless-lang": "js" }),
    );
    await response.text();
    await waitOnExecutionContext(ctx);
    const sent = upstreamRequest();
    expect(sent.url).toBe("https://api.openai.com/v1/chat/completions?keep=1");
    expect(sent.headers.get("x-stainless-user")).toBeNull();
    expect(sent.headers.get("x-stainless-lang")).toBe("js");
    expect(sent.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
  });

  it("records a stream the provider broke as a failed attempt, not an ok one (S3)", async () => {
    const { appId, slug, key } = await setup();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [] })}\n\n`));
        controller.error(new Error("provider connection reset"));
      },
    });
    fetchSpy.mockResolvedValue(new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    const { response, ctx } = await call(
      `/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`,
      chatRequest(key, { model: "gpt-4o-mini", stream: true }),
    );
    await response.text().catch(() => undefined);
    await waitOnExecutionContext(ctx);
    expect(await chargesOf(appId)).toMatchObject([
      { status: "network_error", measured: "partial", price_source: "unresolved", cost_nano: null },
    ]);
  });

  it("writes the charge unpriced and logs it when its cost is too large to store (S4)", async () => {
    const { appId, slug, key } = await setup({}, { rates: { "gpt-4o-mini": { input: 9_000_000_000_000_000, output: 1 } } });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchSpy.mockResolvedValue(Response.json({ choices: [], usage: { prompt_tokens: 2_000_000, completion_tokens: 1 } }));
    const { response, ctx } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, chatRequest(key, { model: "gpt-4o-mini" }));
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(await chargesOf(appId)).toMatchObject([{ price_source: "unresolved", cost_nano: null, input_tokens: 2_000_000 }]);
    // The candidate that overflows is skipped and logged; with none left, the charge is unresolved and logged.
    expect(warnings.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("price_candidate_too_large"));
    expect(errors.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("usage_unresolved_cost"));
  });

  it("sends a provider key holding `$&` as it is (S5)", async () => {
    const secret = "sk-$&-$1-key";
    const { appId, slug, key } = await setup({}, { secret });
    fetchSpy.mockResolvedValue(Response.json({ choices: [], usage: USAGE }));
    const { response, ctx } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, chatRequest(key, { model: "gpt-4o-mini" }));
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(upstreamRequest().headers.get("authorization")).toBe(`Bearer ${secret}`);
  });

  it("marks the app key used (S6)", async () => {
    const { appId, slug, key } = await setup();
    fetchSpy.mockResolvedValue(Response.json({ choices: [], usage: USAGE }));
    const { response, ctx } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, chatRequest(key, { model: "gpt-4o-mini" }));
    await response.text();
    await waitOnExecutionContext(ctx);
    const row = await env.DB.prepare("SELECT last_used_at FROM app_key WHERE app_id = ?").bind(appId).first<{ last_used_at: number | null }>();
    expect(row?.last_used_at).toEqual(expect.any(Number));
  });

  it("records a replayed App Attest proof as a rejection event (S7)", async () => {
    const { slug } = await seedConnection();
    const appId = await seedRoutedApp(attestAuthentication(), { providers: { [slug]: { operations: ["openai.chat"] } } });
    const install = await registerTestInstall(appId);
    const token = await tokenForInstall(install);
    fetchSpy.mockResolvedValue(Response.json({ choices: [], usage: USAGE }));
    const url = `${ORIGIN}/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`;
    const body = new TextEncoder().encode(JSON.stringify({ model: "gpt-4o-mini" }));
    const proof = await signedProof({ install, token, method: "POST", url, body, counter: 1 });
    const send = () =>
      call(url.slice(ORIGIN.length), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-app-version": "1.0", "x-appattest-proof": proof },
        body,
      });
    const first = await send();
    expect(first.response.status).toBe(200);
    await first.response.text();
    await waitOnExecutionContext(first.ctx);
    const replay = await send();
    expect(replay.response.status).toBe(403);
    await waitOnExecutionContext(replay.ctx);
    const event = await env.DB.prepare("SELECT reason, scope FROM app_rejection_event WHERE app_id = ?").bind(appId).first();
    expect(event).toEqual({ reason: "blocked_replay", scope: "install" });
  });

  it("keeps a provider's valid error.type when error.code is not a string (S8)", async () => {
    const { appId, slug, key } = await setup();
    fetchSpy.mockResolvedValue(Response.json({ error: { code: 429, type: "rate_limit_error" } }, { status: 429 }));
    const { response, ctx } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, chatRequest(key, { model: "gpt-4o-mini" }));
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(await chargesOf(appId)).toMatchObject([{ error_code: "rate_limit_error" }]);
  });

  it("keeps a top-level error code when `error` is not an object", async () => {
    const { appId, slug, key } = await setup();
    fetchSpy.mockResolvedValue(Response.json({ error: [], code: "rate_limit_error" }, { status: 429 }));
    const { response, ctx } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, chatRequest(key, { model: "gpt-4o-mini" }));
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(await chargesOf(appId)).toMatchObject([{ error_code: "rate_limit_error" }]);
  });
});

describe("second review fixes", () => {
  it("sends a chat body as JSON whatever type the client named (F1)", async () => {
    const { appId, slug, key } = await setup();
    fetchSpy.mockResolvedValue(Response.json({ choices: [], usage: USAGE }));
    const { response, ctx } = await call(
      `/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`,
      chatRequest(key, { model: "gpt-4o-mini" }, { "content-type": "application/x-www-form-urlencoded" }),
    );
    await response.text();
    await waitOnExecutionContext(ctx);
    expect(upstreamRequest().headers.get("content-type")).toBe("application/json");
  });

  it("stores the app version only when it is shaped like a version, with a build number in parentheses, never other caller text (F2, Sol 7b-4 rounds 2 and 3)", async () => {
    const { appId, slug, key } = await setup();
    fetchSpy.mockImplementation(async () => Response.json({ choices: [], usage: USAGE }));
    for (const version of ["v2.0.0-beta.3", "9".repeat(100), "sk-proj-0123456789abcdef", "1.2.3 (45)", "1.0 (12345678901)", "1.0 (key)"]) {
      const { response, ctx } = await call(
        `/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`,
        chatRequest(key, { model: "gpt-4o-mini" }, { "x-app-version": version }),
      );
      expect(response.status, version).toBe(200);
      await response.text();
      await waitOnExecutionContext(ctx);
    }
    const stored = (await chargesOf(appId)).map((row: any) => row.app_version as string | null);
    expect(stored.filter((version) => version !== null).sort()).toEqual(["1.2.3 (45)", "v2.0.0-beta.3"]);
    expect(stored).toHaveLength(6);
  });

  it("records a refused request's provider only when the app has it, never the caller's own text (Sol 7b-4 round 2)", async () => {
    const { appId, key } = await setup();
    const { ctx } = await call(`/v2/apps/${appId}/proxy/sk-live-0123456789/v1/chat/completions`, chatRequest(key, { model: "gpt-4o-mini" }));
    await waitOnExecutionContext(ctx);
    const event = await env.DB.prepare("SELECT provider_slug, reason FROM app_rejection_event WHERE app_id = ?").bind(appId).first();
    expect(event).toEqual({ provider_slug: "unrecognized", reason: "provider_not_configured" });
  });

  it("records a refused request's model only when the gateway knows it, never the caller's own text (F3, Sol 7b-4)", async () => {
    const { appId, slug, key } = await setup({ models: ["gpt-4o-mini"] });
    const models = async () =>
      (await env.DB.prepare("SELECT model FROM app_rejection_event WHERE app_id = ? ORDER BY created_at").bind(appId).all<{ model: string }>()).results.map(
        (row) => row.model,
      );
    // A key put in the model field by mistake is never stored.
    const { ctx } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, chatRequest(key, { model: "sk-proj-not-a-model-0123456789" }));
    await waitOnExecutionContext(ctx);
    expect(await models()).toEqual(["unrecognized"]);
  });

  it("records a refused request's model when it has a price, though the app does not allow it (Sol 7b-4)", async () => {
    const { appId, slug, key } = await setup({ models: ["gpt-4o-mini"] });
    const { ctx } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, chatRequest(key, { model: "gpt-4o" }));
    await waitOnExecutionContext(ctx);
    const event = await env.DB.prepare("SELECT model, account_id FROM app_rejection_event WHERE app_id = ?").bind(appId).first<{ model: string; account_id: string }>();
    expect(event).toEqual({ model: "gpt-4o", account_id: ACCOUNT_ID });
  });

  it("refuses a provider slug that is not valid percent-encoding (F4)", async () => {
    const { appId, key } = await setup();
    const { response } = await call(`/v2/apps/${appId}/proxy/%E0/v1/chat/completions`, chatRequest(key, { model: "gpt-4o-mini" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "path_not_allowed" } });
  });

  it("keeps a provider error the app stopped reading as a failed attempt with no cost (F5)", async () => {
    const { appId, slug, key } = await setup();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":{"type":"server_error",'));
      },
    });
    fetchSpy.mockResolvedValue(new Response(stream, { status: 500, headers: { "content-type": "application/json" } }));
    const { response, ctx } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, chatRequest(key, { model: "gpt-4o-mini" }));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await waitOnExecutionContext(ctx);
    expect(await chargesOf(appId)).toMatchObject([
      { status: "provider_error", http_status: 500, measured: "complete", price_source: "list_rate", cost_nano: null },
    ]);
    expect(errors.mock.calls.map(([line]) => String(line))).not.toContainEqual(expect.stringContaining("usage_unresolved_cost"));
  });

  it("records a stream the app closed right after [DONE] as complete and priced (F6)", async () => {
    const { appId, slug, key } = await setup();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify({ choices: [], usage: USAGE })}\n\ndata: [DONE]\n\n`),
        );
      },
    });
    fetchSpy.mockResolvedValue(new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    const { response, ctx } = await call(
      `/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`,
      chatRequest(key, { model: "gpt-4o-mini", stream: true }),
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await waitOnExecutionContext(ctx);
    expect(await chargesOf(appId)).toMatchObject([{ status: "ok", measured: "complete", cost_nano: await expectedCost() }]);
  });

  it("serves an app whose stored settings hold keys this version does not know (F7)", async () => {
    const { slug } = await seedConnection();
    await seedAccount();
    const appId = `app_future_${crypto.randomUUID().slice(0, 8)}`;
    const config = {
      authentication: { type: "api_key", end_user: { source: "none" } },
      routing: { providers: { [slug]: { operations: ["openai.chat"], future_option: true } } },
      presets: {},
    };
    await env.DB.prepare(
      "INSERT INTO app(id, account_id, name, config_json, revision, status, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', ?, ?)",
    )
      .bind(appId, ACCOUNT_ID, appId, JSON.stringify(config), Date.now(), Date.now())
      .run();
    const { key } = await seedAppKey(appId);
    fetchSpy.mockResolvedValue(Response.json({ choices: [], usage: USAGE }));
    const { response, ctx } = await call(`/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`, chatRequest(key, { model: "gpt-4o-mini" }));
    expect(response.status).toBe(200);
    await response.text();
    await waitOnExecutionContext(ctx);
  });

  it("looks up no provider connection for a slug the app does not list (F10)", async () => {
    const { appId, key } = await setup();
    let lookups = 0;
    const counting = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) => {
            if (query.includes("provider_connection")) lookups += 1;
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    for (const slug of ["not-listed", "constructor"]) {
      const { response } = await call(
        `/v2/apps/${appId}/proxy/${slug}/v1/chat/completions`,
        chatRequest(key, { model: "gpt-4o-mini" }),
        { ...env, DB: counting } as Env,
      );
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ error: { code: "provider_not_configured" } });
    }
    expect(lookups).toBe(0);
  });
});

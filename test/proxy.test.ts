import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { API_STYLES } from "../src/core/api-styles";
import { clearProviderCaches } from "../src/core/provider-store";
import { PROVIDER_REGISTRY, PROVIDER_TYPES } from "../src/core/providers";
import { costReportBodyMutation } from "../src/core/proxyrules";
import type { OutputClampStyle, ProviderType } from "../src/core/types";
import { defaultProxyConfig, gatewayToken, seedApp, seedProvider, seedServerApp } from "./helpers";

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: string;
}

interface OutputCapCase {
  name: string;
  provider: ProviderType;
  allowedPath: string | { path: string; clamp: OutputClampStyle };
  path: string;
  model: string;
  highBody: Record<string, unknown>;
  allowedBody: Record<string, unknown>;
  noCapBody: Record<string, unknown>;
  rejectBody?: Record<string, unknown>;
  expectedInjection: Record<string, unknown>;
  absentAfterInjection?: string[];
}

const OUTPUT_CAP_CASES: OutputCapCase[] = [
  {
    name: "Responses",
    provider: "openai",
    allowedPath: "v1/responses",
    path: "openai/v1/responses",
    model: "gpt-5.6-sol",
    highBody: { model: "gpt-5.6-sol", input: "hello", max_output_tokens: 99_999 },
    allowedBody: { model: "gpt-5.6-sol", input: "hello", max_output_tokens: 128 },
    noCapBody: { model: "gpt-5.6-sol", input: "hello" },
    rejectBody: { model: "gpt-5.6-sol", input: "hello", max_output_tokens: 129 },
    expectedInjection: { max_output_tokens: 128 },
  },
  {
    name: "chat completions",
    provider: "openai",
    allowedPath: "v1/chat/completions",
    path: "openai/v1/chat/completions",
    model: "gpt-5.4-mini",
    highBody: {
      model: "gpt-5.4-mini",
      messages: [],
      max_tokens: 99_998,
      max_completion_tokens: 99_999,
    },
    allowedBody: {
      model: "gpt-5.4-mini",
      messages: [],
      max_tokens: 127,
      max_completion_tokens: 128,
    },
    noCapBody: { model: "gpt-5.4-mini", messages: [] },
    rejectBody: {
      model: "gpt-5.4-mini",
      messages: [],
      max_tokens: 128,
      max_completion_tokens: 129,
    },
    expectedInjection: { max_completion_tokens: 128 },
    absentAfterInjection: ["max_tokens"],
  },
  {
    name: "Anthropic",
    provider: "anthropic",
    allowedPath: "v1/messages",
    path: "anthropic/v1/messages",
    model: "claude-sonnet-5",
    highBody: { model: "claude-sonnet-5", messages: [], max_tokens: 99_999 },
    allowedBody: { model: "claude-sonnet-5", messages: [], max_tokens: 127 },
    noCapBody: { model: "claude-sonnet-5", messages: [] },
    rejectBody: { model: "claude-sonnet-5", messages: [], max_tokens: 129 },
    expectedInjection: { max_tokens: 128 },
  },
  {
    name: "native Gemini",
    provider: "gemini",
    allowedPath: "v1beta/models/{model}:generateContent",
    path: "gemini/v1beta/models/gemini-3.5-flash:generateContent",
    model: "gemini-3.5-flash",
    highBody: { contents: [], generationConfig: { maxOutputTokens: 99_999 } },
    allowedBody: { contents: [], generationConfig: { maxOutputTokens: 128 } },
    noCapBody: { contents: [] },
    rejectBody: { contents: [], generationConfig: { maxOutputTokens: 129 } },
    expectedInjection: { generationConfig: { maxOutputTokens: 128 } },
  },
  {
    name: "none",
    provider: "openai",
    allowedPath: { path: "v1/audio/transcriptions", clamp: "none" },
    path: "openai/v1/audio/transcriptions",
    model: "gpt-4o-mini-transcribe",
    highBody: {
      model: "gpt-4o-mini-transcribe",
      max_output_tokens: 99_999,
      max_tokens: 99_999,
      max_completion_tokens: 99_999,
    },
    allowedBody: {
      model: "gpt-4o-mini-transcribe",
      max_output_tokens: 99_999,
      max_tokens: 99_999,
      max_completion_tokens: 99_999,
    },
    noCapBody: { model: "gpt-4o-mini-transcribe" },
    expectedInjection: {},
    absentAfterInjection: ["max_output_tokens", "max_tokens", "max_completion_tokens"],
  },
];

const CHAT_INJECTION_CASES: OutputCapCase[] = [
  {
    name: "xAI chat completions",
    provider: "xai",
    allowedPath: "v1/chat/completions",
    path: "xai/v1/chat/completions",
    model: "grok-4.5",
    highBody: {},
    allowedBody: {},
    noCapBody: { model: "grok-4.5", messages: [] },
    expectedInjection: { max_tokens: 128 },
    absentAfterInjection: ["max_completion_tokens"],
  },
  {
    name: "Perplexity chat completions",
    provider: "perplexity",
    allowedPath: "chat/completions",
    path: "perplexity/chat/completions",
    model: "sonar-pro",
    highBody: {},
    allowedBody: {},
    noCapBody: { model: "sonar-pro", messages: [] },
    expectedInjection: { max_tokens: 128 },
    absentAfterInjection: ["max_completion_tokens"],
  },
  {
    name: "Gemini OpenAI-compatible chat completions",
    provider: "gemini",
    allowedPath: "v1beta/openai/chat/completions",
    path: "gemini/v1beta/openai/chat/completions",
    model: "gemini-3.5-flash",
    highBody: {},
    allowedBody: {},
    noCapBody: { model: "gemini-3.5-flash", messages: [] },
    expectedInjection: { max_tokens: 128 },
    absentAfterInjection: ["max_completion_tokens"],
  },
];

let pendingExecutionContexts: ExecutionContext[] = [];

/**
 * Waits for the `waitUntil` work of every request made so far, so the usage
 * rows a test is about to read are already written rather than polled for.
 */
async function settleUsage(): Promise<void> {
  const contexts = pendingExecutionContexts;
  pendingExecutionContexts = [];
  await Promise.all(contexts.map((context) => waitOnExecutionContext(context)));
}

/**
 * One request, answered the way a real client would take it: the body is read
 * here and handed back whole. The usage observer rides the client's own stream,
 * so a body nobody reads leaves the pipe — and the `waitUntil` recording behind
 * it — pending. Tests that assert on streaming pass `stream` and read it
 * themselves.
 */
async function workerFetch(
  input: string,
  init: RequestInit,
  bindings: Env = env,
  stream = false,
): Promise<Response> {
  const executionCtx = createExecutionContext();
  const response = await app.fetch(new Request(input, init), bindings, executionCtx);
  pendingExecutionContexts.push(executionCtx);
  return stream ? response : new Response(await response.arrayBuffer(), response);
}

async function proxyRequest(input: {
  appId: string;
  token: string;
  path: string;
  body: Record<string, unknown>;
  tokenHeader?: string;
  env?: Env;
  /** Leave the response body unread, for tests that consume it chunk by chunk. */
  stream?: boolean;
}): Promise<Response> {
  const tokenHeader = input.tokenHeader ?? "authorization";
  return workerFetch(`https://example.test/v1/apps/${input.appId}/proxy/${input.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-app-version": "1.2.3",
      [tokenHeader]: tokenHeader === "authorization" ? `Bearer ${input.token}` : input.token,
    },
    body: JSON.stringify(input.body),
  }, input.env, input.stream);
}

/** The deployment's time-to-first-byte budget, lowered so a hang is testable. */
function withTtfbTimeout(seconds: number): Env {
  return new Proxy(env, {
    get: (target, property, receiver) =>
      property === "PROVIDER_TTFB_TIMEOUT_SECONDS"
        ? String(seconds)
        : Reflect.get(target, property, receiver),
  }) as Env;
}

/** An upstream that accepts the request and answers only by being aborted. */
function hangingUpstream(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("The operation was aborted.", "AbortError"));
    });
  });
}

function outputCapProxyConfig(testCase: OutputCapCase, cap?: number): Record<string, unknown> {
  return {
    [testCase.provider]: {
      allowed_paths: [testCase.allowedPath],
      allowed_models: [testCase.model],
      ...(cap === undefined ? {} : { max_output_tokens: cap }),
    },
    model_rewrites: {},
  };
}

function captureProviderBodies(): string[] {
  const bodies: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    return Response.json({
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        prompt_tokens: 1,
        completion_tokens: 1,
      },
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
  });
  return bodies;
}

async function rawProxyRequest(
  testCase: OutputCapCase,
  appId: string,
  token: string,
  body: string,
): Promise<Response> {
  return workerFetch(`https://example.test/v1/apps/${appId}/proxy/${testCase.path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-app-version": "1.2.3",
    },
    body,
  });
}

afterEach(async () => {
  await Promise.all(pendingExecutionContexts.map((context) => waitOnExecutionContext(context)));
  pendingExecutionContexts = [];
  vi.restoreAllMocks();
});

describe("provider-native proxy", () => {
  it.each([
    ["an empty legacy config", { model_rewrites: {} }],
    ["explicit all mode", { provider_mode: "all", model_rewrites: {} }],
  ])("allows every provider and path with a priced model in %s", async (_label, proxy) => {
    const appId = `proxy-all-${crypto.randomUUID()}`;
    await seedApp(appId, { proxy });
    const token = await gatewayToken(appId);
    const captured: CapturedRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      captured.push({
        url: typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
    });

    const response = await proxyRequest({
      appId,
      token,
      path: "perplexity/chat/completions",
      body: { model: "sonar-pro", messages: [] },
    });

    expect(response.status).toBe(200);
    expect(captured[0]?.url).toBe("https://api.perplexity.ai/chat/completions");
  });

  it("allows individual mode to disable every provider", async () => {
    const appId = "proxy-selected-none";
    await seedApp(appId, {
      proxy: { provider_mode: "selected", model_rewrites: {} },
    });
    const token = await gatewayToken(appId);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await proxyRequest({
      appId,
      token,
      path: "openai/v1/responses",
      body: { model: "gpt-5.6-sol", input: "hello" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "path_not_allowed", message: "Provider is disabled for this app" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    {
      provider: "openai",
      path: "openai/v1/responses",
      body: { model: "gpt-5.6-sol", input: "hello" },
    },
    {
      provider: "anthropic",
      path: "anthropic/v1/messages",
      body: { model: "claude-sonnet-5", messages: [], max_tokens: 32 },
    },
    {
      provider: "xai",
      path: "xai/v1/responses",
      body: { model: "grok-4.5", input: "hello" },
    },
    {
      provider: "gemini",
      path: "gemini/v1beta/models/gemini-3.5-flash:generateContent",
      body: { contents: [] },
    },
    {
      provider: "perplexity",
      path: "perplexity/chat/completions",
      body: { model: "sonar", messages: [] },
    },
  ])("forwards upstream Retry-After for $provider", async (testCase) => {
    const appId = `proxy-retry-after-${testCase.provider}`;
    const proxy = defaultProxyConfig();
    proxy.perplexity = {
      allowed_paths: ["chat/completions"],
      allowed_models: ["sonar"],
      max_output_tokens: 128,
    };
    await seedApp(appId, { proxy });
    const token = await gatewayToken(appId);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json(
        { error: { message: "Provider rate limit exceeded" } },
        { status: 429, headers: { "retry-after": "47" } },
      ),
    );

    const response = await proxyRequest({
      appId,
      token,
      path: testCase.path,
      body: testCase.body,
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("47");
  });

  it("streams the upstream response byte-for-byte without waiting for completion", async () => {
    await seedApp("proxy-stream");
    const token = await gatewayToken("proxy-stream");
    const first = "event: response.output_text.delta\ndata: {\"delta\":\"hi\"}\n\n";
    const second = "event: response.completed\ndata: {\"response\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":2}}}\n\n";
    let secondSent = false;
    const captured: CapturedRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      captured.push({
        url: typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : "",
      });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(first));
          setTimeout(() => {
            secondSent = true;
            controller.enqueue(new TextEncoder().encode(second));
            controller.close();
          }, 40);
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    });

    const response = await proxyRequest({
      appId: "proxy-stream",
      token,
      path: "openai/v1/responses",
      body: { model: "gpt-5.6-sol", max_output_tokens: 128, input: "hello" },
      stream: true,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("server-timing")).toContain("provider_ttfb");
    const reader = response.body!.getReader();
    const firstChunk = await reader.read();
    expect(new TextDecoder().decode(firstChunk.value)).toBe(first);
    expect(secondSent).toBe(false);
    const secondChunk = await reader.read();
    expect(new TextDecoder().decode(secondChunk.value)).toBe(second);
    expect((await reader.read()).done).toBe(true);
    expect(captured[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(captured[0]?.headers.get("authorization")).toBe("Bearer test-openai-secret");
    expect(captured[0]?.headers.get("cf-aig-authorization")).toBeNull();
    expect(captured[0]?.headers.get("cf-aig-metadata")).toBeNull();
    expect(JSON.parse(captured[0]!.body)).toMatchObject({ model: "gpt-5.6-sol", max_output_tokens: 128 });
  });

  /**
   * The whole point of piping instead of teeing: the client's read is what
   * pulls the provider, so hanging up stops the generation being paid for.
   */
  it("cancels the upstream and prices the partial usage when the client disconnects mid-stream", async () => {
    const appId = "proxy-client-abort-anthropic";
    await seedApp(appId);
    const token = await gatewayToken(appId);
    const start = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":300,\"output_tokens\":1}}}\n\n";
    const upstreamCancelled = vi.fn();
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(start));
          },
          // Nothing more arrives on its own: the stream ends only by being
          // cancelled, exactly as a half-generated answer would.
          cancel: upstreamCancelled,
        }),
        { headers: { "content-type": "text/event-stream" } },
      ));

    const response = await proxyRequest({
      appId,
      token,
      path: "anthropic/v1/messages",
      body: { model: "claude-sonnet-5", max_tokens: 64, messages: [] },
      stream: true,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(start);
    await reader.cancel();

    await settleUsage();
    expect(upstreamCancelled).toHaveBeenCalledTimes(1);
    const row = await env.DB.prepare(
      `SELECT status, client_aborted, input_tokens, output_tokens, cost_source, cost_usd
         FROM app_usage_event WHERE app_id = ?`,
    )
      .bind(appId)
      .first<{
        status: string;
        client_aborted: number | null;
        input_tokens: number;
        output_tokens: number;
        cost_source: string | null;
        cost_usd: number;
      }>();
    // Anthropic reports the input tokens in `message_start`, so an abort still
    // bills what the prompt cost; the status stays `ok` because the client was
    // served everything it stayed for.
    expect(row).toMatchObject({
      status: "ok",
      client_aborted: 1,
      input_tokens: 300,
      cost_source: "computed",
    });
    expect(row!.cost_usd).toBeGreaterThan(0);
    const recorded = logs.mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .find((entry) => entry.message === "usage_recorded" && entry.appId === appId);
    expect(recorded).toMatchObject({ aborted: true, status: "ok" });
  });

  it("records an aborted OpenAI stream as unresolved and names the client as the reason", async () => {
    const appId = "proxy-client-abort-openai";
    await seedApp(appId);
    const token = await gatewayToken(appId);
    const delta = "event: response.output_text.delta\ndata: {\"delta\":\"hi\"}\n\n";
    const upstreamCancelled = vi.fn();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(delta));
          },
          cancel: upstreamCancelled,
        }),
        { headers: { "content-type": "text/event-stream" } },
      ));

    const response = await proxyRequest({
      appId,
      token,
      path: "openai/v1/responses",
      body: { model: "gpt-5.6-sol", input: "hello" },
      stream: true,
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(delta);
    await reader.cancel();

    await settleUsage();
    expect(upstreamCancelled).toHaveBeenCalledTimes(1);
    const row = await env.DB.prepare(
      "SELECT status, client_aborted, cost_source, cost_usd FROM app_usage_event WHERE app_id = ?",
    )
      .bind(appId)
      .first<{ status: string; client_aborted: number | null; cost_source: string | null; cost_usd: number }>();
    // OpenAI only sends usage in the final event, which the client never
    // waited for: the honest answer is that the cost is unknown.
    expect(row).toEqual({ status: "ok", client_aborted: 1, cost_source: "unresolved", cost_usd: 0 });
    const unresolved = errors.mock.calls
      .map((call) => JSON.parse(String(call[0])))
      .find((entry) => entry.message === "usage_unresolved_cost" && entry.appId === appId);
    expect(unresolved).toMatchObject({ reason: "client_aborted", model: "gpt-5.6-sol" });
  });

  it("rejects paths and models outside the tenant allowlists", async () => {
    await seedApp("proxy-deny");
    const token = await gatewayToken("proxy-deny");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const deniedPath = await proxyRequest({
      appId: "proxy-deny",
      token,
      path: "openai/v1/files",
      body: { model: "gpt-5.6-sol" },
    });
    expect(deniedPath.status).toBe(403);
    expect(deniedPath.headers.get("server-timing")).toMatch(/auth.*limiter.*provider_ttfb/u);
    await expect(deniedPath.json()).resolves.toMatchObject({ error: { code: "path_not_allowed" } });
    const deniedModel = await proxyRequest({
      appId: "proxy-deny",
      token,
      path: "openai/v1/responses",
      body: { model: "not-allowed" },
    });
    expect(deniedModel.status).toBe(403);
    await expect(deniedModel.json()).resolves.toMatchObject({ error: { code: "model_not_allowed" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires the native OpenAI v1 path instead of a gateway-adapted path", async () => {
    await seedApp("proxy-native-path");
    const token = await gatewayToken("proxy-native-path");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await proxyRequest({
      appId: "proxy-native-path",
      token,
      path: "openai/responses",
      body: { model: "gpt-5.6-sol", input: "hello" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "path_not_allowed" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["omitted", undefined],
    ["empty", []],
  ])("requires pricing even when allowed_models is %s", async (suffix, allowedModels) => {
    const appId = `proxy-models-${suffix}`;
    const openai: Record<string, unknown> = {
      allowed_paths: ["v1/responses"],
      max_output_tokens: 128,
    };
    if (allowedModels !== undefined) openai.allowed_models = allowedModels;
    await seedApp(appId, { proxy: { openai, model_rewrites: {} } });
    const token = await gatewayToken(appId);
    const captured: CapturedRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      captured.push({
        url: typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return Response.json({ usage: { input_tokens: 1, output_tokens: 1 } });
    });

    const response = await proxyRequest({
      appId,
      token,
      path: "openai/v1/responses",
      body: { model: "provider-model-released-today", input: "hello" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "pricing_not_configured" },
    });
    expect(captured).toHaveLength(0);
  });

  it.each([
    ["omitted", undefined],
    ["empty", []],
  ])("allows every path when allowed_paths is %s", async (suffix, allowedPaths) => {
    const appId = `proxy-paths-${suffix}`;
    const openai: Record<string, unknown> = {
      allowed_models: [],
      max_output_tokens: 128,
    };
    if (allowedPaths !== undefined) openai.allowed_paths = allowedPaths;
    await seedApp(appId, { proxy: { openai, model_rewrites: {} } });
    const token = await gatewayToken(appId);
    const captured: CapturedRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      captured.push({
        url: typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
    });

    const response = await proxyRequest({
      appId,
      token,
      path: "openai/v1/chat/completions",
      body: { model: "gpt-5.6-sol", messages: [] },
    });

    expect(response.status).toBe(200);
    expect(captured[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it.each([
    ["omitted", undefined],
    ["empty", []],
  ])("resolves native Gemini URL models when allowed_paths is %s", async (suffix, allowedPaths) => {
    const appId = `proxy-gemini-paths-${suffix}`;
    const gemini: Record<string, unknown> = {
      allowed_models: [],
      max_output_tokens: 128,
    };
    if (allowedPaths !== undefined) gemini.allowed_paths = allowedPaths;
    await seedApp(appId, {
      proxy: {
        gemini,
        model_rewrites: { "gemini-3.5-flash": "gemini-3.6-flash" },
      },
    });
    const token = await gatewayToken(appId);
    const captured: CapturedRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      captured.push({
        url: typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return Response.json({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    });

    const response = await proxyRequest({
      appId,
      token,
      path: "gemini/v1beta/models/gemini-3.5-flash:generateContent",
      body: { contents: [] },
    });

    expect(response.status).toBe(200);
    expect(captured[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
    );
    expect(JSON.parse(captured[0]!.body)).toMatchObject({
      generationConfig: { maxOutputTokens: 128 },
    });
  });

  describe("output-cap policy", () => {
    it.each(OUTPUT_CAP_CASES)(
      "forwards $name JSON byte-for-byte with no validation or injection when the cap is unset",
      async (testCase) => {
        const appId = `cap-unset-${testCase.name.replaceAll(" ", "-").toLowerCase()}`;
        await seedApp(appId, { proxy: outputCapProxyConfig(testCase) });
        const token = await gatewayToken(appId);
        const bodies = captureProviderBodies();
        const rawBody = `${JSON.stringify(testCase.highBody, null, 2)}\n`;

        const response = await rawProxyRequest(testCase, appId, token, rawBody);
        await response.text();

        expect(response.status).toBe(200);
        expect(bodies).toEqual([rawBody]);
      },
    );

    it.each(OUTPUT_CAP_CASES)(
      "forwards equal/lower $name limits byte-for-byte when the cap is set",
      async (testCase) => {
        const appId = `cap-allowed-${testCase.name.replaceAll(" ", "-").toLowerCase()}`;
        await seedApp(appId, { proxy: outputCapProxyConfig(testCase, 128) });
        const token = await gatewayToken(appId);
        const bodies = captureProviderBodies();
        const rawBody = `${JSON.stringify(testCase.allowedBody, null, 2)}\n`;

        const response = await rawProxyRequest(testCase, appId, token, rawBody);
        await response.text();

        expect(response.status).toBe(200);
        expect(bodies).toEqual([rawBody]);
      },
    );

    it.each(OUTPUT_CAP_CASES.filter((testCase) => testCase.rejectBody !== undefined))(
      "rejects over-cap $name limits before the provider call",
      async (testCase) => {
        const appId = `cap-reject-${testCase.name.replaceAll(" ", "-").toLowerCase()}`;
        await seedApp(appId, { proxy: outputCapProxyConfig(testCase, 128) });
        const token = await gatewayToken(appId);
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        const response = await proxyRequest({
          appId,
          token,
          path: testCase.path,
          body: testCase.rejectBody!,
        });

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({
          error: {
            code: "max_output_tokens_exceeded",
            message: expect.stringContaining("128"),
          },
        });
        expect(fetchSpy).not.toHaveBeenCalled();
        const usage = await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM app_usage_event WHERE app_id = ?",
        )
          .bind(appId)
          .first<{ count: number }>();
        expect(usage?.count).toBe(0);
      },
    );

    it.each([...OUTPUT_CAP_CASES, ...CHAT_INJECTION_CASES])(
      "injects the provider-correct $name field when the cap is set and absent",
      async (testCase) => {
        const appId = `cap-inject-${testCase.name.replaceAll(" ", "-").toLowerCase()}`;
        await seedApp(appId, { proxy: outputCapProxyConfig(testCase, 128) });
        const token = await gatewayToken(appId);
        const bodies = captureProviderBodies();

        const response = await proxyRequest({
          appId,
          token,
          path: testCase.path,
          body: testCase.noCapBody,
        });
        await response.text();

        expect(response.status).toBe(200);
        expect(bodies).toHaveLength(1);
        const upstreamBody = JSON.parse(bodies[0]!) as Record<string, unknown>;
        expect(upstreamBody).toMatchObject(testCase.expectedInjection);
        for (const field of testCase.absentAfterInjection ?? []) {
          expect(upstreamBody).not.toHaveProperty(field);
        }
      },
    );
  });

  it("rewrites body and Gemini URL models only after allowlist validation", async () => {
    await seedApp("proxy-rewrite");
    const token = await gatewayToken("proxy-rewrite");
    const captured: CapturedRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      captured.push({
        url: typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return Response.json({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    });
    const openAi = await proxyRequest({
      appId: "proxy-rewrite",
      token,
      path: "openai/v1/responses",
      body: { model: "gpt-5.6-terra", max_output_tokens: 100 },
    });
    await openAi.text();
    expect(JSON.parse(captured[0]!.body)).toMatchObject({ model: "gpt-5.6", max_output_tokens: 100 });

    const gemini = await proxyRequest({
      appId: "proxy-rewrite",
      token,
      path: "gemini/v1beta/models/gemini-3.5-flash:generateContent?alt=sse&key=must-not-leak",
      body: { contents: [], generationConfig: { maxOutputTokens: 100 } },
    });
    await gemini.text();
    expect(captured[1]?.url).toContain(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
    );
    expect(captured[1]?.url).toContain("alt=sse");
    expect(captured[1]?.url).not.toContain("must-not-leak");
    expect(JSON.parse(captured[1]!.body)).toMatchObject({
      generationConfig: { maxOutputTokens: 100 },
    });

    await settleUsage();
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM app_usage_event WHERE app_id = ? AND model = ?",
    )
      .bind("proxy-rewrite", "gemini-3.6-flash")
      .first<{ count: number }>();
    expect(row?.count).toBe(1);
  });

  it("rebuilds a rewritten Gemini path", async () => {
    const proxy = defaultProxyConfig();
    proxy.gemini = {
      allowed_paths: ["v1beta/models/{model}:generateContent"],
      allowed_models: ["gemini-3.5-flash"],
      max_output_tokens: 128,
    };
    proxy.model_rewrites = { "gemini-3.5-flash": "gemini-3.6-flash" };
    await seedApp("proxy-gemini-encoding", { proxy });
    const token = await gatewayToken("proxy-gemini-encoding");
    let upstreamUrl = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
      upstreamUrl = typeof request === "string"
        ? request
        : request instanceof URL
          ? request.toString()
          : request.url;
      return Response.json({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
    });

    const response = await proxyRequest({
      appId: "proxy-gemini-encoding",
      token,
      path: "gemini/v1beta/models/gemini-3.5-flash:generateContent",
      body: { contents: [] },
    });
    await response.text();

    expect(response.status).toBe(200);
    expect(upstreamUrl).toContain(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
    );
  });

  it("uses the body model and chat-completions cap policy for Gemini OpenAI-compatible requests", async () => {
    await seedApp("proxy-gemini-openai");
    const token = await gatewayToken("proxy-gemini-openai");
    let upstreamUrl = "";
    let upstreamBody: Record<string, unknown> = {};
    const fixture = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}`,
      `data: ${JSON.stringify({ usage: { prompt_tokens: 11, completion_tokens: 4 } })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      upstreamUrl = typeof request === "string"
        ? request
        : request instanceof URL
          ? request.toString()
          : request.url;
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(fixture, { headers: { "content-type": "text/event-stream" } });
    });

    const response = await proxyRequest({
      appId: "proxy-gemini-openai",
      token,
      path: "gemini/v1beta/openai/chat/completions",
      body: {
        model: "gemini-3.5-flash",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 100,
        stream: true,
        stream_options: { include_usage: true },
      },
    });

    await expect(response.text()).resolves.toBe(fixture);
    expect(upstreamUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
    expect(upstreamBody).toMatchObject({
      model: "gemini-3.6-flash",
      max_tokens: 100,
      stream_options: { include_usage: true },
    });
    expect(upstreamBody).not.toHaveProperty("generationConfig");
    expect(upstreamBody).not.toHaveProperty("max_output_tokens");
  });

  it("accepts an Anthropic SDK token in x-api-key and strips it upstream", async () => {
    await seedApp("proxy-native-header");
    const token = await gatewayToken("proxy-native-header");
    let upstreamHeaders = new Headers();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      upstreamHeaders = new Headers(init?.headers);
      return Response.json({ usage: { input_tokens: 1, output_tokens: 1 } });
    });
    const response = await proxyRequest({
      appId: "proxy-native-header",
      token,
      path: "anthropic/v1/messages",
      tokenHeader: "x-api-key",
      body: { model: "claude-sonnet-5", max_tokens: 100, messages: [] },
    });
    await response.text();
    expect(response.status).toBe(200);
    // The client's own key is stripped and replaced with the organization's.
    expect(upstreamHeaders.get("x-api-key")).toBe("test-anthropic-secret");
    expect(upstreamHeaders.get("authorization")).toBeNull();
    expect(upstreamHeaders.get("cf-aig-authorization")).toBeNull();
  });

  it("accepts a tenant-configured token header and strips it upstream", async () => {
    await seedApp("proxy-custom-header", {
      auth: {
        jwks_url: "https://issuer.test/.well-known/jwks.json",
        token_header: "x-tenant-token",
      },
    });
    const token = await gatewayToken("proxy-custom-header");
    let upstreamHeaders = new Headers();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      upstreamHeaders = new Headers(init?.headers);
      return Response.json({ usage: { input_tokens: 1, output_tokens: 1 } });
    });
    const response = await proxyRequest({
      appId: "proxy-custom-header",
      token,
      path: "openai/v1/responses",
      tokenHeader: "x-tenant-token",
      body: { model: "gpt-5.6-sol", input: "hello" },
    });
    await response.text();
    expect(response.status).toBe(200);
    expect(upstreamHeaders.get("x-tenant-token")).toBeNull();
  });

  it("forwards only allowlisted client headers to the provider", async () => {
    await seedApp("proxy-header-allowlist");
    const token = await gatewayToken("proxy-header-allowlist");
    let upstreamHeaders = new Headers();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      upstreamHeaders = new Headers(init?.headers);
      return Response.json({ usage: { input_tokens: 1, output_tokens: 1 } });
    });

    const response = await workerFetch(
      "https://example.test/v1/apps/proxy-header-allowlist/proxy/openai/v1/responses",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-app-version": "1.2.3",
          // Nothing below is the provider's business: the first group would
          // disclose the end user, the second would redirect the operator's
          // spend, the third is the gateway's own protocol.
          cookie: "session=end-user-secret",
          "cf-connecting-ip": "203.0.113.7",
          "x-forwarded-for": "203.0.113.7",
          "cf-ipcountry": "UA",
          "cf-ray": "8f0000000000abcd-FRA",
          origin: "https://app.test",
          referer: "https://app.test/chat",
          "openai-organization": "org-somebody-else",
          "openai-project": "proj-somebody-else",
          "x-goog-user-project": "billing-victim",
          "accept-encoding": "gzip",
          // Everything below is what a provider SDK legitimately sends.
          accept: "text/event-stream",
          "accept-language": "en-GB",
          "user-agent": "OpenAI/JS 4.104.0",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "output-128k-2025-02-19",
          "openai-beta": "assistants=v2",
          "x-goog-api-client": "google-genai-sdk/1.0.0",
          "idempotency-key": "stainless-retry-1",
          "x-stainless-lang": "js",
        },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
      },
    );
    await response.text();

    expect(response.status).toBe(200);
    for (const name of [
      "cookie",
      "cf-connecting-ip",
      "x-forwarded-for",
      "cf-ipcountry",
      "cf-ray",
      "origin",
      "referer",
      "openai-organization",
      "openai-project",
      "x-goog-user-project",
      "accept-encoding",
      "x-app-version",
    ]) {
      expect(upstreamHeaders.get(name)).toBeNull();
    }
    expect(upstreamHeaders.get("content-type")).toBe("application/json");
    expect(upstreamHeaders.get("accept")).toBe("text/event-stream");
    expect(upstreamHeaders.get("accept-language")).toBe("en-GB");
    expect(upstreamHeaders.get("user-agent")).toBe("OpenAI/JS 4.104.0");
    expect(upstreamHeaders.get("anthropic-version")).toBe("2023-06-01");
    expect(upstreamHeaders.get("anthropic-beta")).toBe("output-128k-2025-02-19");
    expect(upstreamHeaders.get("openai-beta")).toBe("assistants=v2");
    expect(upstreamHeaders.get("x-goog-api-client")).toBe("google-genai-sdk/1.0.0");
    expect(upstreamHeaders.get("idempotency-key")).toBe("stainless-retry-1");
    expect(upstreamHeaders.get("x-stainless-lang")).toBe("js");
  });

  it("still forwards a gateway control header on a cf_aig row", async () => {
    const appId = "proxy-aig-control-header";
    await seedApp(appId, { proxy: { provider_mode: "all", model_rewrites: {} } });
    await seedProvider({
      type: "openai",
      id: "proxy-aig-control-openai",
      slug: "openai-aig",
      gateway: "cf_aig",
      providerGatewayId: "proxy-aig-control-gateway",
    });
    const token = await gatewayToken(appId);
    let upstreamHeaders = new Headers();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      upstreamHeaders = new Headers(init?.headers);
      return Response.json({ usage: { input_tokens: 1, output_tokens: 1 } });
    });

    const response = await workerFetch(
      `https://example.test/v1/apps/${appId}/proxy/openai-aig/v1/responses`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-app-version": "1.2.3",
          "cf-aig-cache-ttl": "600",
          cookie: "session=end-user-secret",
        },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
      },
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(upstreamHeaders.get("cf-aig-cache-ttl")).toBe("600");
    expect(upstreamHeaders.get("cookie")).toBeNull();

    await env.DB.prepare("DELETE FROM provider WHERE id = 'proxy-aig-control-openai'").run();
    clearProviderCaches();
  });

  it("strips provider account headers from the client response", async () => {
    await seedApp("proxy-response-headers");
    const token = await gatewayToken("proxy-response-headers");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }), {
        headers: {
          "content-type": "application/json",
          "set-cookie": "provider_session=upstream-secret; Path=/",
          "openai-organization": "org-operator",
          "openai-project": "proj-operator",
          "x-request-id": "req_abc123",
        },
      }),
    );

    const response = await proxyRequest({
      appId: "proxy-response-headers",
      token,
      path: "openai/v1/responses",
      body: { model: "gpt-5.6-sol", input: "hello" },
    });
    await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("openai-organization")).toBeNull();
    expect(response.headers.get("openai-project")).toBeNull();
    // Kept on purpose: it is what a provider support ticket asks for.
    expect(response.headers.get("x-request-id")).toBe("req_abc123");
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("forwards multipart transcription with only the model field rewritten", async () => {
    await seedApp("proxy-multipart", {
      proxy: {
        ...defaultProxyConfig(),
        model_rewrites: { "gpt-4o-mini-transcribe": "gpt-4o-transcribe" },
      },
    });
    const token = await gatewayToken("proxy-multipart");
    let upstreamBody: FormData | null = null;
    let upstreamHeaders = new Headers();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      upstreamHeaders = new Headers(init?.headers);
      if (init?.body instanceof FormData) upstreamBody = init.body;
      return Response.json({ text: "hello", usage: { input_tokens: 2, output_tokens: 1 } });
    });
    const form = new FormData();
    form.set("model", "gpt-4o-mini-transcribe");
    form.set("language", "en");
    form.set("file", new File([new Uint8Array([1, 2, 3])], "sample.m4a", { type: "audio/mp4" }));
    const response = await workerFetch(
      "https://example.test/v1/apps/proxy-multipart/proxy/openai/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-app-version": "1.2.3" },
        body: form,
      },
    );
    await response.text();
    expect(response.status).toBe(200);
    expect(upstreamBody).not.toBeNull();
    expect(upstreamBody!.get("model")).toBe("gpt-4o-transcribe");
    expect(upstreamBody!.get("language")).toBe("en");
    expect((upstreamBody!.get("file") as File).size).toBe(3);
    expect(upstreamHeaders.get("content-type")).toBeNull();
  });

  it("forwards fixed-model xAI STT multipart bytes unchanged and records the policy model", async () => {
    await seedApp("proxy-xai-stt");
    const token = await gatewayToken("proxy-xai-stt");
    const boundary = "calorie-tracker-test-boundary";
    const requestBytes = new TextEncoder().encode(
      `--${boundary}\r\n`
      + "Content-Disposition: form-data; name=\"file\"; filename=\"voice.wav\"\r\n"
      + "Content-Type: audio/wav\r\n\r\n"
      + "test-audio-bytes\r\n"
      + `--${boundary}--\r\n`,
    );
    let upstreamBytes = new Uint8Array();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      if (init?.body instanceof ArrayBuffer) upstreamBytes = new Uint8Array(init.body);
      return Response.json({ text: "hello", duration: 1.25 });
    });

    const response = await workerFetch(
      "https://example.test/v1/apps/proxy-xai-stt/proxy/xai/v1/stt",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "x-app-version": "1.2.3",
        },
        body: requestBytes,
      },
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(upstreamBytes).toEqual(requestBytes);
    await settleUsage();
    const row = await env.DB.prepare(
      "SELECT model, cost_usd, auth_method FROM app_usage_event WHERE app_id = ? ORDER BY id DESC LIMIT 1",
    )
      .bind("proxy-xai-stt")
      .first<{ model: string; cost_usd: number; auth_method: string | null }>();
    expect(row?.model).toBe("grok-transcribe");
    expect(row?.cost_usd).toBeCloseTo((1.25 / 3600) * 0.1, 8);
    expect(row?.auth_method).toBe("attest");
  });

  it("rejects bodies larger than 20 MB before contacting the provider", async () => {
    await seedApp("proxy-size");
    const token = await gatewayToken("proxy-size");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await workerFetch(
      "https://example.test/v1/apps/proxy-size/proxy/openai/v1/responses",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": String(20 * 1024 * 1024 + 1),
          "x-app-version": "1",
        },
        body: JSON.stringify({ model: "gpt-5.6-sol" }),
      },
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "payload_too_large" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns a malformed provider body unchanged when background usage extraction fails", async () => {
    await seedApp("proxy-malformed-usage");
    const token = await gatewayToken("proxy-malformed-usage");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("not-usage-json", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": "999",
          "content-encoding": "gzip",
          "transfer-encoding": "chunked",
          "x-provider-header": "preserved",
        },
      }),
    );
    const response = await proxyRequest({
      appId: "proxy-malformed-usage",
      token,
      path: "openai/v1/responses",
      body: { model: "gpt-5.6-sol", input: "hello" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-provider-header")).toBe("preserved");
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("transfer-encoding")).toBeNull();
    await expect(response.text()).resolves.toBe("not-usage-json");
  });

  it("proxies Perplexity for an API-key tenant without app version and hardens cf-aig headers", async () => {
    const key = await seedServerApp("proxy-perplexity", {
      proxy: {
        ...defaultProxyConfig(),
        perplexity: {
          allowed_paths: [{ path: "chat/completions", clamp: "chat_completions" }],
          allowed_models: ["sonar-pro"],
          max_output_tokens: 256,
        },
      },
    });
    let upstreamUrl = "";
    let upstreamHeaders = new Headers();
    let upstreamBody: Record<string, unknown> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      upstreamUrl = typeof request === "string"
        ? request
        : request instanceof URL
          ? request.toString()
          : request.url;
      upstreamHeaders = new Headers(init?.headers);
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        id: "recorded-perplexity-shape",
        model: "sonar-pro",
        choices: [{ message: { role: "assistant", content: "answer" } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      });
    });

    const response = await workerFetch(
      "https://example.test/v1/apps/proxy-perplexity/proxy/perplexity/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "x-end-user-id": "grower-user-7",
          "cf-aig-metadata": "{\"tenant\":\"geo-grower\"}",
          "cf-aig-cache-ttl": "600",
          "cf-aig-authorization": "Bearer attacker-value",
          "cf-aig-unknown-control": "must-strip",
        },
        body: JSON.stringify({
          model: "sonar-pro",
          messages: [{ role: "user", content: "Where should I plant?" }],
        }),
      },
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(upstreamUrl).toBe("https://api.perplexity.ai/chat/completions");
    expect(upstreamHeaders.get("authorization")).toBe("Bearer test-perplexity-secret");
    expect(upstreamHeaders.get("x-end-user-id")).toBeNull();
    // Nothing in front of a natively routed provider speaks cf-aig-*, so none
    // of it is forwarded — including the headers a client may legitimately send
    // when the same provider is routed through a Cloudflare AI Gateway.
    expect(upstreamHeaders.get("cf-aig-authorization")).toBeNull();
    expect(upstreamHeaders.get("cf-aig-metadata")).toBeNull();
    expect(upstreamHeaders.get("cf-aig-cache-ttl")).toBeNull();
    expect(upstreamHeaders.get("cf-aig-unknown-control")).toBeNull();
    expect(upstreamBody).toMatchObject({ model: "sonar-pro", max_tokens: 256 });

    await settleUsage();
    const row = await env.DB.prepare(
      `SELECT user_id, api_key_id, input_tokens, output_tokens, cost_usd, app_version, auth_method
         FROM app_usage_event WHERE app_id = ? ORDER BY id DESC LIMIT 1`,
    )
      .bind("proxy-perplexity")
      .first<{
        user_id: string;
        api_key_id: string | null;
        input_tokens: number;
        output_tokens: number;
        cost_usd: number;
        app_version: string | null;
        auth_method: string | null;
      }>();
    expect(row).toEqual({
      user_id: "grower-user-7",
      api_key_id: "key_proxy-perplexity",
      input_tokens: 100,
      output_tokens: 20,
      cost_usd: 0.0006,
      app_version: null,
      auth_method: "api_key",
    });
    const keyRow = await env.DB.prepare("SELECT last_used_at FROM app_api_key WHERE app_id = ?")
      .bind("proxy-perplexity")
      .first<{ last_used_at: string | null }>();
    expect(keyRow?.last_used_at).not.toBeNull();
  });

  // A provider that accepts the connection and then says nothing used to hold
  // the request open until the client gave up. The budget is on the headers
  // only, so it costs a stream nothing.
  it("answers 504 and records a provider error when the upstream sends no headers in time", async () => {
    const appId = "proxy-ttfb-timeout";
    await seedApp(appId);
    const token = await gatewayToken(appId);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => hangingUpstream(init));

    const started = Date.now();
    const response = await proxyRequest({
      appId,
      token,
      path: "openai/v1/responses",
      body: { model: "gpt-5.6-sol", input: "hello" },
      env: withTtfbTimeout(0.05),
    });

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      error: { code: "provider_error", message: "Provider did not respond in time" },
    });
    expect(Date.now() - started).toBeLessThan(5_000);

    await settleUsage();
    const row = await env.DB.prepare(
      "SELECT status, latency_ms FROM app_usage_event WHERE app_id = ?",
    )
      .bind(appId)
      .first<{ status: string; latency_ms: number | null }>();
    expect(row).toEqual({ status: "provider_error", latency_ms: 50 });
  });

  // The timer is cleared the moment the headers land, so a model that thinks
  // for longer than the budget between chunks is never cut off.
  it("does not cut off a body that finishes after the time-to-first-byte budget", async () => {
    const appId = "proxy-ttfb-slow-body";
    await seedApp(appId);
    const token = await gatewayToken(appId);
    const payload = JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            // Ten times the budget below: a whole-request timeout would abort here.
            await new Promise((resolve) => setTimeout(resolve, 500));
            controller.enqueue(new TextEncoder().encode(payload));
            controller.close();
          },
        }),
        { headers: { "content-type": "application/json" } },
      ));

    const response = await proxyRequest({
      appId,
      token,
      path: "openai/v1/responses",
      body: { model: "gpt-5.6-sol", input: "hello" },
      env: withTtfbTimeout(0.05),
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(payload);
  });
});

/**
 * One end-to-end pass over the OpenAI-compatible batch. The three things that
 * differ per provider — where the base URL ends, where the cache hit is
 * reported, and what the catalog charges for it — are exactly the three the
 * unit tests cannot prove together.
 */
describe("OpenAI-compatible providers", () => {
  it("proxies DeepSeek at its own prefix-free path and bills the cache hit at the cached rate", async () => {
    const key = await seedServerApp("proxy-deepseek", {
      proxy: {
        ...defaultProxyConfig(),
        deepseek: {
          allowed_paths: ["chat/completions"],
          allowed_models: ["deepseek-v4-pro"],
          max_output_tokens: 256,
        },
      },
    });
    let upstreamUrl = "";
    let upstreamHeaders = new Headers();
    let upstreamBody: Record<string, unknown> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      upstreamUrl = typeof request === "string"
        ? request
        : request instanceof URL
          ? request.toString()
          : request.url;
      upstreamHeaders = new Headers(init?.headers);
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        id: "recorded-deepseek-shape",
        model: "deepseek-v4-pro",
        choices: [{ message: { role: "assistant", content: "answer" } }],
        usage: {
          prompt_tokens: 1_000_000,
          prompt_cache_hit_tokens: 1_000_000,
          prompt_cache_miss_tokens: 0,
          completion_tokens: 0,
          total_tokens: 1_000_000,
        },
      });
    });

    const response = await workerFetch(
      "https://example.test/v1/apps/proxy-deepseek/proxy/deepseek/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "x-end-user-id": "deepseek-user-1",
        },
        body: JSON.stringify({
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: "hello" }],
        }),
      },
    );
    expect(response.status).toBe(200);
    await response.text();
    // DeepSeek's OpenAI base URL carries no `v1`, so the joined URL must not
    // grow one; the provider path is the client's, verbatim.
    expect(upstreamUrl).toBe("https://api.deepseek.com/chat/completions");
    expect(upstreamHeaders.get("authorization")).toBe("Bearer test-deepseek-secret");
    // Chat-completions clamp: `max_tokens`, not OpenAI's max_completion_tokens.
    expect(upstreamBody).toMatchObject({ model: "deepseek-v4-pro", max_tokens: 256 });

    await settleUsage();
    const row = await env.DB.prepare(
      `SELECT input_tokens, cached_input_tokens, output_tokens, cost_usd, cost_source, model_author
         FROM app_usage_event WHERE app_id = ? ORDER BY id DESC LIMIT 1`,
    )
      .bind("proxy-deepseek")
      .first<{
        input_tokens: number;
        cached_input_tokens: number;
        output_tokens: number;
        cost_usd: number;
        cost_source: string | null;
        model_author: string | null;
      }>();
    expect(row).toEqual({
      input_tokens: 0,
      cached_input_tokens: 1_000_000,
      output_tokens: 0,
      // $0.044 cached, not the $1.32 fresh rate: a 30x difference on this
      // request, and the reason the cache field is read at all.
      cost_usd: 0.044,
      cost_source: "computed",
      model_author: "DeepSeek",
    });
  });

  it("records a Groq model under its own author, not under Groq", async () => {
    const key = await seedServerApp("proxy-groq", {
      proxy: {
        ...defaultProxyConfig(),
        groq: {
          allowed_paths: ["openai/v1/chat/completions"],
          allowed_models: ["openai/gpt-oss-120b"],
        },
      },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        choices: [{ message: { role: "assistant", content: "answer" } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }));

    const response = await workerFetch(
      "https://example.test/v1/apps/proxy-groq/proxy/groq/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "x-end-user-id": "groq-user-1",
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-120b",
          messages: [{ role: "user", content: "hello" }],
        }),
      },
    );
    expect(response.status).toBe(200);
    await response.text();

    await settleUsage();
    const row = await env.DB.prepare(
      `SELECT model, model_author, provider_type, cost_usd
         FROM app_usage_event WHERE app_id = ? ORDER BY id DESC LIMIT 1`,
    )
      .bind("proxy-groq")
      .first<{
        model: string;
        model_author: string | null;
        provider_type: string;
        cost_usd: number;
      }>();
    // Counterparty and author are different facts, and this batch is what
    // makes them differ: Groq served a model OpenAI wrote.
    expect(row).toEqual({
      model: "openai/gpt-oss-120b",
      model_author: "OpenAI",
      provider_type: "groq",
      cost_usd: 100 * 0.15e-6 + 20 * 0.6e-6,
    });
  });

  it("refuses a Fireworks model until the operator prices it", async () => {
    // No shipped catalog for Fireworks: its model IDs are account-scoped, so
    // the fail-closed gate holds until someone enters a price.
    const key = await seedServerApp("proxy-fireworks", {
      proxy: {
        ...defaultProxyConfig(),
        fireworks: { allowed_paths: ["inference/v1/chat/completions"], allowed_models: [] },
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await workerFetch(
      "https://example.test/v1/apps/proxy-fireworks/proxy/fireworks/inference/v1/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "x-end-user-id": "fireworks-user-1",
        },
        body: JSON.stringify({
          model: "accounts/fireworks/models/kimi-k3",
          messages: [{ role: "user", content: "hello" }],
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as any).error.code).toBe("pricing_not_configured");
    // Nothing unmeterable reaches the provider at all.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("OpenRouter", () => {
  /**
   * The narrowing is a billing guarantee: OpenRouter answers `/responses`
   * perfectly well, but reports no cost there and has no local price to fall
   * back on, so the request would be served and recorded as unresolved. It is
   * refused before it leaves instead — the same fail-closed rule that stops an
   * unpriced model on any other type.
   */
  it("refuses a surface it reports no cost on, before the request leaves", async () => {
    const key = await seedServerApp("proxy-openrouter-style", {
      proxy: {
        ...defaultProxyConfig(),
        openrouter: {
          allowed_paths: ["v1/chat/completions", "v1/responses"],
          allowed_models: ["google/gemini-3.6-flash"],
        },
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.1 } }));
    const response = await workerFetch(
      "https://example.test/v1/apps/proxy-openrouter-style/proxy/openrouter/v1/responses",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "x-end-user-id": "openrouter-user-1",
        },
        body: JSON.stringify({ model: "google/gemini-3.6-flash", input: "hello" }),
      },
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as any).error.code).toBe("api_style_not_supported");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * A cost-reporting provider's request-side hook. No shipped type declares one:
 * OpenRouter's accounting is always on, so the `usage: {include: true}` this
 * used to inject bought nothing and cost a full re-serialization of every chat
 * body. The hook stays because it is where an opt-in would come back, and these
 * assert the pass-through it is today.
 */
describe("cost report body mutation", () => {
  it("leaves every chat-completions body untouched, on every provider type", () => {
    for (const type of PROVIDER_TYPES) {
      const body: Record<string, unknown> = { model: "m", messages: [] };
      expect([type, costReportBodyMutation(type, "chat_completions", body)])
        .toEqual([type, false]);
      expect([type, body]).toEqual([type, { model: "m", messages: [] }]);
    }
  });

  it("leaves a client's own `usage` block alone", () => {
    // It used to be overwritten to keep a client from switching the meter off.
    // Nothing reads the field now, and rewriting a request field nobody acts on
    // is a protocol change for no benefit.
    const body: Record<string, unknown> = { usage: { include: false, keep: "me" } };
    expect(costReportBodyMutation("openrouter", "chat_completions", body)).toBe(false);
    expect(body.usage).toEqual({ include: false, keep: "me" });
  });

  it("touches no body on any API style", () => {
    for (const style of API_STYLES) {
      const body: Record<string, unknown> = { model: "m" };
      expect([style, costReportBodyMutation("openrouter", style, body)]).toEqual([style, false]);
      expect([style, body]).toEqual([style, { model: "m" }]);
    }
  });

  /**
   * The hook is generic: a type that declares a mutation gets it called, and the
   * shared proxy path never learns whose field it wrote. Proved against a
   * hypothetical declaration rather than a real one, because no shipped type
   * needs it.
   */
  it("calls a declared mutation without the proxy path knowing whose it is", () => {
    const spec = PROVIDER_REGISTRY.perplexity as { costReport?: unknown };
    const calls: string[] = [];
    try {
      spec.costReport = {
        read: () => false,
        mutateBody: (input: { style: string; body: Record<string, unknown> }) => {
          calls.push(input.style);
          input.body.hypothetical = true;
          return true;
        },
      };
      const body: Record<string, unknown> = { model: "m" };
      expect(costReportBodyMutation("perplexity", "chat_completions", body)).toBe(true);
      expect(body).toEqual({ model: "m", hypothetical: true });
      expect(calls).toEqual(["chat_completions"]);
    } finally {
      delete spec.costReport;
    }
    const after: Record<string, unknown> = { model: "m" };
    expect(costReportBodyMutation("perplexity", "chat_completions", after)).toBe(false);
    expect(after).toEqual({ model: "m" });
  });
});

/**
 * An application with no `end_user` source has no end users, and that is a
 * position rather than a missing value. Nothing downstream may invent one: the
 * usage row records no user, the per-user machinery is skipped rather than
 * pointed at a stand-in, and `/me` has nothing to report.
 */
describe("an application that identifies no end users", () => {
  async function seedUserless(appId: string): Promise<string> {
    return seedServerApp(appId, { endUser: "none" });
  }

  it("records usage with no user, keeping the API key as the attribution", async () => {
    const key = await seedUserless("userless-usage");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    );
    const response = await proxyRequest({
      appId: "userless-usage",
      token: key,
      path: "openai/v1/responses",
      body: { model: "gpt-5.6-sol" },
    });
    await response.text();
    expect(response.status).toBe(200);
    await settleUsage();

    const row = await env.DB
      .prepare("SELECT user_id, api_key_id FROM app_usage_event WHERE app_id = ?")
      .bind("userless-usage")
      .first<{ user_id: string | null; api_key_id: string | null }>();
    // Null rather than the key id standing in for a person who does not exist,
    // and the credential is still on the row, so nothing about the traffic's
    // provenance is lost.
    expect(row?.user_id).toBeNull();
    expect(row?.api_key_id).toBe("key_userless-usage");
  });

  it("synthesizes no user in the console listing", async () => {
    const key = await seedUserless("userless-listing");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    );
    await (await proxyRequest({
      appId: "userless-listing",
      token: key,
      path: "openai/v1/responses",
      body: { model: "gpt-5.6-sol" },
    })).text();
    await settleUsage();

    const listed = await workerFetch(
      "https://example.test/v1/admin/apps/userless-listing/users",
      { headers: { authorization: "Bearer agw_mgmt_test-admin-secret" } },
    );
    expect(listed.status).toBe(200);
    const body = await listed.json<{ users: unknown[]; total: number }>();
    expect(body.users).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("counts no users in the console app list", async () => {
    const key = await seedUserless("userless-app-count");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    );
    await (await proxyRequest({
      appId: "userless-app-count",
      token: key,
      path: "openai/v1/responses",
      body: { model: "gpt-5.6-sol" },
    })).text();
    await settleUsage();

    const listed = await workerFetch("https://example.test/v1/admin/apps", {
      headers: { authorization: "Bearer agw_mgmt_test-admin-secret" },
    });
    const body = await listed.json<{ apps: { id: string; users: { total: number } }[] }>();
    const row = body.apps.find((entry) => entry.id === "userless-app-count");
    // The userless rows must not group into one phantom identity here either.
    expect(row?.users.total).toBe(0);
  });

  it("answers /me with 404 rather than a body of nulls", async () => {
    const key = await seedUserless("userless-me");
    const response = await workerFetch("https://example.test/v1/apps/userless-me/me", {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("identifies no end users") },
    });
  });

  it("still enforces the application-wide limits, which need no user", async () => {
    const key = await seedServerApp("userless-app-limit", {
      endUser: "none",
      limits: { app_rpm: 1 },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    );
    const call = () => proxyRequest({
      appId: "userless-app-limit",
      token: key,
      path: "openai/v1/responses",
      body: { model: "gpt-5.6-sol" },
    });
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
  });
});

/** A header source names the header, and the gateway consumes it either way. */
describe("a custom end-user header", () => {
  it("identifies the user and never reaches the provider", async () => {
    const key = await seedServerApp("custom-end-user-header", {
      endUser: "header",
      endUserHeader: "x-tenant-user",
    });
    let upstreamHeaders = new Headers();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      upstreamHeaders = new Headers(init?.headers);
      return Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
    });
    const response = await workerFetch(
      "https://example.test/v1/apps/custom-end-user-header/proxy/openai/v1/responses",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
          "x-tenant-user": "tenant-user-9",
          // The conventional name is stripped too, so a client sending it out
          // of habit never leaks it to the provider either.
          "x-end-user-id": "ignored",
        },
        body: JSON.stringify({ model: "gpt-5.6-sol" }),
      },
    );
    await response.text();
    expect(response.status).toBe(200);
    expect(upstreamHeaders.get("x-tenant-user")).toBeNull();
    expect(upstreamHeaders.get("x-end-user-id")).toBeNull();
    await settleUsage();

    const row = await env.DB
      .prepare("SELECT user_id FROM app_usage_event WHERE app_id = ?")
      .bind("custom-end-user-header")
      .first<{ user_id: string | null }>();
    expect(row?.user_id).toBe("tenant-user-9");
  });

  it("refuses a request that omits it, rather than filing the traffic under nobody", async () => {
    const key = await seedServerApp("missing-end-user-header", {
      endUser: "header",
      endUserHeader: "x-tenant-user",
    });
    const response = await proxyRequest({
      appId: "missing-end-user-header",
      token: key,
      path: "openai/v1/responses",
      body: { model: "gpt-5.6-sol" },
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_request", message: "x-tenant-user is required" },
    });
  });
});

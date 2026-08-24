import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { OutputClampStyle, Provider } from "../src/core/types";
import { defaultProxyConfig, devToken, seedApp, seedServerApp } from "./helpers";

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: string;
}

interface OutputCapCase {
  name: string;
  provider: Provider;
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

async function workerFetch(input: string, init: RequestInit): Promise<Response> {
  const executionCtx = createExecutionContext();
  const response = await app.fetch(new Request(input, init), env, executionCtx);
  pendingExecutionContexts.push(executionCtx);
  return response;
}

async function proxyRequest(input: {
  appId: string;
  token: string;
  path: string;
  body: Record<string, unknown>;
  tokenHeader?: string;
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
    const token = await devToken(appId);
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
    expect(captured[0]?.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/local-account/test-gateway/perplexity-ai/chat/completions",
    );
  });

  it("allows individual mode to disable every provider", async () => {
    const appId = "proxy-selected-none";
    await seedApp(appId, {
      proxy: { provider_mode: "selected", model_rewrites: {} },
    });
    const token = await devToken(appId);
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
    const token = await devToken(appId);
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
    const token = await devToken("proxy-stream");
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
    expect(captured[0]?.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/local-account/test-gateway/openai/responses",
    );
    expect(captured[0]?.headers.get("authorization")).toBeNull();
    expect(captured[0]?.headers.get("cf-aig-authorization")).toBe("Bearer test-cf-aig-token");
    expect(JSON.parse(captured[0]?.headers.get("cf-aig-metadata") ?? "null")).toEqual({
      app_id: "proxy-stream",
      user_id: "user-1",
    });
    expect(JSON.parse(captured[0]!.body)).toMatchObject({ model: "gpt-5.6-sol", max_output_tokens: 128 });
  });

  it("rejects paths and models outside the tenant allowlists", async () => {
    await seedApp("proxy-deny");
    const token = await devToken("proxy-deny");
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
    const token = await devToken(appId);
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
    const token = await devToken(appId);
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
    expect(captured[0]?.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/local-account/test-gateway/openai/chat/completions",
    );
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
    const token = await devToken(appId);
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
      "https://gateway.ai.cloudflare.com/v1/local-account/test-gateway/google-ai-studio/v1beta/models/gemini-3.6-flash:generateContent",
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
        const token = await devToken(appId);
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
        const token = await devToken(appId);
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
        const token = await devToken(appId);
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
          "SELECT COUNT(*) AS count FROM usage_events WHERE app_id = ?",
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
        const token = await devToken(appId);
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
    const token = await devToken("proxy-rewrite");
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
      "/google-ai-studio/v1beta/models/gemini-3.6-flash:generateContent",
    );
    expect(captured[1]?.url).toContain("alt=sse");
    expect(captured[1]?.url).not.toContain("must-not-leak");
    expect(JSON.parse(captured[1]!.body)).toMatchObject({
      generationConfig: { maxOutputTokens: 100 },
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM usage_events WHERE app_id = ? AND model = ?",
      )
        .bind("proxy-rewrite", "gemini-3.6-flash")
        .first<{ count: number }>();
      if ((row?.count ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Rewritten model was not persisted to usage_events");
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
    const token = await devToken("proxy-gemini-encoding");
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
      "/google-ai-studio/v1beta/models/gemini-3.6-flash:generateContent",
    );
  });

  it("uses the body model and chat-completions cap policy for Gemini OpenAI-compatible requests", async () => {
    await seedApp("proxy-gemini-openai");
    const token = await devToken("proxy-gemini-openai");
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
    expect(upstreamUrl).toContain("/google-ai-studio/v1beta/openai/chat/completions");
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
    const token = await devToken("proxy-native-header");
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
    expect(upstreamHeaders.get("x-api-key")).toBeNull();
    expect(upstreamHeaders.get("cf-aig-authorization")).toBe("Bearer test-cf-aig-token");
  });

  it("accepts a tenant-configured token header and strips it upstream", async () => {
    await seedApp("proxy-custom-header", {
      auth: {
        jwks_url: "https://issuer.test/.well-known/jwks.json",
        token_header: "x-tenant-token",
      },
    });
    const token = await devToken("proxy-custom-header");
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

  it("forwards multipart transcription with only the model field rewritten", async () => {
    await seedApp("proxy-multipart", {
      proxy: {
        ...defaultProxyConfig(),
        model_rewrites: { "gpt-4o-mini-transcribe": "gpt-4o-transcribe" },
      },
    });
    const token = await devToken("proxy-multipart");
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
    const token = await devToken("proxy-xai-stt");
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
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const row = await env.DB.prepare(
        "SELECT model, cost_usd, auth_method FROM usage_events WHERE app_id = ? ORDER BY id DESC LIMIT 1",
      )
        .bind("proxy-xai-stt")
        .first<{ model: string; cost_usd: number; auth_method: string | null }>();
      if (row) {
        expect(row.model).toBe("grok-transcribe");
        expect(row.cost_usd).toBeCloseTo((1.25 / 3600) * 0.1, 8);
        expect(row.auth_method).toBe("dev");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Fixed xAI STT model was not persisted to usage_events");
  });

  it("rejects bodies larger than 20 MB before contacting the provider", async () => {
    await seedApp("proxy-size");
    const token = await devToken("proxy-size");
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
    const token = await devToken("proxy-malformed-usage");
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
    expect(upstreamUrl).toBe(
      "https://gateway.ai.cloudflare.com/v1/local-account/test-gateway/perplexity-ai/chat/completions",
    );
    expect(upstreamHeaders.get("authorization")).toBeNull();
    expect(upstreamHeaders.get("x-end-user-id")).toBeNull();
    expect(upstreamHeaders.get("cf-aig-authorization")).toBe("Bearer test-cf-aig-token");
    expect(JSON.parse(upstreamHeaders.get("cf-aig-metadata") ?? "null")).toEqual({
      app_id: "proxy-perplexity",
      user_id: "grower-user-7",
    });
    expect(upstreamHeaders.get("cf-aig-cache-ttl")).toBe("600");
    expect(upstreamHeaders.get("cf-aig-unknown-control")).toBeNull();
    expect(upstreamBody).toMatchObject({ model: "sonar-pro", max_tokens: 256 });

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const row = await env.DB.prepare(
        `SELECT user_id, input_tokens, output_tokens, cost_usd, app_version, auth_method
           FROM usage_events WHERE app_id = ? ORDER BY id DESC LIMIT 1`,
      )
        .bind("proxy-perplexity")
        .first<{
          user_id: string;
          input_tokens: number;
          output_tokens: number;
          cost_usd: number;
          app_version: string | null;
          auth_method: string | null;
        }>();
      const keyRow = await env.DB.prepare("SELECT last_used_at FROM api_keys WHERE app_id = ?")
        .bind("proxy-perplexity")
        .first<{ last_used_at: string | null }>();
      if (row && keyRow?.last_used_at) {
        expect(row).toEqual({
          user_id: "grower-user-7",
          input_tokens: 100,
          output_tokens: 20,
          cost_usd: 0.0006,
          app_version: null,
          auth_method: "api_key",
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Perplexity server-tenant usage was not persisted");
  });
});

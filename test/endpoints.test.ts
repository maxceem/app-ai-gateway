import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { devToken, seedApp, seedServerApp } from "./helpers";

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: string;
  form: FormData | null;
}

interface UsageRow {
  provider: string;
  model: string;
  route: string;
  endpoint_slug: string | null;
  status: string;
  app_version: string | null;
}

const CHAT_ENDPOINTS = {
  chat: {
    api_style: "responses",
    provider: "openai",
    model: "gpt-5.6-luna",
    params: { reasoning: { effort: "low" }, store: false },
  },
  transcribe: {
    api_style: "transcription",
    provider: "openai",
    model: "gpt-4o-mini-transcribe",
  },
};

let pendingExecutionContexts: ExecutionContext[] = [];

async function workerFetch(input: string, init: RequestInit): Promise<Response> {
  const executionCtx = createExecutionContext();
  const response = await app.fetch(new Request(input, init), env, executionCtx);
  pendingExecutionContexts.push(executionCtx);
  return response;
}

function captureUpstream(
  responder: (attempt: number) => Response | Promise<Response>,
): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
    captured.push({
      url: typeof request === "string"
        ? request
        : request instanceof URL
          ? request.toString()
          : request.url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
      form: init?.body instanceof FormData ? init.body : null,
    });
    return responder(captured.length - 1);
  });
  return captured;
}

const usageResponse = () =>
  Response.json({ usage: { input_tokens: 10, output_tokens: 2 } });

async function endpointRequest(input: {
  appId: string;
  slug: string;
  token: string;
  body: BodyInit;
  contentType?: string;
  method?: string;
}): Promise<Response> {
  return workerFetch(`https://example.test/v1/apps/${input.appId}/endpoints/${input.slug}`, {
    method: input.method ?? "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      "x-app-version": "1.2.3",
      ...(input.contentType ? { "content-type": input.contentType } : {}),
    },
    body: input.body,
  });
}

async function latestUsage(appId: string, expected = 1): Promise<UsageRow[]> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const rows = await env.DB.prepare(
      `SELECT provider, model, route, endpoint_slug, status, app_version
         FROM usage_events WHERE app_id = ? ORDER BY id`,
    )
      .bind(appId)
      .all<UsageRow>();
    if (rows.results.length >= expected) return rows.results;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Expected ${expected} usage events for ${appId}`);
}

afterEach(async () => {
  await Promise.all(pendingExecutionContexts.map((context) => waitOnExecutionContext(context)));
  pendingExecutionContexts = [];
  vi.restoreAllMocks();
});

describe("named endpoints", () => {
  it("overwrites the model, deep-merges configured params, and clamps output tokens", async () => {
    const appId = "endpoint-responses";
    await seedApp(appId, {
      endpoints: {
        chat: { ...CHAT_ENDPOINTS.chat, max_output_tokens: 4096 },
      },
    });
    const token = await devToken(appId);
    const captured = captureUpstream(usageResponse);

    const response = await endpointRequest({
      appId,
      slug: "chat",
      token,
      contentType: "application/json",
      body: JSON.stringify({
        model: "client-picked-model",
        input: "hello",
        reasoning: { effort: "high", summary: "auto" },
        store: true,
      }),
    });
    await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("server-timing")).toContain("provider_ttfb");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/local-account/test-gateway/openai/responses",
    );
    expect(JSON.parse(captured[0]!.body)).toEqual({
      model: "gpt-5.6-luna",
      input: "hello",
      // Server configuration wins on conflicts; untouched client keys survive.
      reasoning: { effort: "low", summary: "auto" },
      store: false,
      max_output_tokens: 4096,
    });
    expect(captured[0]?.headers.get("authorization")).toBeNull();
    expect(captured[0]?.headers.get("cf-aig-authorization")).toBe("Bearer test-cf-aig-token");
    expect(JSON.parse(captured[0]?.headers.get("cf-aig-metadata") ?? "null")).toEqual({
      app_id: appId,
      user_id: "user-1",
    });
  });

  it("records usage with the endpoint slug", async () => {
    const appId = "endpoint-usage";
    await seedApp(appId, { endpoints: CHAT_ENDPOINTS });
    const token = await devToken(appId);
    captureUpstream(usageResponse);

    const response = await endpointRequest({
      appId,
      slug: "chat",
      token,
      contentType: "application/json",
      body: JSON.stringify({ input: "hello" }),
    });
    await response.text();
    expect(response.status).toBe(200);

    const [row] = await latestUsage(appId);
    expect(row).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-luna",
      route: "openai/v1/responses",
      endpoint_slug: "chat",
      status: "ok",
      app_version: "1.2.3",
    });
  });

  it("leaves the endpoint slug null for passthrough proxy traffic", async () => {
    const appId = "endpoint-passthrough";
    await seedApp(appId, { endpoints: CHAT_ENDPOINTS });
    const token = await devToken(appId);
    captureUpstream(usageResponse);

    const response = await workerFetch(
      `https://example.test/v1/apps/${appId}/proxy/openai/v1/responses`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-app-version": "1.2.3",
        },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
      },
    );
    await response.text();
    expect(response.status).toBe(200);

    const [row] = await latestUsage(appId);
    expect(row?.endpoint_slug).toBeNull();
  });

  it("streams a provider-native SSE response unbuffered", async () => {
    const appId = "endpoint-stream";
    await seedApp(appId, { endpoints: CHAT_ENDPOINTS });
    const token = await devToken(appId);
    const first = "event: response.output_text.delta\ndata: {\"delta\":\"hi\"}\n\n";
    const second = "event: response.completed\ndata: {\"response\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":2}}}\n\n";
    let secondSent = false;
    captureUpstream(() => {
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

    const response = await endpointRequest({
      appId,
      slug: "chat",
      token,
      contentType: "application/json",
      body: JSON.stringify({ input: "hello", stream: true }),
    });

    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(first);
    expect(secondSent).toBe(false);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(second);
    expect((await reader.read()).done).toBe(true);
  });

  it("injects the configured model into an OpenAI multipart transcription", async () => {
    const appId = "endpoint-transcribe";
    await seedApp(appId, { endpoints: CHAT_ENDPOINTS });
    const token = await devToken(appId);
    const captured = captureUpstream(() =>
      Response.json({ text: "hello", duration: 1.25 }),
    );

    const form = new FormData();
    form.set("language", "en");
    form.set("file", new File([new Uint8Array([1, 2, 3])], "sample.m4a", { type: "audio/mp4" }));
    const response = await endpointRequest({ appId, slug: "transcribe", token, body: form });
    await response.text();

    expect(response.status).toBe(200);
    expect(captured[0]?.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/local-account/test-gateway/openai/audio/transcriptions",
    );
    expect(captured[0]?.form?.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(captured[0]?.form?.get("language")).toBe("en");
    expect((captured[0]?.form?.get("file") as File).size).toBe(3);
    expect(captured[0]?.headers.get("content-type")).toBeNull();

    const [row] = await latestUsage(appId);
    expect(row).toMatchObject({
      provider: "openai",
      model: "gpt-4o-mini-transcribe",
      route: "openai/v1/audio/transcriptions",
      endpoint_slug: "transcribe",
    });
  });

  it("routes an xAI transcription endpoint to the grok speech-to-text path", async () => {
    const appId = "endpoint-xai-stt";
    await seedApp(appId, {
      endpoints: {
        voice: { api_style: "transcription", provider: "xai", model: "grok-transcribe" },
      },
    });
    const token = await devToken(appId);
    const captured = captureUpstream(() => Response.json({ text: "hello", duration: 1 }));

    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3])], "voice.wav", { type: "audio/wav" }));
    const response = await endpointRequest({ appId, slug: "voice", token, body: form });
    await response.text();

    expect(response.status).toBe(200);
    expect(captured[0]?.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/local-account/test-gateway/grok/v1/stt",
    );
    expect(captured[0]?.form?.get("model")).toBe("grok-transcribe");
  });

  it("rejects a JSON body for a transcription endpoint", async () => {
    const appId = "endpoint-transcribe-json";
    await seedApp(appId, { endpoints: CHAT_ENDPOINTS });
    const token = await devToken(appId);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await endpointRequest({
      appId,
      slug: "transcribe",
      token,
      contentType: "application/json",
      body: JSON.stringify({ file: "not-multipart" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to the next target on an upstream 500 and bills the model that served", async () => {
    const appId = "endpoint-fallback";
    await seedApp(appId, {
      endpoints: {
        chat: {
          ...CHAT_ENDPOINTS.chat,
          fallback: [{ provider: "xai", model: "grok-4.5" }],
        },
      },
    });
    const token = await devToken(appId);
    const captured = captureUpstream((attempt) =>
      attempt === 0
        ? Response.json({ error: { message: "upstream exploded" } }, { status: 500 })
        : Response.json({ id: "from-fallback", usage: { input_tokens: 4, output_tokens: 1 } }),
    );

    const response = await endpointRequest({
      appId,
      slug: "chat",
      token,
      contentType: "application/json",
      body: JSON.stringify({ input: "hello" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: "from-fallback" });
    expect(captured).toHaveLength(2);
    expect(captured[0]?.url).toContain("/openai/responses");
    expect(captured[1]?.url).toContain("/grok/v1/responses");
    expect(JSON.parse(captured[1]!.body)).toMatchObject({ model: "grok-4.5", input: "hello" });

    const rows = await latestUsage(appId, 2);
    expect(rows[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-luna",
      status: "provider_error",
      endpoint_slug: "chat",
    });
    expect(rows[1]).toMatchObject({
      provider: "xai",
      model: "grok-4.5",
      status: "ok",
      endpoint_slug: "chat",
    });
  });

  it("returns the last upstream failure when every target fails", async () => {
    const appId = "endpoint-fallback-exhausted";
    await seedApp(appId, {
      endpoints: {
        chat: { ...CHAT_ENDPOINTS.chat, fallback: [{ provider: "xai", model: "grok-4.5" }] },
      },
    });
    const token = await devToken(appId);
    const captured = captureUpstream(() =>
      Response.json({ error: { message: "still broken" } }, { status: 503 }),
    );

    const response = await endpointRequest({
      appId,
      slug: "chat",
      token,
      contentType: "application/json",
      body: JSON.stringify({ input: "hello" }),
    });
    await response.text();

    expect(response.status).toBe(503);
    expect(captured).toHaveLength(2);
  });

  it("retries the next target when the provider fetch throws", async () => {
    const appId = "endpoint-fallback-network";
    await seedApp(appId, {
      endpoints: {
        chat: { ...CHAT_ENDPOINTS.chat, fallback: [{ provider: "xai", model: "grok-4.5" }] },
      },
    });
    const token = await devToken(appId);
    let attempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("connection reset");
      return Response.json({ id: "second", usage: { input_tokens: 1, output_tokens: 1 } });
    });

    const response = await endpointRequest({
      appId,
      slug: "chat",
      token,
      contentType: "application/json",
      body: JSON.stringify({ input: "hello" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: "second" });
    expect(attempts).toBe(2);
  });

  it.each([
    ["an unknown slug", "missing"],
    ["a slug that is not a valid pattern", "Chat"],
    ["an inherited object property", "constructor"],
  ])("returns endpoint_not_found for %s", async (_label, slug) => {
    const appId = `endpoint-404-${slug.toLowerCase()}`;
    await seedApp(appId, { endpoints: CHAT_ENDPOINTS });
    const token = await devToken(appId);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await endpointRequest({
      appId,
      slug,
      token,
      contentType: "application/json",
      body: JSON.stringify({ input: "hello" }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "endpoint_not_found" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns endpoint_not_found when the app configures no endpoints", async () => {
    await seedApp("endpoint-none");
    const token = await devToken("endpoint-none");
    const response = await endpointRequest({
      appId: "endpoint-none",
      slug: "chat",
      token,
      contentType: "application/json",
      body: JSON.stringify({ input: "hello" }),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "endpoint_not_found" },
    });
  });

  it("rejects a client output cap above the configured maximum", async () => {
    const appId = "endpoint-cap";
    await seedApp(appId, {
      endpoints: { chat: { ...CHAT_ENDPOINTS.chat, max_output_tokens: 128 } },
    });
    const token = await devToken(appId);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await endpointRequest({
      appId,
      slug: "chat",
      token,
      contentType: "application/json",
      body: JSON.stringify({ input: "hello", max_output_tokens: 129 }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "max_output_tokens_exceeded" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requires X-App-Version for issuer clients but not for server API keys", async () => {
    await seedApp("endpoint-version", { endpoints: CHAT_ENDPOINTS });
    const token = await devToken("endpoint-version");
    const missingVersion = await workerFetch(
      "https://example.test/v1/apps/endpoint-version/endpoints/chat",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ input: "hello" }),
      },
    );
    expect(missingVersion.status).toBe(400);

    const key = await seedServerApp("endpoint-server", { endpoints: CHAT_ENDPOINTS });
    captureUpstream(usageResponse);
    const serverResponse = await workerFetch(
      "https://example.test/v1/apps/endpoint-server/endpoints/chat",
      {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ input: "hello" }),
      },
    );
    await serverResponse.text();
    expect(serverResponse.status).toBe(200);
  });

  it("rejects bodies larger than 20 MB before contacting the provider", async () => {
    await seedApp("endpoint-size", { endpoints: CHAT_ENDPOINTS });
    const token = await devToken("endpoint-size");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await workerFetch(
      "https://example.test/v1/apps/endpoint-size/endpoints/chat",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": String(20 * 1024 * 1024 + 1),
          "x-app-version": "1.2.3",
        },
        body: JSON.stringify({ input: "hello" }),
      },
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "payload_too_large" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not serve named endpoints over GET", async () => {
    await seedApp("endpoint-method", { endpoints: CHAT_ENDPOINTS });
    const token = await devToken("endpoint-method");
    const response = await workerFetch(
      "https://example.test/v1/apps/endpoint-method/endpoints/chat",
      { method: "GET", headers: { authorization: `Bearer ${token}`, "x-app-version": "1.2.3" } },
    );
    expect(response.status).toBe(404);
  });
});

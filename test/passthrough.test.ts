import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { isPassthroughPath } from "../src/shared/app-config";
import {
  gatewayToken,
  seedApp,
  seedServerApp,
  serverConfig,
  signRequest,
  testProviderSecret,
  validateConfig,
} from "./helpers";

afterEach(() => vi.restoreAllMocks());

async function served(request: Request): Promise<Response> {
  const context = createExecutionContext();
  const response = await app.fetch(await signRequest(request), env, context);
  const bytes = await response.arrayBuffer();
  await waitOnExecutionContext(context);
  return new Response(bytes, { status: response.status, headers: response.headers });
}

/** What the gateway sent upstream, captured from a provider that answers `answer`. */
function provider(answer: () => Response = () => Response.json({ ok: true })): {
  calls: { url: string; method: string; headers: Headers; body: string | null }[];
} {
  const calls: { url: string; method: string; headers: Headers; body: string | null }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    calls.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" ? null : await request.text(),
    });
    return answer();
  });
  return { calls };
}

/** Every line the gateway logged while `run` ran, as text. */
async function logged<T>(run: () => Promise<T>): Promise<{ result: T; lines: string }> {
  const lines: unknown[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args);
    });
  }
  const result = await run();
  return { result, lines: lines.map((args) => JSON.stringify(args)).join("\n") };
}

interface UsageRow {
  model: string;
  route: string;
  cost_usd: number;
  cost_source: string | null;
  reported_cost_usd: number | null;
  model_author: string | null;
  install_id: string | null;
  status: string;
}

async function usageRows(appId: string): Promise<UsageRow[]> {
  const result = await env.DB.prepare(
    `SELECT model, route, cost_usd, cost_source, reported_cost_usd, model_author, install_id, status
     FROM app_usage_event WHERE app_id = ? ORDER BY id`,
  ).bind(appId).all<UsageRow>();
  return result.results;
}

describe("which paths are passthrough", () => {
  it("is every path outside the APIs the gateway reads and the provider's own inference operations", () => {
    expect(isPassthroughPath("openai", "v1/realtime/client_secrets")).toBe(true);
    expect(isPassthroughPath("openai", "v1/files")).toBe(true);
    expect(isPassthroughPath("xai", "v1/videos/generations")).toBe(true);
    expect(isPassthroughPath("openai", "v1/responses")).toBe(false);
    expect(isPassthroughPath("openai", "v1/audio/transcriptions")).toBe(false);
    expect(isPassthroughPath("xai", "v1/stt")).toBe(false);
    expect(isPassthroughPath("openai", "v1/audio/speech")).toBe(false);
    expect(isPassthroughPath("gemini", "v1beta/models/{model}:generateContent")).toBe(false);
    expect(isPassthroughPath("gemini", "v1beta/models/gemini-embedding-2:embedContent")).toBe(false);
    // An inference operation of one provider type is not one of another's.
    expect(isPassthroughPath("anthropic", "v1/audio/speech")).toBe(true);
  });
});

/**
 * An iOS app that lets its users stream live audio to OpenAI: it lists the
 * realtime key endpoint with a fixed model saved on it from before passthrough
 * existed, verifies App Attest on every request and limits each install. It
 * has to keep working exactly as configured.
 */
describe("an App Attest app minting realtime transcription keys", () => {
  const PROXY = {
    openai: {
      allowed_paths: [
        "v1/responses",
        { path: "v1/realtime/client_secrets", fixed_model: "gpt-live-transcribe", clamp: "none" },
      ],
      allowed_models: [],
    },
  };
  // Spacing and field order the gateway must not normalise.
  const BODY = '{"expires_after":{"anchor":"created_at","seconds":600},"session":{"type":"transcription",'
    + '"audio":{"input":{"format":{"type":"audio/pcm","rate":24000},"noise_reduction":{"type":"near_field"},'
    + '"transcription":{"model":"gpt-live-transcribe","language":"en"},"turn_detection":null}}}}';
  const KEY = "ek_test_passthrough_0123456789";

  function mint(appId: string, token: string, body = BODY): Request {
    return new Request(`https://example.test/v1/apps/${appId}/proxy/openai/v1/realtime/client_secrets`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-app-version": "1.0.7",
      },
      body,
    });
  }

  it("forwards the request byte for byte and records it as passthrough, with no alert", async () => {
    const appId = "passthrough-attest";
    await seedApp(appId, {
      endUser: "app_install",
      verifyOn: "every_request",
      proxy: PROXY,
      limits: { rpm: 100, rpd: 10_000 },
      budgetScope: "install",
    });
    const token = await gatewayToken(appId, "install-1");
    const upstream = provider(() => Response.json({ value: KEY, expires_at: 1_900_000_000 }));

    const { result: response, lines } = await logged(() => served(mint(appId, token)));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ value: KEY });
    expect(upstream.calls).toHaveLength(1);
    const [call] = upstream.calls;
    expect(call!.url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    expect(call!.method).toBe("POST");
    expect(call!.body).toBe(BODY);
    expect(call!.headers.get("content-type")).toBe("application/json");
    expect(call!.headers.get("authorization")).toBe(`Bearer ${testProviderSecret("openai")}`);
    expect(call!.headers.get("x-appattest-proof")).toBeNull();
    expect(lines).not.toContain("usage_unresolved_cost");
    expect(lines).not.toContain("usage_unpriced_model");

    const [row] = await usageRows(appId);
    expect(row).toMatchObject({
      model: "",
      route: "openai/v1/realtime/client_secrets",
      cost_usd: 0,
      cost_source: null,
      reported_cost_usd: null,
      model_author: null,
      status: "ok",
    });
    expect(row!.install_id).not.toBeNull();
  });

  it("does not judge the model the body names: the gateway reads none", async () => {
    const appId = "passthrough-attest-any-model";
    await seedApp(appId, { endUser: "app_install", proxy: PROXY });
    const token = await gatewayToken(appId, "install-1");
    const upstream = provider(() => Response.json({ value: KEY }));
    const body = '{"session":{"type":"realtime","model":"gpt-realtime"}}';

    const response = await served(mint(appId, token, body));

    expect(response.status).toBe(200);
    expect(upstream.calls[0]!.body).toBe(body);
  });

  it("still applies the app's request limits to each install", async () => {
    const appId = "passthrough-attest-limited";
    await seedApp(appId, { endUser: "app_install", proxy: PROXY, limits: { rpm: 1 } });
    const token = await gatewayToken(appId, "install-1");
    const upstream = provider(() => Response.json({ value: KEY }));

    expect((await served(mint(appId, token))).status).toBe(200);
    const refused = await served(mint(appId, token));

    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: { code: "app_rate_limited" } });
    expect(upstream.calls).toHaveLength(1);
  });
});

describe("a passthrough path on a server app", () => {
  function request(appId: string, key: string, path: string, init: { method?: string; body?: string; type?: string } = {}) {
    return new Request(`https://example.test/v1/apps/${appId}/proxy/openai/${path}`, {
      method: init.method ?? "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "x-end-user-id": "user-1",
        ...(init.type ? { "content-type": init.type } : {}),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
  }

  it("skips the model allowlist, rewrites, pricing and body rules", async () => {
    const appId = "passthrough-server-rules";
    const key = await seedServerApp(appId, {
      proxy: {
        openai: { allowed_paths: ["v1/batches"], allowed_models: ["gpt-5.6-sol"], max_output_tokens: 16 },
        model_rewrites: { "unpriced-model": "gpt-5.6-sol" },
      },
    });
    const upstream = provider();
    const body = '{"model":"unpriced-model","background":true,"max_output_tokens":100000}';

    const response = await served(request(appId, key, "v1/batches", { body, type: "application/json" }));

    expect(response.status).toBe(200);
    expect(upstream.calls[0]!.body).toBe(body);
  });

  it("forwards a body that is not JSON, with its own content type", async () => {
    const appId = "passthrough-server-text";
    const key = await seedServerApp(appId, { proxy: { openai: { allowed_paths: ["v1/uploads"], allowed_models: [] } } });
    const upstream = provider();

    const response = await served(request(appId, key, "v1/uploads", { body: "plain bytes", type: "text/plain" }));

    expect(response.status).toBe(200);
    expect(upstream.calls[0]!.body).toBe("plain bytes");
    expect(upstream.calls[0]!.headers.get("content-type")).toContain("text/plain");
  });

  it("opens only POST unless the entry lists its methods", async () => {
    const appId = "passthrough-server-methods";
    const key = await seedServerApp(appId, {
      proxy: {
        openai: {
          allowed_paths: ["v1/files", { path: "v1/batches", methods: ["GET", "POST"] }],
          allowed_models: [],
        },
      },
    });
    const upstream = provider();

    const listFiles = await served(request(appId, key, "v1/files", { method: "GET" }));
    expect(listFiles.status).toBe(403);
    expect(await listFiles.json()).toMatchObject({ error: { code: "path_not_allowed" } });
    expect(upstream.calls).toHaveLength(0);

    expect((await served(request(appId, key, "v1/batches", { method: "GET" }))).status).toBe(200);
    expect(upstream.calls[0]).toMatchObject({ method: "GET", body: null });
    expect((await served(request(appId, key, "v1/batches", { method: "POST", body: "{}" }))).status).toBe(200);
    expect((await served(request(appId, key, "v1/batches", { method: "DELETE" }))).status).toBe(403);
    expect(upstream.calls).toHaveLength(2);
  });
});

describe("a passthrough path the provider reports a cost for", () => {
  it("records the reported cost, which counts like any other", async () => {
    const appId = "passthrough-reported";
    const key = await seedServerApp(appId, {
      proxy: { xai: { allowed_paths: ["v1/videos/generations"], allowed_models: [] } },
    });
    provider(() => Response.json({ request_id: "video-1", usage: { cost_in_usd_ticks: 5_000_000_000 } }));

    const response = await served(new Request(`https://example.test/v1/apps/${appId}/proxy/xai/v1/videos/generations`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "x-end-user-id": "user-1", "content-type": "application/json" },
      body: '{"model":"grok-imagine-video","prompt":"a cat"}',
    }));

    expect(response.status).toBe(200);
    const [row] = await usageRows(appId);
    expect(row).toMatchObject({ model: "", cost_source: "reported", cost_usd: 0.5, reported_cost_usd: 0.5 });
  });
});

describe("saving a passthrough path", () => {
  it("accepts a stored fixed model it will never use, priced or not", () => {
    expect(() => validateConfig(serverConfig({
      proxy: {
        openai: {
          allowed_paths: [{ path: "v1/realtime/client_secrets", fixed_model: "not-in-any-catalog", clamp: "none" }],
          allowed_models: [],
        },
      },
    }))).not.toThrow();
  });

  it("takes methods on a passthrough path and refuses them on a model call", () => {
    const withMethods = (path: string) => serverConfig({
      proxy: { openai: { allowed_paths: [{ path, methods: ["GET", "POST"] }], allowed_models: [] } },
    });
    expect(() => validateConfig(withMethods("v1/files"))).not.toThrow();
    expect(() => validateConfig(withMethods("v1/responses"))).toThrowError("applies only to passthrough paths");
  });

  it("refuses an empty or repeated method list", () => {
    const withMethods = (methods: string[]) => serverConfig({
      proxy: { openai: { allowed_paths: [{ path: "v1/files", methods }], allowed_models: [] } },
    });
    expect(() => validateConfig(withMethods([]))).toThrow();
    expect(() => validateConfig(withMethods(["GET", "GET"]))).toThrow();
    expect(() => validateConfig(withMethods(["HEAD"]))).toThrow();
  });
});

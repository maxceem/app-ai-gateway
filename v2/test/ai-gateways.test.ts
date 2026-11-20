/**
 * Sending traffic through another AI gateway (plan step 3c, D13):
 * Cloudflare AI Gateway as a setting on a built-in provider, and Vercel AI
 * Gateway as a provider of its own. Providers are mocked at `fetch`.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import worker from "../src/index.ts";
import { billing, priceSources } from "../src/pricing/billability.ts";
import { listPrice } from "../src/pricing/prices.ts";
import { priceTokens } from "../src/pricing/tokens.ts";
import type { ConnectionRecord } from "../src/providers/connections.ts";
import { BUILT_IN_PROVIDERS } from "../src/providers/index.ts";
import { listedAs } from "../src/providers/listing.ts";
import { upstreamRequest } from "../src/providers/route.ts";
import { requestedServiceMode } from "../src/proxy/meter.ts";
import {
  clearCaches,
  LOAD_MANAGEMENT_TIMEOUT_MS,
  loadManagement,
  seedAppKey,
  seedManagementKey,
  seedRoutedApp,
} from "./helpers.ts";

beforeAll(loadManagement, LOAD_MANAGEMENT_TIMEOUT_MS);

const ORIGIN = "https://gateway.test";
const CF_TOKEN = "cf-token-secret-0042";
const PROVIDER_KEY = "sk-provider-secret-9911";

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
  clearCaches();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => vi.restoreAllMocks());

async function admin(key: string, method: string, path: string, body?: unknown) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const slugFor = (type: string) => `${type}-${crypto.randomUUID().slice(0, 6)}`;

function record(overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    id: "conn",
    accountId: "acc",
    type: "openai",
    slug: "openai",
    status: "active",
    baseUrl: null,
    secretBlob: null,
    rates: null,
    cloudflareGateway: null,
    ...overrides,
  };
}

const cloudflare = { accountId: "acct 1", gatewayId: "gw-1", tokenBlob: "", tokenHint: null };

describe("where a request goes (route.ts)", () => {
  const base = { hostKey: "main", query: "?x=1", appId: "app_1", userId: "józsef" };

  it("goes direct with the provider's key", () => {
    const target = upstreamRequest(env, record(), BUILT_IN_PROVIDERS.openai!, {
      ...base,
      path: "v1/chat/completions",
      credentials: { providerKey: PROVIDER_KEY, cloudflareToken: null },
    });
    expect(target.url).toBe("https://api.openai.com/v1/chat/completions?x=1");
    expect(target.headers).toEqual({ authorization: `Bearer ${PROVIDER_KEY}` });
  });

  it("goes through Cloudflare with its token, the provider's name, and the key when there is one", () => {
    const client = new Headers({ "cf-aig-cache-ttl": "60", "cf-aig-authorization": "Bearer stolen", "cf-aig-metadata": "{}" });
    const withKey = upstreamRequest(env, record({ cloudflareGateway: cloudflare }), BUILT_IN_PROVIDERS.openai!, {
      ...base,
      path: "v1/chat/completions",
      client,
      credentials: { providerKey: PROVIDER_KEY, cloudflareToken: CF_TOKEN },
    });
    // OpenAI's `v1/` is implied by Cloudflare's `openai` name.
    expect(withKey.url).toBe("https://gateway.ai.cloudflare.com/v1/acct%201/gw-1/openai/chat/completions?x=1");
    expect(withKey.headers["cf-aig-authorization"]).toBe(`Bearer ${CF_TOKEN}`);
    expect(withKey.headers.authorization).toBe(`Bearer ${PROVIDER_KEY}`);
    // An app may set Cloudflare's caching, never its credentials or metadata.
    expect(withKey.headers["cf-aig-cache-ttl"]).toBe("60");
    // The metadata is a valid header value whatever the user id holds.
    expect(() => new Headers({ "cf-aig-metadata": withKey.headers["cf-aig-metadata"]! })).not.toThrow();
    expect(JSON.parse(withKey.headers["cf-aig-metadata"]!)).toEqual({ app_id: "app_1", user_id: "józsef" });

    const byok = upstreamRequest(env, record({ type: "xai", cloudflareGateway: cloudflare }), BUILT_IN_PROVIDERS.xai!, {
      ...base,
      path: "v1/chat/completions",
      credentials: { providerKey: null, cloudflareToken: CF_TOKEN },
    });
    expect(byok.url).toBe("https://gateway.ai.cloudflare.com/v1/acct%201/gw-1/grok/v1/chat/completions?x=1");
    // Cloudflare uses the key in its own store.
    expect(byok.headers.authorization).toBeUndefined();
  });

  it("refuses a provider Cloudflare does not serve, and a connection with no key going direct", () => {
    expect(() =>
      upstreamRequest(env, record({ type: "groq", cloudflareGateway: cloudflare }), BUILT_IN_PROVIDERS.groq!, {
        ...base,
        path: "v1/chat/completions",
        credentials: { providerKey: null, cloudflareToken: CF_TOKEN },
      }),
    ).toThrow(/cannot be reached through Cloudflare AI Gateway/);
    expect(() =>
      upstreamRequest(env, record(), BUILT_IN_PROVIDERS.openai!, {
        ...base,
        path: "v1/chat/completions",
        credentials: { providerKey: null, cloudflareToken: null },
      }),
    ).toThrow(/credential is missing/);
  });

  it("sets Vercel's spend attribution, leaving out a user id it would refuse", () => {
    const vercel = BUILT_IN_PROVIDERS.vercel!;
    const plain = upstreamRequest(env, record({ type: "vercel" }), vercel, {
      ...base,
      userId: "user-7",
      path: "v1/chat/completions",
      credentials: { providerKey: PROVIDER_KEY, cloudflareToken: null },
    });
    expect(plain.url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions?x=1");
    expect(plain.headers).toMatchObject({ "ai-reporting-user": "user-7", "ai-reporting-tags": "app:app_1" });
    const odd = upstreamRequest(env, record({ type: "vercel" }), vercel, {
      ...base,
      path: "v1/chat/completions",
      credentials: { providerKey: PROVIDER_KEY, cloudflareToken: null },
    });
    expect(odd.headers["ai-reporting-user"]).toBeUndefined();
  });
});

describe("Vercel's models, priced and read as their provider's", () => {
  it("lists a namespaced model under its provider", () => {
    expect(listedAs("vercel", "openai/gpt-4o-mini")).toEqual({ type: "openai", model: "gpt-4o-mini" });
    expect(listedAs("vercel", "google/gemini-2.5-flash")).toEqual({ type: "gemini", model: "gemini-2.5-flash" });
    expect(listedAs("vercel", "nobody/model")).toEqual({ type: "vercel", model: "nobody/model" });
    expect(listedAs("openai", "openai/gpt-4o-mini")).toEqual({ type: "openai", model: "openai/gpt-4o-mini" });
  });

  it("prices a model from our list under its namespace's provider, and a customer's rate by Vercel's id", () => {
    const chat = BUILT_IN_PROVIDERS.vercel!.operations.find((operation) => operation.name === "vercel.chat")!;
    const listed = billing(chat, priceSources({ type: "vercel", rates: null }), "openai/gpt-4o-mini");
    expect(listed.problem).toBeNull();
    expect(listed.price?.price).toBe(listPrice("openai", "gpt-4o-mini"));
    expect(billing(chat, priceSources({ type: "vercel", rates: null }), "nobody/model").problem).toBe("no_price");
    const own = billing(chat, priceSources({ type: "vercel", rates: { "nobody/model": { input: 1, output: 2 } } }), "nobody/model");
    expect(own.price?.source).toBe("customer_rate");
  });

  it("reads Vercel's tier with the table of the model's provider", () => {
    const vercel = BUILT_IN_PROVIDERS.vercel!;
    const body = { providerOptions: { gateway: { serviceTier: "priority" } } };
    // `priority` is fast on OpenAI's models and priority on Gemini's.
    expect(requestedServiceMode(vercel, null, body, "openai/gpt-4o-mini").mode.tier).toBe("fast");
    expect(requestedServiceMode(vercel, null, body, "google/gemini-2.5-flash").mode.tier).toBe("priority");
    // A value only Vercel names keeps Vercel's meaning.
    expect(requestedServiceMode(vercel, null, { providerOptions: { gateway: { serviceTier: "default" } } }, "google/gemini-2.5-flash").mode.tier).toBe(
      "standard",
    );
  });
});

describe("Cloudflare AI Gateway on a connection, through the management API", () => {
  it("is saved with its token write-only, and needs no provider key", async () => {
    const key = await seedManagementKey();
    const created = await admin(key, "POST", "/v2/admin/providers", {
      type: "openai",
      name: "OpenAI via Cloudflare",
      slug: slugFor("openai"),
      cloudflareGateway: { accountId: "acct", gatewayId: "gw", token: CF_TOKEN },
    });
    expect(created.status).toBe(201);
    expect(created.body.provider.cloudflareGateway).toEqual({ accountId: "acct", gatewayId: "gw", tokenHint: "0042" });
    expect(created.body.provider.secretHint).toBeNull();
    expect(JSON.stringify(created.body)).not.toContain(CF_TOKEN);
  });

  it("refuses what could not be sent: no key and no gateway, a provider Cloudflare does not serve, and both a base URL and a gateway", async () => {
    const key = await seedManagementKey();
    const gateway = { accountId: "acct", gatewayId: "gw", token: CF_TOKEN };
    const noKey = await admin(key, "POST", "/v2/admin/providers", { type: "openai", name: "x", slug: slugFor("openai") });
    expect(noKey.status).toBe(400);
    const unserved = await admin(key, "POST", "/v2/admin/providers", { type: "groq", name: "x", slug: slugFor("groq"), cloudflareGateway: gateway });
    expect(unserved.status).toBe(400);
    expect(unserved.body.error.message).toMatch(/cannot be reached through Cloudflare AI Gateway/);
    const both = await admin(key, "POST", "/v2/admin/providers", {
      type: "openai",
      name: "x",
      slug: slugFor("openai"),
      secret: PROVIDER_KEY,
      baseUrl: "https://llm.example.com/",
      cloudflareGateway: gateway,
    });
    expect(both.status).toBe(400);
  });

  it("moves the key with its origin: turning the gateway on needs the key again, and off needs a key", async () => {
    const key = await seedManagementKey();
    const created = await admin(key, "POST", "/v2/admin/providers", { type: "openai", name: "x", slug: slugFor("openai"), secret: PROVIDER_KEY });
    const id = created.body.provider.id as string;
    const gateway = { accountId: "acct", gatewayId: "gw", token: CF_TOKEN };
    // A stored key is never sent to a new origin it was not given for.
    const moved = await admin(key, "PUT", `/v2/admin/providers/${id}`, { revision: 1, cloudflareGateway: gateway });
    expect(moved.status).toBe(400);
    // Dropping the key is allowed through Cloudflare, which uses its own stored keys.
    const byok = await admin(key, "PUT", `/v2/admin/providers/${id}`, { revision: 1, cloudflareGateway: gateway, secret: null });
    expect(byok.status).toBe(200);
    expect(byok.body.provider.secretHint).toBeNull();
    // A new gateway needs its token.
    const newGateway = await admin(key, "PUT", `/v2/admin/providers/${id}`, { revision: 2, cloudflareGateway: { accountId: "acct", gatewayId: "other" } });
    expect(newGateway.status).toBe(400);
    // Turning the gateway off leaves a connection with no key: refused.
    const off = await admin(key, "PUT", `/v2/admin/providers/${id}`, { revision: 2, cloudflareGateway: null });
    expect(off.status).toBe(400);
    const offWithKey = await admin(key, "PUT", `/v2/admin/providers/${id}`, { revision: 2, cloudflareGateway: null, secret: PROVIDER_KEY });
    expect(offWithKey.status).toBe(200);
    expect(offWithKey.body.provider.cloudflareGateway).toBeNull();
  });

  it("tests a key through the gateway, as live requests are sent", async () => {
    const key = await seedManagementKey();
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    const result = await admin(key, "POST", "/v2/admin/providers/test", {
      type: "anthropic",
      cloudflareGateway: { accountId: "acct", gatewayId: "gw", token: CF_TOKEN },
    });
    expect(result.body).toEqual({ validated: true });
    const [input, init] = fetchSpy.mock.calls[0]!;
    expect(String(input)).toBe("https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/models");
    const headers = new Headers(init?.headers);
    expect(headers.get("cf-aig-authorization")).toBe(`Bearer ${CF_TOKEN}`);
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("x-api-key")).toBeNull();
  });
});

describe("calls through the gateways, end to end", () => {
  async function routed(provider: Record<string, unknown>, operation: string, models: readonly string[]) {
    const key = await seedManagementKey();
    const slug = slugFor(String(provider.type));
    const created = await admin(key, "POST", "/v2/admin/providers", { name: "gw", slug, ...provider });
    expect(created.status).toBe(201);
    const appId = await seedRoutedApp(
      { type: "api_key", end_user: { source: "header", header: "x-end-user-id" } },
      { providers: { [slug]: { operations: [operation], models } } },
    );
    const { key: appKey } = await seedAppKey(appId);
    return { appId, slug, appKey };
  }

  async function call(slug: string, appKey: string, appId: string, path: string, body: Record<string, unknown>) {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v2/apps/${appId}/proxy/${slug}/${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${appKey}`, "content-type": "application/json", "x-end-user-id": "user-1" },
        body: JSON.stringify(body),
      }),
      env,
      ctx,
    );
    await response.text();
    await waitOnExecutionContext(ctx);
    return response;
  }

  async function charges(appId: string) {
    const { results } = await env.DB.prepare("SELECT * FROM charge WHERE app_id = ?").bind(appId).all();
    return results;
  }

  const usage = { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 };

  it("bills a Cloudflare-routed call from the provider's own answer", async () => {
    const { appId, slug, appKey } = await routed(
      { type: "openai", cloudflareGateway: { accountId: "acct", gatewayId: "gw", token: CF_TOKEN } },
      "openai.chat",
      ["gpt-4o-mini"],
    );
    fetchSpy.mockResolvedValue(Response.json({ id: "c1", model: "gpt-4o-mini", choices: [], usage }));
    const response = await call(slug, appKey, appId, "v1/chat/completions", { model: "gpt-4o-mini", messages: [] });
    expect(response.status).toBe(200);
    const [input, init] = fetchSpy.mock.calls[0]!;
    expect(String(input)).toBe("https://gateway.ai.cloudflare.com/v1/acct/gw/openai/chat/completions");
    expect(new Headers(init?.headers).get("cf-aig-authorization")).toBe(`Bearer ${CF_TOKEN}`);
    const rows = await charges(appId);
    expect(rows).toHaveLength(1);
    const expected = priceTokens(listPrice("openai", "gpt-4o-mini")!, { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 200 })!.cost;
    expect(Number(rows[0]!.cost_nano)).toBe(expected);
  });

  it("bills a Vercel call from our price list, under its model's provider", async () => {
    const { appId, slug, appKey } = await routed({ type: "vercel", secret: PROVIDER_KEY }, "vercel.chat", ["openai/gpt-4o-mini"]);
    fetchSpy.mockResolvedValue(Response.json({ id: "c1", model: "openai/gpt-4o-mini", choices: [], usage }));
    const response = await call(slug, appKey, appId, "v1/chat/completions", { model: "openai/gpt-4o-mini", messages: [] });
    expect(response.status).toBe(200);
    const [input, init] = fetchSpy.mock.calls[0]!;
    expect(String(input)).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${PROVIDER_KEY}`);
    expect(new Headers(init?.headers).get("ai-reporting-tags")).toBe(`app:${appId}`);
    const rows = await charges(appId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.price_source).toBe("list_rate");
    const expected = priceTokens(listPrice("openai", "gpt-4o-mini")!, { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 200 })!.cost;
    expect(Number(rows[0]!.cost_nano)).toBe(expected);
  });

  it("refuses to save a Vercel model with no price under its namespace", async () => {
    const key = await seedManagementKey();
    const slug = slugFor("vercel");
    await admin(key, "POST", "/v2/admin/providers", { type: "vercel", name: "v", slug, secret: PROVIDER_KEY });
    const saved = await admin(key, "POST", "/v2/admin/apps", {
      name: "v",
      config: { authentication: { type: "api_key", end_user: { source: "none" } }, routing: { providers: { [slug]: { operations: ["vercel.chat"], models: ["nobody/model"] } } } },
    });
    expect(saved.status).toBe(400);
    expect(saved.body.error.code).toBe("pricing_not_configured");
  });
});

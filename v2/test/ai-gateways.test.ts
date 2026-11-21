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
import { priceInServedMode, priceTokens } from "../src/pricing/tokens.ts";
import { readCloudflareGateway, type ConnectionRecord } from "../src/providers/connections.ts";
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
    servingProviders: null,
    ...overrides,
  };
}

const cloudflare = { accountId: "acct 1", gatewayId: "gw-1", tokenBlob: "", tokenHint: null };

describe("where a request goes (route.ts)", () => {
  const base = { hostKey: "main", query: "?x=1", appId: "app_1", userId: "józsef" };

  it("goes direct with the provider's key", () => {
    const target = upstreamRequest(record(), BUILT_IN_PROVIDERS.openai!, {
      ...base,
      path: "v1/chat/completions",
      credentials: { providerKey: PROVIDER_KEY, cloudflareToken: null },
    });
    expect(target.url).toBe("https://api.openai.com/v1/chat/completions?x=1");
    expect(target.headers).toEqual({ authorization: `Bearer ${PROVIDER_KEY}` });
  });

  it("goes through Cloudflare with its token, the provider's name, and the key when there is one", () => {
    const client = new Headers({ "cf-aig-cache-ttl": "60", "cf-aig-authorization": "Bearer stolen", "cf-aig-metadata": "{}" });
    const withKey = upstreamRequest(record({ cloudflareGateway: cloudflare }), BUILT_IN_PROVIDERS.openai!, {
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

    const byok = upstreamRequest(record({ type: "xai", cloudflareGateway: cloudflare }), BUILT_IN_PROVIDERS.xai!, {
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
      upstreamRequest(record({ type: "groq", cloudflareGateway: cloudflare }), BUILT_IN_PROVIDERS.groq!, {
        ...base,
        path: "v1/chat/completions",
        credentials: { providerKey: null, cloudflareToken: CF_TOKEN },
      }),
    ).toThrow(/cannot be reached through Cloudflare AI Gateway/);
    expect(() =>
      upstreamRequest(record(), BUILT_IN_PROVIDERS.openai!, {
        ...base,
        path: "v1/chat/completions",
        credentials: { providerKey: null, cloudflareToken: null },
      }),
    ).toThrow(/credential is missing/);
  });

  it("sends Anthropic's key through Cloudflare as each endpoint takes it (S3)", () => {
    const anthropic = BUILT_IN_PROVIDERS.anthropic!;
    const through = (style: "openai-chat" | "anthropic-messages") =>
      upstreamRequest(record({ type: "anthropic", cloudflareGateway: cloudflare }), anthropic, {
        ...base,
        path: style === "openai-chat" ? "v1/chat/completions" : "v1/messages",
        style,
        credentials: { providerKey: PROVIDER_KEY, cloudflareToken: CF_TOKEN },
      }).headers;
    expect(through("openai-chat")).toMatchObject({ authorization: `Bearer ${PROVIDER_KEY}` });
    expect(through("openai-chat")["x-api-key"]).toBeUndefined();
    expect(through("anthropic-messages")).toMatchObject({ "x-api-key": PROVIDER_KEY });
    expect(through("anthropic-messages").authorization).toBeUndefined();
  });

  it("names the header the key was sent in, for each endpoint, with the request it builds", () => {
    const anthropic = BUILT_IN_PROVIDERS.anthropic!;
    const sent = (cloudflareGateway: typeof cloudflare | null, style: "openai-chat" | "anthropic-messages") =>
      upstreamRequest(record({ type: "anthropic", cloudflareGateway }), anthropic, {
        ...base,
        path: "v1/chat/completions",
        style,
        credentials: { providerKey: PROVIDER_KEY, cloudflareToken: CF_TOKEN },
      }).keyHeader;
    expect(sent(cloudflare, "openai-chat")).toBe("authorization");
    expect(sent(cloudflare, "anthropic-messages")).toBe("x-api-key");
    expect(sent(null, "openai-chat")).toBe("x-api-key");
  });

  it("sets Vercel's spend attribution, leaving out a user id it would refuse", () => {
    const vercel = BUILT_IN_PROVIDERS.vercel!;
    const plain = upstreamRequest(record({ type: "vercel" }), vercel, {
      ...base,
      userId: "user-7",
      path: "v1/chat/completions",
      credentials: { providerKey: PROVIDER_KEY, cloudflareToken: null },
    });
    expect(plain.url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions?x=1");
    expect(plain.headers).toMatchObject({ "ai-reporting-user": "user-7", "ai-reporting-tags": "app:app_1" });
    const odd = upstreamRequest(record({ type: "vercel" }), vercel, {
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
    expect(requestedServiceMode(vercel, undefined, null, body, "openai/gpt-4o-mini").mode.tier).toBe("fast");
    expect(requestedServiceMode(vercel, undefined, null, body, "google/gemini-2.5-flash").mode.tier).toBe("priority");
    // The model's provider's own fields are read too, with its table (S5).
    expect(requestedServiceMode(vercel, undefined, null, { service_tier: "priority" }, "openai/gpt-4o-mini").mode.tier).toBe("fast");
    // A provider's own options never carry to another provider's model (S9).
    const anthropicFast = { providerOptions: { anthropic: { speed: "fast" } } };
    expect(requestedServiceMode(vercel, undefined, null, anthropicFast, "anthropic/claude-sonnet-5").mode.tier).toBe("fast");
    expect(requestedServiceMode(vercel, undefined, null, anthropicFast, "google/gemini-4-neon").mode.tier).toBe("standard");
    // Only the model's provider's table counts, as v1: `fast` is no Gemini tier (F3).
    const fast = requestedServiceMode(vercel, undefined, null, { providerOptions: { gateway: { serviceTier: "fast" } } }, "google/gemini-4-neon");
    expect(fast.mode.tier).toBe("standard");
    expect(fast.unknown).toBeDefined();
    // A value the provider's table lacks is unknown, at the standard floor.
    expect(requestedServiceMode(vercel, undefined, null, { providerOptions: { gateway: { serviceTier: "default" } } }, "google/gemini-2.5-flash").mode.tier).toBe(
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

  it("says what key goes with every change of Cloudflare route (S6)", async () => {
    const key = await seedManagementKey();
    const gateway = { accountId: "acct", gatewayId: "gw", token: CF_TOKEN };
    const withKey = await admin(key, "POST", "/v2/admin/providers", { type: "openai", name: "x", slug: slugFor("openai"), secret: PROVIDER_KEY, cloudflareGateway: gateway });
    const id = withKey.body.provider.id as string;
    // The key given for the gateway is never quietly re-sealed for the provider's own host.
    expect((await admin(key, "PUT", `/v2/admin/providers/${id}`, { revision: 1, cloudflareGateway: null })).status).toBe(400);
    const keyless = await admin(key, "POST", "/v2/admin/providers", { type: "openai", name: "y", slug: slugFor("openai"), cloudflareGateway: gateway });
    const other = { accountId: "acct", gatewayId: "other", token: CF_TOKEN };
    // A keyless connection says so again for a new gateway.
    expect((await admin(key, "PUT", `/v2/admin/providers/${keyless.body.provider.id}`, { revision: 1, cloudflareGateway: other })).status).toBe(400);
    expect((await admin(key, "PUT", `/v2/admin/providers/${keyless.body.provider.id}`, { revision: 1, cloudflareGateway: other, secret: null })).status).toBe(200);
  });

  it("takes no Cloudflare setting in a provider hand-off, which could not carry its token (S7)", async () => {
    const key = await seedManagementKey();
    const opened = await admin(key, "POST", "/v2/admin/provider-handoffs", {
      type: "openai",
      name: "x",
      slug: slugFor("openai"),
      cloudflareGateway: { accountId: "acct", gatewayId: "gw", token: CF_TOKEN },
    });
    expect(opened.status).toBe(400);
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
  async function routed(
    provider: Record<string, unknown>,
    operation: string,
    models: readonly string[] | undefined,
    endUserHeader = "x-end-user-id",
  ) {
    const key = await seedManagementKey();
    const slug = slugFor(String(provider.type));
    const created = await admin(key, "POST", "/v2/admin/providers", { name: "gw", slug, ...provider });
    expect(created.status).toBe(201);
    const appId = await seedRoutedApp(
      { type: "api_key", end_user: { source: "header", header: endUserHeader } },
      { providers: { [slug]: { operations: [operation], ...(models === undefined ? {} : { models }) } } },
    );
    const { key: appKey } = await seedAppKey(appId);
    return { appId, slug, appKey };
  }

  async function call(
    slug: string,
    appKey: string,
    appId: string,
    path: string,
    body: Record<string, unknown>,
    options: { headers?: Record<string, string>; environment?: Env } = {},
  ) {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}/v2/apps/${appId}/proxy/${slug}/${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${appKey}`, "content-type": "application/json", "x-end-user-id": "user-1", ...options.headers },
        body: JSON.stringify(body),
      }),
      options.environment ?? env,
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

  it("never passes back the header the key was sent in: Authorization for Anthropic's chat through Cloudflare", async () => {
    const { appId, slug, appKey } = await routed(
      { type: "anthropic", secret: PROVIDER_KEY, cloudflareGateway: { accountId: "acct", gatewayId: "gw", token: CF_TOKEN } },
      "anthropic.chat",
      ["claude-sonnet-5"],
    );
    fetchSpy.mockResolvedValue(Response.json({ id: "c1", model: "claude-sonnet-5", choices: [], usage }, { headers: { authorization: `Bearer ${PROVIDER_KEY}` } }));
    const response = await call(slug, appKey, appId, "v1/chat/completions", { model: "claude-sonnet-5", messages: [] });
    expect(response.status).toBe(200);
    expect(new Headers(fetchSpy.mock.calls[0]![1]?.headers).get("authorization")).toBe(`Bearer ${PROVIDER_KEY}`);
    expect(response.headers.get("authorization")).toBeNull();
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

  it("goes to Cloudflare whatever the Worker's variables say: only a test build can move it (S1)", async () => {
    const { appId, slug, appKey } = await routed(
      { type: "openai", cloudflareGateway: { accountId: "acct", gatewayId: "gw", token: CF_TOKEN } },
      "openai.chat",
      ["gpt-4o-mini"],
    );
    fetchSpy.mockResolvedValue(Response.json({ id: "c1", model: "gpt-4o-mini", choices: [], usage }));
    const environment = { ...env, CLOUDFLARE_AI_GATEWAY_ORIGIN: "https://attacker.example/" } as Env;
    await call(slug, appKey, appId, "v1/chat/completions", { model: "gpt-4o-mini", messages: [] }, { environment });
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://gateway.ai.cloudflare.com/v1/acct/gw/openai/chat/completions");
  });

  it("never forwards a header the app's sign-in uses, even under a Cloudflare name (S2)", async () => {
    const { appId, slug, appKey } = await routed(
      { type: "openai", cloudflareGateway: { accountId: "acct", gatewayId: "gw", token: CF_TOKEN } },
      "openai.chat",
      ["gpt-4o-mini"],
      "cf-aig-skip-cache",
    );
    fetchSpy.mockResolvedValue(Response.json({ id: "c1", model: "gpt-4o-mini", choices: [], usage }));
    await call(slug, appKey, appId, "v1/chat/completions", { model: "gpt-4o-mini", messages: [] }, { headers: { "cf-aig-skip-cache": "user-secret-id", "cf-aig-cache-ttl": "60" } });
    const headers = new Headers(fetchSpy.mock.calls[0]![1]?.headers);
    expect(headers.get("cf-aig-skip-cache")).toBeNull();
    expect(headers.get("cf-aig-cache-ttl")).toBe("60");
  });

  it("judges Vercel's fallback models as the request's own, and bills the one that served (S4)", async () => {
    const listed = await routed({ type: "vercel", secret: PROVIDER_KEY }, "vercel.chat", ["openai/gpt-4o-mini"]);
    fetchSpy.mockResolvedValue(Response.json({ id: "c1", model: "openai/gpt-4o-mini", choices: [], usage }));
    const outside = await call(listed.slug, listed.appKey, listed.appId, "v1/chat/completions", {
      model: "openai/gpt-4o-mini",
      messages: [],
      providerOptions: { gateway: { models: ["anthropic/claude-sonnet-5"] } },
    });
    expect(outside.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();

    const open = await routed({ type: "vercel", secret: PROVIDER_KEY }, "vercel.chat", undefined);
    const unpriced = await call(open.slug, open.appKey, open.appId, "v1/chat/completions", {
      model: "openai/gpt-4o-mini",
      messages: [],
      providerOptions: { gateway: { models: ["nobody/model"] } },
    });
    expect(unpriced.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockResolvedValue(Response.json({ id: "c2", model: "anthropic/claude-sonnet-5", choices: [], usage }));
    const served = await call(open.slug, open.appKey, open.appId, "v1/chat/completions", {
      model: "openai/gpt-4o-mini",
      messages: [],
      providerOptions: { gateway: { models: ["anthropic/claude-sonnet-5"] } },
    });
    expect(served.status).toBe(200);
    const rows = await charges(open.appId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.model).toBe("anthropic/claude-sonnet-5");
    const expected = priceTokens(listPrice("anthropic", "claude-sonnet-5")!, { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 200 })!.cost;
    expect(Number(rows[0]!.cost_nano)).toBe(expected);
  });

  it("finds the served model at the root of a large answer, kept or not, and marks a charge it cannot tell as an estimate (S4)", async () => {
    const open = await routed({ type: "vercel", secret: PROVIDER_KEY }, "vercel.chat", undefined);
    const fallbacks = { providerOptions: { gateway: { models: ["anthropic/claude-sonnet-5"] } } };
    // The model is at the top, then 2 MiB of content, then the usage: only the head and the tail are kept.
    const large = `{"model":"anthropic/claude-sonnet-5","choices":[{"message":{"content":"${"x".repeat(2 * 1024 * 1024)}"}}],"usage":${JSON.stringify(usage)}}`;
    fetchSpy.mockResolvedValueOnce(new Response(large, { headers: { "content-type": "application/json" } }));
    await call(open.slug, open.appKey, open.appId, "v1/chat/completions", { model: "openai/gpt-4o-mini", messages: [], ...fallbacks });
    // An answer that names no model could have been either: the request's own is charged, as an estimate.
    fetchSpy.mockResolvedValueOnce(Response.json({ id: "c3", choices: [], usage }));
    await call(open.slug, open.appKey, open.appId, "v1/chat/completions", { model: "openai/gpt-4o-mini", messages: [], ...fallbacks });
    const rows = await charges(open.appId);
    const tokens = { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 200 };
    const served = rows.find((row) => row.model === "anthropic/claude-sonnet-5")!;
    expect(Number(served.cost_nano)).toBe(priceTokens(listPrice("anthropic", "claude-sonnet-5")!, tokens)!.cost);
    const unknown = rows.find((row) => row.model === "openai/gpt-4o-mini")!;
    expect(unknown.price_is_estimate).toBe(1);
  });

  it("bills a charge it cannot tell the served model of at standard at least, though flex was asked (S4)", async () => {
    const open = await routed({ type: "vercel", secret: PROVIDER_KEY }, "vercel.chat", undefined);
    fetchSpy.mockResolvedValue(Response.json({ id: "c5", choices: [], usage }));
    // A model with a flex price, at half the standard rate.
    await call(open.slug, open.appKey, open.appId, "v1/chat/completions", {
      model: "openai/gpt-6-sol",
      messages: [],
      providerOptions: { gateway: { serviceTier: "flex", models: ["anthropic/claude-sonnet-5"] } },
    });
    const [row] = await charges(open.appId);
    const tokens = { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 200 };
    expect(Number(row!.cost_nano)).toBe(priceTokens(listPrice("openai", "gpt-6-sol")!, tokens)!.cost);
    expect(row!.price_is_estimate).toBe(1);
  });

  it("prices a fallback that served in the mode the request asks of its own provider (S9)", async () => {
    const open = await routed({ type: "vercel", secret: PROVIDER_KEY }, "vercel.chat", undefined);
    fetchSpy.mockResolvedValue(Response.json({ id: "c4", model: "google/gemini-4-neon", choices: [], usage }));
    await call(open.slug, open.appKey, open.appId, "v1/chat/completions", {
      model: "anthropic/claude-sonnet-5",
      messages: [],
      service_tier: "priority",
      providerOptions: { gateway: { models: ["google/gemini-4-neon"] } },
    });
    const rows = await charges(open.appId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.model).toBe("google/gemini-4-neon");
    // `priority` means nothing to Anthropic, but is Gemini's priority tier.
    const priority = priceInServedMode(listPrice("gemini", "gemini-4-neon")!, { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 200 }, { tier: "priority", region: "global" })!;
    expect(Number(rows[0]!.cost_nano)).toBe(priority.cost);
    expect(rows[0]!.price_is_estimate).toBe(0);
  });

  it("pins a Vercel connection's serving providers over the app's own value (F5, v1's providerOnly)", async () => {
    const pinned = await routed({ type: "vercel", secret: PROVIDER_KEY, servingProviders: ["bedrock", "vertex"] }, "vercel.chat", ["openai/gpt-4o-mini"]);
    fetchSpy.mockResolvedValue(Response.json({ id: "c6", model: "openai/gpt-4o-mini", choices: [], usage }));
    await call(pinned.slug, pinned.appKey, pinned.appId, "v1/chat/completions", {
      model: "openai/gpt-4o-mini",
      messages: [],
      providerOptions: { gateway: { only: ["anthropic"], order: ["x"] } },
    });
    const sentBody = JSON.parse(new TextDecoder().decode(fetchSpy.mock.calls[0]![1]?.body as Uint8Array)) as Record<string, any>;
    expect(sentBody.providerOptions.gateway).toEqual({ only: ["bedrock", "vertex"], order: ["x"] });
    const key = await seedManagementKey();
    const refused = await admin(key, "POST", "/v2/admin/providers", { type: "openai", name: "x", slug: slugFor("openai"), secret: PROVIDER_KEY, servingProviders: ["a"] });
    expect(refused.status).toBe(400);
  });

  it("reads an unreadable Cloudflare setting as none, and logs it (F4)", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(readCloudflareGateway("{not json")).toBeNull();
    expect(errors.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining("cloudflare_gateway_unreadable"));
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

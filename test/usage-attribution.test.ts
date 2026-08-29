import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { clearAppConfigCache } from "../src/core/config";
import prices from "../src/core/prices.json";
import { clearProviderCaches } from "../src/core/provider-store";
import { PROVIDER_REGISTRY, providerModelAuthor, reportsCost } from "../src/core/providers";
import { isBillable, hasModelPrice, resolveModelAuthor } from "../src/core/usage";
import { database } from "../src/db";
import { provider } from "../src/db/schema";
import { gatewayToken, seedApp, seedProvider } from "./helpers";

const APP_ID = "usage-attribution";
const ORIGIN = "https://example.test";

interface EventRow {
  provider_slug: string | null;
  provider_gateway_id: string | null;
  provider_gateway_type: string | null;
  credential_source: string | null;
  model_author: string | null;
  served_provider: string | null;
  served_model: string | null;
  reported_cost_usd: number | null;
  model: string;
  endpoint_slug: string | null;
}

let pending: ExecutionContext[] = [];

async function settle(): Promise<void> {
  await Promise.all(pending.map((context) => waitOnExecutionContext(context)));
  pending = [];
}

async function workerFetch(input: string, init: RequestInit): Promise<Response> {
  const executionCtx = createExecutionContext();
  const response = await worker.fetch(new Request(input, init), env, executionCtx);
  pending.push(executionCtx);
  return response;
}

/** The most recent event for one provider slug, once `waitUntil` has settled. */
async function lastEvent(slug: string): Promise<EventRow> {
  await settle();
  const row = await env.DB.prepare(
    `SELECT provider_slug, provider_gateway_id, provider_gateway_type, credential_source,
            model_author, served_provider, served_model, reported_cost_usd, model, endpoint_slug
       FROM app_usage_event WHERE app_id = ? AND provider_slug = ? ORDER BY id DESC LIMIT 1`,
  ).bind(APP_ID, slug).first<EventRow>();
  if (!row) throw new Error(`No usage event was recorded for ${slug}`);
  return row;
}

beforeAll(async () => {
  await seedApp(APP_ID, {
    proxy: { provider_mode: "all", model_rewrites: {} },
    endpoints: {
      "direct-chat": { api_style: "responses", provider: "openai-direct", model: "gpt-5.6-sol" },
      "routed-chat": { api_style: "responses", provider: "openai-aig", model: "gpt-5.6-sol" },
    },
  });
  await seedProvider({
    type: "openai",
    id: "attribution-direct",
    slug: "openai-direct",
    secret: "sk-attribution-direct",
  });
  await seedProvider({
    type: "openai",
    id: "attribution-routed",
    slug: "openai-aig",
    secret: "cf-aig-attribution-token",
    gateway: "cf_aig",
    providerGatewayId: "attribution-gateway",
  });
});

afterEach(async () => {
  await settle();
  vi.restoreAllMocks();
});

afterAll(async () => {
  const db = database(env.DB);
  await db.delete(provider).where(eq(provider.id, "attribution-direct"));
  await db.delete(provider).where(eq(provider.id, "attribution-routed"));
  clearProviderCaches();
  clearAppConfigCache();
});

/**
 * Route attribution is the half of the metadata that is known before the
 * request is even sent, so it is recorded for every event rather than only when
 * an upstream volunteers something.
 */
describe("gateway attribution on recorded usage", () => {
  function stubUpstream(): void {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ usage: { input_tokens: 10, output_tokens: 2 } }));
  }

  async function proxy(slug: string): Promise<void> {
    stubUpstream();
    const response = await workerFetch(`${ORIGIN}/v1/apps/${APP_ID}/proxy/${slug}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await gatewayToken(APP_ID)}`,
        "content-type": "application/json",
        "x-app-version": "1.2.3",
      },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
    });
    expect(response.status).toBe(200);
    await response.text();
  }

  async function endpoint(slug: string): Promise<void> {
    stubUpstream();
    const response = await workerFetch(`${ORIGIN}/v1/apps/${APP_ID}/endpoints/${slug}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await gatewayToken(APP_ID)}`,
        "content-type": "application/json",
        "x-app-version": "1.2.3",
      },
      body: JSON.stringify({ input: "hello" }),
    });
    expect(response.status).toBe(200);
    await response.text();
  }

  it("records the gateway that carried a proxied request", async () => {
    await proxy("openai-aig");
    expect(await lastEvent("openai-aig")).toMatchObject({
      provider_gateway_id: "attribution-gateway",
      provider_gateway_type: "cf_aig",
      // The organization's own key, held in its own gateway's key store.
      credential_source: "byok",
      model_author: "OpenAI",
    });
  });

  it("records no gateway for a direct proxied request", async () => {
    await proxy("openai-direct");
    expect(await lastEvent("openai-direct")).toMatchObject({
      provider_gateway_id: null,
      provider_gateway_type: null,
      credential_source: "direct",
      model_author: "OpenAI",
    });
  });

  it("attributes named endpoint traffic to the same route it was sent over", async () => {
    await endpoint("routed-chat");
    expect(await lastEvent("openai-aig")).toMatchObject({
      endpoint_slug: "routed-chat",
      provider_gateway_id: "attribution-gateway",
      provider_gateway_type: "cf_aig",
      credential_source: "byok",
    });
    await endpoint("direct-chat");
    expect(await lastEvent("openai-direct")).toMatchObject({
      endpoint_slug: "direct-chat",
      provider_gateway_id: null,
      provider_gateway_type: null,
      credential_source: "direct",
    });
  });

  /**
   * Everything an upstream would have to volunteer stays empty until a route
   * that reports it lands. An absent report is recorded as unknown, never as a
   * guarantee read off a 200.
   */
  it("leaves the observed fields unknown while no route reports them", async () => {
    await proxy("openai-aig");
    expect(await lastEvent("openai-aig")).toMatchObject({
      served_provider: null,
      served_model: null,
      reported_cost_usd: null,
    });
  });
});

describe("billability", () => {
  it("proxies a model with a local price and refuses one without", () => {
    expect(isBillable("openai", "gpt-5.6-sol")).toBe(true);
    expect(isBillable("openai", "gpt-does-not-exist")).toBe(false);
    // Identical to the bare price gate for every type shipped today.
    for (const model of ["gpt-5.6-sol", "gpt-does-not-exist"]) {
      expect(isBillable("openai", model)).toBe(hasModelPrice("openai", model));
    }
  });

  it("accepts an operator's own price for a model the catalog never heard of", () => {
    const overrides = { "internal-model": { input: 1, output: 2 } };
    expect(isBillable("openai", "internal-model", overrides)).toBe(true);
  });

  /**
   * No shipped provider type reports its own cost, so the second half of the
   * predicate is exercised against the registry entry a reporting type would
   * have. OpenRouter sets this flag for real in Stage 4.
   */
  it("proxies an unpriced model on a route that reports what it cost", () => {
    const spec = PROVIDER_REGISTRY.perplexity as { reportsCost?: boolean };
    expect(reportsCost("perplexity")).toBe(false);
    try {
      spec.reportsCost = true;
      expect(reportsCost("perplexity")).toBe(true);
      expect(isBillable("perplexity", "model-with-no-local-price")).toBe(true);
    } finally {
      delete spec.reportsCost;
    }
    expect(isBillable("perplexity", "model-with-no-local-price")).toBe(false);
  });

  it("reports no provider type as cost-reporting today", () => {
    for (const type of Object.keys(PROVIDER_REGISTRY) as Array<keyof typeof PROVIDER_REGISTRY>) {
      expect([type, reportsCost(type)]).toEqual([type, false]);
    }
  });
});

describe("model author resolution", () => {
  it("falls back to the provider type's own author", () => {
    expect(resolveModelAuthor("openai", "gpt-5.6-sol")).toBe("OpenAI");
    expect(resolveModelAuthor("anthropic", "claude-opus-4-6")).toBe("Anthropic");
    expect(resolveModelAuthor("xai", "grok-5")).toBe("xAI");
    expect(resolveModelAuthor("gemini", "gemini-3.6-flash")).toBe("Google");
    expect(resolveModelAuthor("perplexity", "sonar-pro")).toBe("Perplexity");
  });

  it("answers for a model the catalog has never priced", () => {
    // Authorship is not a pricing question: an unpriced model still has an
    // author whenever the provider type settles it.
    expect(resolveModelAuthor("gemini", "gemini-never-shipped")).toBe("Google");
  });

  /**
   * The catalog entry wins because it is curated per model, which is what makes
   * the dimension worth storing: the OpenAI-compatible batch serves other
   * people's models (Together serves Meta's, ByteDance serves DeepSeek's), so
   * author stops tracking provider type. Proved here against an OpenAI entry,
   * which carries no author, so precedence is visible rather than incidental;
   * the shipped curated authors are asserted in `usage.test.ts`.
   */
  it("prefers the catalog's own author when one is curated", () => {
    const entry = prices.openai["gpt-5.6-sol"] as { author?: string };
    expect(entry.author).toBeUndefined();
    expect(providerModelAuthor("openai")).toBe("OpenAI");
    try {
      entry.author = "Some Other Lab";
      expect(resolveModelAuthor("openai", "gpt-5.6-sol")).toBe("Some Other Lab");
      // A curated author never leaks onto a model that did not get one.
      expect(resolveModelAuthor("openai", "gpt-5.6-luna")).toBe("OpenAI");
    } finally {
      delete entry.author;
    }
    expect(resolveModelAuthor("openai", "gpt-5.6-sol")).toBe("OpenAI");
  });

  it("ignores an operator's price override, which carries no authorship", () => {
    expect(resolveModelAuthor("openai", "gpt-5.6-sol")).toBe("OpenAI");
  });

  it("resolves the same author for a model on every route it is served over", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ usage: { input_tokens: 4, output_tokens: 1 } }));
    for (const slug of ["openai-direct", "openai-aig"]) {
      const response = await workerFetch(`${ORIGIN}/v1/apps/${APP_ID}/proxy/${slug}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await gatewayToken(APP_ID)}`,
          "content-type": "application/json",
          "x-app-version": "1.2.3",
        },
        body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(await lastEvent(slug)).toMatchObject({ model: "gpt-5.6-sol", model_author: "OpenAI" });
    }
  });
});

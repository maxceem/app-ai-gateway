import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { clearAppConfigCache } from "../src/core/config";
import prices from "../src/core/prices.json";
import { clearProviderCaches } from "../src/core/provider-store";
import { PROVIDER_REGISTRY, providerModelAuthor, reportsCost } from "../src/core/providers";
import { isBillable, hasModelPrice, observeResponse, resolveModelAuthor } from "../src/core/usage";
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
  cost_usd: number;
  cost_source: string | null;
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
            model_author, served_provider, served_model, reported_cost_usd, cost_usd,
            cost_source, model, endpoint_slug
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
  // One canonical model, three routes. Prices, allowlists, and recorded usage
  // must agree across all of them; only the wire body may differ.
  await seedProvider({
    type: "gemini",
    id: "attribution-gemini-direct",
    slug: "gemini-direct",
    secret: "sk-gemini-direct",
  });
  await seedProvider({
    type: "gemini",
    id: "attribution-gemini-cf",
    slug: "gemini-cf",
    secret: "cf-aig-gemini-token",
    gateway: "cf_aig",
    providerGatewayId: "attribution-gemini-cf-gateway",
  });
  await seedProvider({
    type: "gemini",
    id: "attribution-gemini-vercel",
    slug: "gemini-vercel",
    secret: "vck_gemini_token",
    gateway: "vercel",
    providerGatewayId: "attribution-vercel-gateway",
  });
  await seedProvider({
    type: "gemini",
    id: "attribution-gemini-vercel-pinned",
    slug: "gemini-vercel-pinned",
    secret: "vck_gemini_token",
    providerGatewayId: "attribution-vercel-gateway",
    gatewayRoute: { providerOnly: ["vertex"] },
  });
  await seedProvider({
    type: "openrouter",
    id: "attribution-openrouter",
    slug: "openrouter-reported",
    secret: "sk-or-attribution",
  });
  // The same aggregator with a local price of its own, which is what a
  // missing cost report falls back to.
  await seedProvider({
    type: "openrouter",
    id: "attribution-openrouter-priced",
    slug: "openrouter-priced",
    secret: "sk-or-attribution-priced",
    pricing: { "google/gemini-3.6-flash": { input: 1, output: 2 } },
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
  await db.delete(provider).where(eq(provider.id, "attribution-openrouter"));
  await db.delete(provider).where(eq(provider.id, "attribution-openrouter-priced"));
  for (const id of [
    "attribution-gemini-direct",
    "attribution-gemini-cf",
    "attribution-gemini-vercel",
    "attribution-gemini-vercel-pinned",
  ]) {
    await db.delete(provider).where(eq(provider.id, id));
  }
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

/**
 * The plan's central claim, end to end: one canonical model ID priced and
 * recorded identically on three routes, with the namespace living only on the
 * wire — and an OpenAI payload reaching Vercel as an OpenAI payload, because
 * this gateway never converts between provider protocols.
 */
describe("canonical model identity across direct, cf_aig, and vercel routes", () => {
  const MODEL = "gemini-2.5-flash";
  let sent: { url: string; headers: Headers; body: unknown }[] = [];

  function stubUpstream(): void {
    sent = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      sent.push({
        url: typeof request === "string" ? request : String(request),
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
      });
      return Response.json({
        // Echoed back namespaced, exactly as Vercel does: the recorded model
        // must come back canonical.
        model: "google/gemini-2.5-flash",
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      });
    });
  }

  /** The same OpenAI chat-completions request, whichever instance carries it. */
  async function chat(slug: string, body?: Record<string, unknown>): Promise<Response> {
    stubUpstream();
    const response = await workerFetch(
      `${ORIGIN}/v1/apps/${APP_ID}/proxy/${slug}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await gatewayToken(APP_ID)}`,
          "content-type": "application/json",
          "x-app-version": "1.2.3",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: "hello" }],
          ...body,
        }),
      },
    );
    await response.text();
    return response;
  }

  it("prices and records one canonical model identically on all three routes", async () => {
    const recorded: Record<string, EventRow> = {};
    for (const slug of ["gemini-direct", "gemini-cf", "gemini-vercel"]) {
      expect([slug, (await chat(slug)).status]).toEqual([slug, 200]);
      recorded[slug] = await lastEvent(slug);
    }
    for (const slug of ["gemini-cf", "gemini-vercel"]) {
      expect([slug, recorded[slug]!.cost_usd]).toEqual([slug, recorded["gemini-direct"]!.cost_usd]);
      expect([slug, recorded[slug]!.model]).toEqual([slug, MODEL]);
      expect([slug, recorded[slug]!.cost_source]).toEqual([slug, "computed"]);
      expect([slug, recorded[slug]!.model_author]).toEqual([slug, "Google"]);
    }
    // A real number, not two matching zeroes.
    expect(recorded["gemini-direct"]!.cost_usd).toBeGreaterThan(0);
  });

  it("puts the namespace on the wire and nowhere else", async () => {
    await chat("gemini-vercel");
    expect(sent[0]!.url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
    expect(sent[0]!.body).toMatchObject({ model: "google/gemini-2.5-flash" });
    // Recorded canonical, from a response that named the model the other way.
    expect(await lastEvent("gemini-vercel")).toMatchObject({
      model: MODEL,
      provider_gateway_id: "attribution-vercel-gateway",
      provider_gateway_type: "vercel",
      // Vercel documents BYOK as preferred with a fallback to its own
      // credentials, so no route-level guarantee exists to record.
      credential_source: null,
    });

    // The other two routes speak the provider's own IDs verbatim.
    await chat("gemini-cf");
    expect(sent[0]!.body).toMatchObject({ model: MODEL });
    await chat("gemini-direct");
    expect(sent[0]!.body).toMatchObject({ model: MODEL });
  });

  it("forwards an OpenAI payload unchanged apart from the model rewrite", async () => {
    const extras = {
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.3,
      stream: false,
      tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
      response_format: { type: "json_object" },
    };
    await chat("gemini-vercel", extras);
    // No conversion to Gemini's `contents`/`generationConfig`, no fields added
    // or dropped: Vercel translates once, downstream of this gateway.
    expect(sent[0]!.body).toEqual({ ...extras, model: "google/gemini-2.5-flash" });
  });

  it("applies a row's provider pin as a same-protocol body option", async () => {
    await chat("gemini-vercel-pinned");
    expect(sent[0]!.body).toMatchObject({
      model: "google/gemini-2.5-flash",
      providerOptions: { gateway: { only: ["vertex"] } },
    });
    // The unpinned row on the same gateway is left alone.
    await chat("gemini-vercel");
    expect(sent[0]!.body).not.toHaveProperty("providerOptions");
  });

  it("refuses an API Vercel does not serve for this provider", async () => {
    stubUpstream();
    const response = await workerFetch(
      `${ORIGIN}/v1/apps/${APP_ID}/proxy/gemini-vercel/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await gatewayToken(APP_ID)}`,
          "content-type": "application/json",
          "x-app-version": "1.2.3",
        },
        body: JSON.stringify({ contents: [] }),
      },
    );
    expect(response.status).toBe(403);
    expect((await response.json() as { error: { code: string } }).error.code)
      .toBe("api_style_not_supported");
    // Refused at the edge: nothing was sent upstream to be 404ed.
    expect(sent).toEqual([]);

    // The same request on the same provider type goes through on cf_aig, which
    // forwards to Gemini's own API and so does carry the native operation.
    const native = await workerFetch(
      `${ORIGIN}/v1/apps/${APP_ID}/proxy/gemini-cf/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await gatewayToken(APP_ID)}`,
          "content-type": "application/json",
          "x-app-version": "1.2.3",
        },
        body: JSON.stringify({ contents: [] }),
      },
    );
    expect(native.status).toBe(200);
    await native.text();
  });
});

/**
 * The reported-cost route, end to end. What makes it worth an integration test
 * rather than a unit one: the figure the gateway bills, the metadata it stores,
 * and the request mutation that asks for both all have to survive the same
 * request, and the whole point of the type is that no local price is involved.
 */
describe("OpenRouter reported-cost metering", () => {
  const MODEL = "google/gemini-3.6-flash";
  let sent: { url: string; headers: Headers; body: unknown }[] = [];

  /** One upstream response, with the outbound request captured for assertions. */
  function stubOpenRouter(body: string, contentType = "application/json"): void {
    sent = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      sent.push({
        url: typeof request === "string" ? request : String(request),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as unknown,
      });
      return new Response(body, { headers: { "content-type": contentType } });
    });
  }

  async function proxy(slug: string, requestBody: Record<string, unknown> = {}): Promise<void> {
    const response = await workerFetch(
      `${ORIGIN}/v1/apps/${APP_ID}/proxy/${slug}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await gatewayToken(APP_ID)}`,
          "content-type": "application/json",
          "x-app-version": "1.2.3",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: "hello" }],
          ...requestBody,
        }),
      },
    );
    expect(response.status).toBe(200);
    await response.text();
  }

  /** A complete OpenRouter chat completion, as its own schema documents one. */
  function completion(usage: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      id: "gen-1",
      object: "chat.completion",
      model: MODEL,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, ...usage },
      openrouter_metadata: {
        requested: MODEL,
        strategy: "direct",
        endpoints: { total: 1, available: [{ provider: "Google", model: MODEL, selected: true }] },
      },
      ...extra,
    });
  }

  it("bills what OpenRouter says the request cost, not what a catalog guesses", async () => {
    stubOpenRouter(completion({ cost: 0.001234, is_byok: false }));
    await proxy("openrouter-reported");
    expect(await lastEvent("openrouter-reported")).toMatchObject({
      cost_usd: 0.001234,
      reported_cost_usd: 0.001234,
      cost_source: "reported",
      // The slug is the canonical model here: nothing strips its namespace.
      model: MODEL,
      served_model: MODEL,
      served_provider: "Google",
      // Author read off the slug, since no catalog entry prices this model.
      model_author: "Google",
      // OpenRouter's own key paid the inference, so the operator's did not.
      credential_source: null,
    });
  });

  it("reads the cost out of the final chunk of a stream", async () => {
    const chunk = (extra: Record<string, unknown>) =>
      `data: ${JSON.stringify({
        id: "gen-2",
        object: "chat.completion.chunk",
        model: MODEL,
        choices: [{ index: 0, delta: { content: "hi" } }],
        ...extra,
      })}\n\n`;
    stubOpenRouter(
      [
        chunk({}),
        chunk({
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12, cost: 0.00042 },
          openrouter_metadata: {
            endpoints: { total: 2, available: [
              { provider: "Vertex", model: MODEL, selected: false },
              { provider: "Google AI Studio", model: MODEL, selected: true },
            ] },
          },
        }),
        "data: [DONE]\n\n",
      ].join(""),
      "text/event-stream",
    );
    await proxy("openrouter-reported", { stream: true });
    expect(await lastEvent("openrouter-reported")).toMatchObject({
      cost_usd: 0.00042,
      reported_cost_usd: 0.00042,
      cost_source: "reported",
      served_provider: "Google AI Studio",
    });
  });

  /**
   * The BYOK ledger, which is two ledgers. `usage.cost` is only what OpenRouter
   * charged — its 5% BYOK fee — and the upstream provider bills the operator's
   * own key separately, reported under `cost_details.upstream_inference_cost`.
   * Both are the operator's money, so both debit the budget; billing the fee
   * alone let the inference through unmetered.
   */
  it("bills OpenRouter's fee plus the upstream charge on a byok request", async () => {
    stubOpenRouter(completion({
      cost: 0.000155,
      is_byok: true,
      cost_details: { upstream_inference_cost: 0.0031 },
    }));
    await proxy("openrouter-reported");
    expect(await lastEvent("openrouter-reported")).toMatchObject({
      credential_source: "byok",
      cost_source: "reported",
      // 0.000155 + 0.0031, not either one alone.
      cost_usd: 0.003255,
      reported_cost_usd: 0.003255,
    });
  });

  it("sums the same two figures out of the final chunk of a byok stream", async () => {
    const chunk = (extra: Record<string, unknown>) =>
      `data: ${JSON.stringify({
        id: "gen-byok",
        object: "chat.completion.chunk",
        model: MODEL,
        choices: [{ index: 0, delta: { content: "hi" } }],
        ...extra,
      })}\n\n`;
    stubOpenRouter(
      [
        chunk({}),
        chunk({
          usage: {
            prompt_tokens: 8,
            completion_tokens: 4,
            cost: 0.0001,
            is_byok: true,
            cost_details: { upstream_inference_cost: 0.002 },
          },
        }),
        "data: [DONE]\n\n",
      ].join(""),
      "text/event-stream",
    );
    await proxy("openrouter-reported", { stream: true });
    expect(await lastEvent("openrouter-reported")).toMatchObject({
      cost_usd: 0.0021,
      reported_cost_usd: 0.0021,
      cost_source: "reported",
      credential_source: "byok",
    });
  });

  /**
   * A client that hangs up before the final chunk takes the cost report with it.
   * The known limitation this deployment does not yet reconcile: the event is
   * recorded unresolved rather than billed as free, which is what makes a rising
   * unresolved count the operator's signal that it is happening.
   */
  it("records an aborted stream as unresolved rather than free", async () => {
    const chunk = (extra: Record<string, unknown>) =>
      `data: ${JSON.stringify({
        id: "gen-cut",
        object: "chat.completion.chunk",
        model: MODEL,
        choices: [{ index: 0, delta: { content: "hi" } }],
        ...extra,
      })}\n\n`;
    // Truncated mid-stream: deltas, then nothing. No usage event, no `[DONE]`.
    stubOpenRouter([chunk({}), chunk({}), "data: {\"id\":\"gen-c"].join(""), "text/event-stream");
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    await proxy("openrouter-reported", { stream: true });
    expect(await lastEvent("openrouter-reported")).toMatchObject({
      cost_usd: 0,
      reported_cost_usd: null,
      cost_source: "unresolved",
    });
    // Surfaced, not swallowed: the operator's only signal for this today.
    expect(logs.mock.calls.flat().join(" ")).toContain("usage_unresolved_cost");
  });

  /**
   * The fail-closed half. This route is billable *because* it reports a cost,
   * so a response without one is an unknown, never a free request.
   */
  it("marks a response with no cost report unresolved rather than free", async () => {
    stubOpenRouter(completion({}));
    await proxy("openrouter-reported");
    expect(await lastEvent("openrouter-reported")).toMatchObject({
      cost_usd: 0,
      reported_cost_usd: null,
      cost_source: "unresolved",
      // The tokens were readable and are kept; only the cost is missing.
      served_provider: "Google",
    });
  });

  it("falls back to a local price when one exists and no cost was reported", async () => {
    stubOpenRouter(completion({}));
    await proxy("openrouter-priced");
    expect(await lastEvent("openrouter-priced")).toMatchObject({
      // 100 input at $1/M plus 20 output at $2/M.
      cost_usd: 0.00014,
      reported_cost_usd: null,
      cost_source: "computed",
    });
  });

  /**
   * The routing metadata is opt-in per request and the cost is not: OpenRouter
   * documents accounting as always on and `usage.include` as a deprecated
   * no-op. So the header is asked for and the body is not rewritten — the
   * injection this used to assert re-serialized every chat body for a field
   * nothing reads.
   */
  it("asks for the routing metadata by header and leaves the body alone", async () => {
    stubOpenRouter(completion({ cost: 0.5 }));
    const body = { usage: { include: false, extra: "kept" }, temperature: 0.4 };
    await proxy("openrouter-reported", body);
    expect(sent[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    // Byte-for-byte what the client sent, model included: nothing on this route
    // has a namespace to add or a field to set.
    expect(sent[0]?.body).toEqual({
      model: MODEL,
      messages: [{ role: "user", content: "hello" }],
      ...body,
    });
    expect(sent[0]?.headers.get("x-openrouter-metadata")).toBe("enabled");
    expect(sent[0]?.headers.get("authorization")).toBe("Bearer sk-or-attribution");
    // And the cost still lands, which is the point of not needing the field.
    expect(await lastEvent("openrouter-reported")).toMatchObject({
      cost_usd: 0.5,
      cost_source: "reported",
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
   * Billability derives from the cost-report *declaration*, not from a flag
   * beside one. A type that says how to read its own cost may proxy an unpriced
   * model; there is no way to claim the first without supplying the second.
   */
  it("proxies an unpriced model on a route that declares how it reports cost", () => {
    const spec = PROVIDER_REGISTRY.perplexity as { costReport?: unknown };
    expect(reportsCost("perplexity")).toBe(false);
    try {
      spec.costReport = { read: () => false };
      expect(reportsCost("perplexity")).toBe(true);
      expect(isBillable("perplexity", "model-with-no-local-price")).toBe(true);
    } finally {
      delete spec.costReport;
    }
    expect(isBillable("perplexity", "model-with-no-local-price")).toBe(false);
  });

  /**
   * The refactor's whole point. A hypothetical reporting type gets *its own*
   * parser called and nothing else: before this, a bare `reportsCost` flag
   * switched on OpenRouter's field names for whoever set it, so a second
   * reporting provider would have bypassed the price gate and then recorded
   * every one of its requests unresolved.
   */
  it("never reads one provider's report fields out of another's response", () => {
    const spec = PROVIDER_REGISTRY.perplexity as { costReport?: unknown };
    // A body in OpenRouter's exact shape, answered by a different type.
    const openRouterShaped = JSON.stringify({
      model: "sonar-pro",
      usage: { prompt_tokens: 10, completion_tokens: 2, cost: 9.99 },
      openrouter_metadata: {
        endpoints: { available: [{ provider: "Someone Else", selected: true }] },
      },
    });
    try {
      const seen: string[] = [];
      spec.costReport = {
        // Reads a field only this hypothetical provider sends, and pointedly
        // not `usage.cost`.
        read: (value: Record<string, unknown>, report: { costUsd: number | null }) => {
          seen.push("read");
          const own = (value as { billing?: { total?: number } }).billing?.total;
          if (typeof own !== "number") return false;
          report.costUsd = own;
          return true;
        },
      };
      const other = observeResponse(openRouterShaped, "application/json", "perplexity");
      // Its own parser ran; OpenRouter's `usage.cost` and metadata were not read.
      expect(seen).toEqual(["read"]);
      expect(other.report).toBeNull();
      // Usage parsing is shape-sniffed and unaffected, as it always was.
      expect(other.usage?.inputTokens).toBe(10);

      // The same declaration, given the body it does understand.
      const own = observeResponse(
        JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 }, billing: { total: 7 } }),
        "application/json",
        "perplexity",
      );
      expect(own.report?.costUsd).toBe(7);
    } finally {
      delete spec.costReport;
    }
    // And OpenRouter's own parser still reads OpenRouter's own body.
    expect(observeResponse(openRouterShaped, "application/json", "openrouter").report)
      .toMatchObject({ costUsd: 9.99, servedProvider: "Someone Else" });
  });

  /**
   * Cost reporting is a claim about one upstream's responses, so it stays an
   * explicit per-type fact rather than an assumption: every type but the
   * aggregator that really returns `usage.cost` bills on a local price.
   */
  it("reports only OpenRouter as cost-reporting", () => {
    for (const type of Object.keys(PROVIDER_REGISTRY) as Array<keyof typeof PROVIDER_REGISTRY>) {
      expect([type, reportsCost(type)]).toEqual([type, type === "openrouter"]);
    }
    // Which is what makes an unpriced OpenRouter slug proxy at all: nothing in
    // the shipped catalog prices one.
    expect(hasModelPrice("openrouter", "google/gemini-3.6-flash")).toBe(false);
    expect(isBillable("openrouter", "google/gemini-3.6-flash")).toBe(true);
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

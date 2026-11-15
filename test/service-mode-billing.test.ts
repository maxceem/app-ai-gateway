import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { gatewayToken, seedApp, seedProvider, signRequest } from "./helpers";
import type { ProviderPricing } from "../src/db/schema";

/**
 * A request is billed in the service mode that served it: the mode the
 * response names, else the one the request asked for, with the region of the
 * row's base URL. Each test prices one model by an override with `modes`, so
 * the arithmetic is the test's own and not the price list's.
 */

let pending: ExecutionContext[] = [];

afterEach(async () => {
  await Promise.all(pending.map((context) => waitOnExecutionContext(context)));
  pending = [];
  vi.restoreAllMocks();
});

async function send(appId: string, path: string, body: Record<string, unknown>): Promise<Response> {
  const context = createExecutionContext();
  const request = new Request(`https://example.test/v1/apps/${appId}/proxy/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-app-version": "1.2.3",
      authorization: `Bearer ${await gatewayToken(appId)}`,
    },
    body: JSON.stringify(body),
  });
  const response = await app.fetch(await signRequest(request), env, context);
  pending.push(context);
  return new Response(await response.arrayBuffer(), response);
}

async function recorded(appId: string) {
  await Promise.all(pending.map((context) => waitOnExecutionContext(context)));
  pending = [];
  const row = await env.DB.prepare("SELECT cost_usd, service_mode FROM app_usage_event WHERE app_id = ?")
    .bind(appId)
    .first<{ cost_usd: number; service_mode: string | null }>();
  return { cost: row?.cost_usd, mode: row?.service_mode ? JSON.parse(row.service_mode) as unknown : null };
}

function warnings(): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
    if (typeof line !== "string") return;
    try {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Not one of ours.
    }
  });
  return lines;
}

/** An app on its own provider row of `type`, priced by `pricing`. */
async function seeded(type: "openai" | "anthropic" | "gemini", pricing: ProviderPricing, baseUrl?: string) {
  const appId = `mode-billing-${crypto.randomUUID()}`;
  const slug = `${type}-${appId.slice(-12)}`;
  await seedApp(appId, { proxy: { provider_mode: "all", model_rewrites: {} } });
  await seedProvider({ type, id: `${appId}-provider`, slug, pricing, ...(baseUrl && { baseUrl }) });
  return { appId, slug };
}

// $1 in, $4 out per 1M tokens: 1,000 of each costs $0.005 in the standard mode.
const OPENAI_PRICING: ProviderPricing = {
  "gpt-5.6-sol": {
    input: 1,
    output: 4,
    modes: { flex: { factor: 0.5 }, fast: { factor: 2 }, us: { factor: 1.1 } },
  },
};

function openAiAnswer(serviceTier?: string) {
  return {
    object: "response",
    ...(serviceTier && { service_tier: serviceTier }),
    usage: { input_tokens: 1000, output_tokens: 1000 },
  };
}

describe("billing in the service mode that served the request", () => {
  it.each([
    ["flex, as asked", { service_tier: "flex" }, "flex", 0.0025, { tier: "flex" }],
    ["fast, as asked", { service_tier: "priority" }, "priority", 0.01, { tier: "fast" }],
    ["standard, where fast was shed to it", { service_tier: "fast" }, "default", 0.005, null],
    ["fast, from a project default the request never showed", {}, "priority", 0.01, { tier: "fast" }],
    ["the requested mode, where the response names none", { service_tier: "flex" }, undefined, 0.0025, { tier: "flex" }],
  ])("bills OpenAI %s", async (_label, fields, served, cost, mode) => {
    const { appId, slug } = await seeded("openai", OPENAI_PRICING);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(openAiAnswer(served)));
    const lines = warnings();

    const response = await send(appId, `${slug}/v1/responses`, { model: "gpt-5.6-sol", input: "hi", ...fields });

    expect(response.status).toBe(200);
    const row = await recorded(appId);
    expect(row.cost).toBeCloseTo(cost, 10);
    expect(row.mode).toEqual(mode);
    expect(lines.filter((line) => String(line.message).startsWith("service_mode_"))).toEqual([]);
  });

  it("adds the region of a regional base URL", async () => {
    const appId = `mode-billing-${crypto.randomUUID()}`;
    const slug = `together-${appId.slice(-12)}`;
    await seedApp(appId, { proxy: { provider_mode: "all", model_rewrites: {} } });
    await seedProvider({
      type: "together",
      id: `${appId}-provider`,
      slug,
      baseUrl: "https://us-api.together.ai/",
      pricing: { "zai-org/GLM-5.3": { input: 1, output: 4, modes: { us: { factor: 1.25 } } } },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ usage: { prompt_tokens: 1000, completion_tokens: 1000 } }));

    await send(appId, `${slug}/v1/chat/completions`, { model: "zai-org/GLM-5.3", messages: [] });

    const row = await recorded(appId);
    expect(row.cost).toBeCloseTo(0.00625, 10);
    expect(row.mode).toEqual({ region: "us" });
  });

  it("bills an OpenAI data residency host as the global one", async () => {
    const { appId, slug } = await seeded("openai", OPENAI_PRICING, "https://eu.api.openai.com/");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(openAiAnswer()));

    await send(appId, `${slug}/v1/responses`, { model: "gpt-5.6-sol", input: "hi" });

    const row = await recorded(appId);
    expect(row.cost).toBeCloseTo(0.005, 10);
    expect(row.mode).toBeNull();
  });

  it("bills a served mode with no price at the dearest price the model has, and says so", async () => {
    const { appId, slug } = await seeded("openai", OPENAI_PRICING);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(openAiAnswer("ultrafast")));
    const lines = warnings();

    await send(appId, `${slug}/v1/responses`, { model: "gpt-5.6-sol", input: "hi" });

    const row = await recorded(appId);
    // The dearest tier the model is priced in, fast, in the region it was
    // served in: 2 × $0.005, not fast in us.
    expect(row.cost).toBeCloseTo(0.01, 10);
    expect(row.mode).toEqual({ tier: "ultrafast" });
    expect(lines.filter((line) => line.message === "served_mode_unpriced"))
      .toEqual([expect.objectContaining({ appId, serviceMode: "ultrafast" })]);
  });

  it("bills Anthropic fast mode in the US as the two factors together", async () => {
    const { appId, slug } = await seeded("anthropic", {
      "claude-opus-5-5": { input: 4, output: 20, modes: { fast: { factor: 2 }, us: { factor: 1.1 } } },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
      type: "message",
      usage: { input_tokens: 1000, output_tokens: 1000, speed: "fast", inference_geo: "us", service_tier: "standard" },
    }));

    await send(appId, `${slug}/v1/messages`, {
      model: "claude-opus-5-5",
      max_tokens: 16,
      messages: [],
      speed: "fast",
      inference_geo: "us",
    });

    const row = await recorded(appId);
    // $0.024 standard, × 2 × 1.1.
    expect(row.cost).toBeCloseTo(0.0528, 10);
    expect(row.mode).toEqual({ tier: "fast", region: "us" });
  });

  it("bills a Gemini priority request that its header says was served as standard at the standard rate", async () => {
    const { appId, slug } = await seeded("gemini", {
      "gemini-3.5-flash": { input: 1, output: 4, modes: { priority: { factor: 1.8 } } },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(
      { usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 1000 } },
      { headers: { "x-gemini-service-tier": "standard" } },
    ));

    await send(appId, `${slug}/v1beta/models/gemini-3.5-flash:generateContent`, {
      contents: [],
      service_tier: "priority",
    });

    const row = await recorded(appId);
    expect(row.cost).toBeCloseTo(0.005, 10);
    expect(row.mode).toBeNull();
  });

  it("states an explicit rate of a mode over its factor", async () => {
    const { appId, slug } = await seeded("openai", {
      "gpt-5.6-sol": { input: 1, cached_input: 0.5, output: 4, modes: { flex: { factor: 0.5, cached_input: 0.4 } } },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
      service_tier: "flex",
      usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 1000 },
    }));

    await send(appId, `${slug}/v1/responses`, { model: "gpt-5.6-sol", input: "hi", service_tier: "flex" });

    const row = await recorded(appId);
    // 1,000 uncached at $0.5, 1,000 cached at $0.4 (not 0.25), 1,000 out at $2.
    expect(row.cost).toBeCloseTo((500 + 400 + 2000) / 1_000_000, 10);
  });
});

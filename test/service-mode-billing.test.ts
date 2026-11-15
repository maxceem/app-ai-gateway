import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { gatewayToken, seedApp, seedProvider, signRequest, testAttribution, testIdentity } from "./helpers";
import { recordUsageEvent } from "../src/usage/usage-record";
import type { ObservedBody } from "../src/usage/body-observer";
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
  const row = await env.DB.prepare("SELECT cost_usd, cost_source, service_mode FROM app_usage_event WHERE app_id = ?")
    .bind(appId)
    .first<{ cost_usd: number; cost_source: string | null; service_mode: string | null }>();
  return {
    cost: row?.cost_usd,
    source: row?.cost_source,
    mode: row?.service_mode ?? null,
  };
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
    ["flex, as asked", { service_tier: "flex" }, "flex", 0.0025, "flex"],
    ["fast, as asked", { service_tier: "priority" }, "priority", 0.01, "fast"],
    ["standard, where fast was shed to it", { service_tier: "fast" }, "default", 0.005, null],
    ["fast, from a project default the request never showed", {}, "priority", 0.01, "fast"],
    ["the requested mode, where the response names none", { service_tier: "flex" }, undefined, 0.0025, "flex"],
  ])("bills OpenAI %s", async (_label, fields, served, cost, mode) => {
    const { appId, slug } = await seeded("openai", OPENAI_PRICING);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(openAiAnswer(served)));
    const lines = warnings();

    const response = await send(appId, `${slug}/v1/responses`, { model: "gpt-5.6-sol", input: "hi", ...fields });

    expect(response.status).toBe(200);
    const row = await recorded(appId);
    expect(row.cost).toBeCloseTo(cost, 10);
    expect(row.mode).toEqual(mode);
    expect(row.source).toBe("computed");
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
    expect(row.mode).toEqual("us");
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
    expect(row.mode).toEqual("ultrafast");
    expect(row.source).toBe("estimated");
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
    expect(row.mode).toEqual("fast+us");
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

  it("serves a mode with no price and records it as estimated, flex at the standard price", async () => {
    // Priced for fast but not flex: flex never falls back to a dearer tier.
    const { appId, slug } = await seeded("openai", { "gpt-5.6-sol": { input: 1, output: 4, modes: { fast: { factor: 2 } } } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(openAiAnswer("flex")));
    const lines = warnings();

    const response = await send(appId, `${slug}/v1/responses`, { model: "gpt-5.6-sol", input: "hi", service_tier: "flex" });

    expect(response.status).toBe(200);
    const row = await recorded(appId);
    expect(row.cost).toBeCloseTo(0.005, 10);
    expect(row.source).toBe("estimated");
    expect(row.mode).toEqual("flex");
    expect(lines.filter((line) => line.message === "service_mode_unpriced"))
      .toEqual([expect.objectContaining({ appId, serviceMode: "flex" })]);
  });

  it("bills exactly where only the response names a value the gateway does not know, and logs it", async () => {
    const { appId, slug } = await seeded("anthropic", { "claude-opus-5-5": { input: 4, output: 20 } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
      type: "message",
      usage: { input_tokens: 1000, output_tokens: 1000, inference_geo: "not_available" },
    }));
    const lines = warnings();

    await send(appId, `${slug}/v1/messages`, { model: "claude-opus-5-5", max_tokens: 16, messages: [] });

    const row = await recorded(appId);
    expect(row.cost).toBeCloseTo(0.024, 10);
    expect(row.source).toBe("computed");
    expect(row.mode).toBeNull();
    expect(lines.filter((line) => line.message === "service_mode_unknown"))
      .toEqual([expect.objectContaining({ appId, source: "response", field: "inference_geo", value: "not_available" })]);
  });

  it("records a value the gateway does not know as estimated, at the standard price", async () => {
    const { appId, slug } = await seeded("openai", OPENAI_PRICING);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(openAiAnswer()));
    warnings();

    await send(appId, `${slug}/v1/responses`, { model: "gpt-5.6-sol", input: "hi", service_tier: "turbo" });

    const row = await recorded(appId);
    expect(row.cost).toBeCloseTo(0.005, 10);
    expect(row.source).toBe("estimated");
  });

  it.each([
    ["keeps the price list's modes, applied to its own rates", undefined, 0.01, "computed"],
    ["with an empty modes prices none", {}, 0.02, "estimated"],
  ])("a custom price without modes of its own %s", async (_label, modes, cost, source) => {
    // The price list prices o3 flex at half; the custom price is $4 / $16.
    const { appId, slug } = await seeded("openai", { o3: { input: 4, output: 16, ...(modes && { modes }) } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(openAiAnswer("flex")));
    warnings();

    await send(appId, `${slug}/v1/responses`, { model: "o3", input: "hi", service_tier: "flex" });

    const row = await recorded(appId);
    expect(row.cost).toBeCloseTo(cost, 10);
    expect(row.source).toBe(source);
  });

  it("never bills a truncated answer below the tier it asked for, whatever its tail says", async () => {
    const appId = `mode-billing-${crypto.randomUUID()}`;
    const pricing: ProviderPricing = {
      "gpt-5.6-sol": { input: 1, output: 4, modes: { flex: { factor: 0.5 }, ultrafast: { factor: 6 } } },
    };
    // Usage in the tail, and after it a client's own metadata that says flex.
    const observed: ObservedBody = {
      head: '{"id":"resp_1","object":"response","service_tier":"ultrafast","output":[{"content":"',
      tail: '"}],"usage":{"input_tokens":1000,"output_tokens":1000},"metadata":{"service_tier":"flex"}}',
      truncated: true,
      totalBytes: 2_000_000,
      aborted: false,
    };

    await recordUsageEvent({
      organizationId: "operator-test-organization",
      env,
      observed: Promise.resolve(observed),
      contentType: "application/json",
      identity: testIdentity({ appId, userId: "user-1" }),
      attribution: testAttribution({ pricing, serviceMode: { tier: "ultrafast", region: "global" } }),
      appVersion: null,
      status: "ok",
      latencyMs: 9,
    });

    const row = await recorded(appId);
    expect(row.cost).toBeCloseTo(0.03, 10);
    expect(row.mode).toEqual("ultrafast");
  });

  it("never bills below the asked tier from a stream event cut in half, which is scanned too", async () => {
    const appId = `mode-billing-${crypto.randomUUID()}`;
    const pricing: ProviderPricing = {
      "gpt-5.6-sol": { input: 1, output: 4, modes: { flex: { factor: 0.5 }, ultrafast: { factor: 6 } } },
    };
    // The tail starts inside the final event, so it is scanned, not parsed,
    // and its `usage` object can be text the client wrote.
    await recordUsageEvent({
      organizationId: "operator-test-organization",
      env,
      observed: Promise.resolve({
        head: 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
        tail: 'x","usage":{"input_tokens":1000,"output_tokens":1000,"service_tier":"flex"}}}\n\n',
        truncated: true,
        totalBytes: 2_000_000,
        aborted: false,
      }),
      contentType: "text/event-stream",
      identity: testIdentity({ appId, userId: "user-1" }),
      attribution: testAttribution({ pricing, serviceMode: { tier: "ultrafast", region: "global" } }),
      appVersion: null,
      status: "ok",
      latencyMs: 9,
    });

    const row = await recorded(appId);
    expect(row.cost).toBeCloseTo(0.03, 10);
    expect(row.mode).toEqual("ultrafast");
  });

  // Only a scanned document is held to the requested tier: a whole stream
  // event and a response header are parsed, not scanned, so a downgrade they
  // report is billed even on a body too big to keep whole.
  it.each([
    {
      label: "a whole event of a long OpenAI stream",
      attribution: {
        pricing: { "gpt-5.6-sol": { input: 1, output: 4, modes: { ultrafast: { factor: 6 } } } },
        serviceMode: { tier: "ultrafast", region: "global" },
      },
      contentType: "text/event-stream",
      head: 'event: response.created\ndata: {"type":"response.created","response":{"service_tier":"ultrafast"}}\n\nevent: response.output_text.delta\ndata: {"delta":"',
      tail: 'x"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"service_tier":"default","usage":{"input_tokens":1000,"output_tokens":1000}}}\n\n',
      headers: undefined,
    },
    {
      label: "Gemini's header on a long answer",
      attribution: {
        provider: "gemini" as const,
        providerSlug: "gemini",
        model: "gemini-3.5-flash",
        apiStyle: "gemini_native" as const,
        route: "gemini/v1beta/models/gemini-3.5-flash:generateContent",
        pricing: { "gemini-3.5-flash": { input: 1, output: 4, modes: { priority: { factor: 1.8 } } } },
        serviceMode: { tier: "priority", region: "global" },
      },
      contentType: "application/json",
      head: '{"candidates":[{"content":{"parts":[{"text":"',
      tail: '"}]}}],"usageMetadata":{"promptTokenCount":1000,"candidatesTokenCount":1000}}',
      headers: new Headers({ "x-gemini-service-tier": "standard" }),
    },
  ])("bills a downgrade reported by $label", async ({ attribution, contentType, head, tail, headers }) => {
    const appId = `mode-billing-${crypto.randomUUID()}`;
    await recordUsageEvent({
      organizationId: "operator-test-organization",
      env,
      observed: Promise.resolve({ head, tail, truncated: true, totalBytes: 2_000_000, aborted: false }),
      contentType,
      ...(headers && { responseHeaders: headers }),
      identity: testIdentity({ appId, userId: "user-1" }),
      attribution: testAttribution(attribution as unknown as Parameters<typeof testAttribution>[0]),
      appVersion: null,
      status: "ok",
      latencyMs: 9,
    });

    const row = await recorded(appId);
    expect(row.cost).toBeCloseTo(0.005, 10);
    expect(row.mode).toBeNull();
    expect(row.source).toBe("computed");
  });
});

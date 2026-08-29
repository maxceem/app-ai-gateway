import { describe, expect, it } from "vitest";
import prices from "../src/core/prices.json";
import { providerModelAuthor, PROVIDER_TYPES } from "../src/core/providers";
import {
  computeCost,
  extractUsageText,
  hasTokenModelPrice,
  isBillable,
  observeResponse,
  resolveModelAuthor,
} from "../src/core/usage";
import type { ProviderType } from "../src/core/types";

/** Extraction that a shape is expected to recognise; `null` fails the test here. */
function extracted(text: string, contentType: string, provider: ProviderType) {
  const usage = extractUsageText(text, contentType, provider);
  expect(usage).not.toBeNull();
  return usage!;
}

describe("usage extraction", () => {
  it("normalizes OpenAI cached and cache-write tokens as subsets of input", () => {
    const usage = extracted(
      `event: response.completed\ndata: ${JSON.stringify({
        response: {
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
            output_tokens: 20,
          },
        },
      })}\n\n`,
      "text/event-stream",
      "openai",
    );
    expect(usage).toEqual({
      inputTokens: 50,
      cachedInputTokens: 40,
      cacheWriteTokens: 10,
      outputTokens: 20,
    });
    expect(computeCost("openai", "gpt-5.6-luna", usage)).toBeCloseTo(0.0000373, 8);
  });

  it("normalizes Anthropic cache fields as separate token buckets across stream events", () => {
    const usage = extracted(
      [
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            usage: {
              input_tokens: 60,
              cache_read_input_tokens: 30,
              cache_creation_input_tokens: 10,
              output_tokens: 0,
            },
          },
        })}`,
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          usage: { output_tokens: 20 },
        })}`,
      ].join("\n\n") + "\n\n",
      "text/event-stream",
      "anthropic",
    );
    expect(usage).toEqual({
      inputTokens: 60,
      cachedInputTokens: 30,
      cacheWriteTokens: 10,
      outputTokens: 20,
    });
    expect(computeCost("anthropic", "claude-sonnet-5", usage)).toBeCloseTo(0.000351, 8);
  });

  it("normalizes Gemini cached prompt tokens as a subset", () => {
    expect(
      extracted(
        JSON.stringify([
          { candidates: [{ content: {} }] },
          {
            usageMetadata: {
              promptTokenCount: 90,
              cachedContentTokenCount: 25,
              candidatesTokenCount: 15,
            },
          },
        ]),
        "application/json",
        "gemini",
      ),
    ).toEqual({
      inputTokens: 65,
      cachedInputTokens: 25,
      cacheWriteTokens: 0,
      outputTokens: 15,
    });
  });

  it("extracts OpenAI-style usage from a streamed Gemini compatibility response", () => {
    const usage = extracted(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}`,
        `data: ${JSON.stringify({
          usage: {
            prompt_tokens: 120,
            prompt_tokens_details: { cached_tokens: 30 },
            completion_tokens: 12,
          },
        })}`,
        "data: [DONE]",
        "",
      ].join("\n\n"),
      "text/event-stream",
      "gemini",
    );
    expect(usage).toEqual({
      inputTokens: 90,
      cachedInputTokens: 30,
      cacheWriteTokens: 0,
      outputTokens: 12,
    });
  });

  it("returns null cost for an unknown model without failing usage extraction", () => {
    const usage = extracted(
      JSON.stringify({ usage: { input_tokens: 2, output_tokens: 3 } }),
      "application/json",
      "xai",
    );
    expect(usage.inputTokens).toBe(2);
    expect(computeCost("xai", "unknown-model", usage)).toBeNull();
  });

  it("prices xAI speech-to-text from the response duration", () => {
    const usage = extracted(
      JSON.stringify({ text: "hello", duration: 90 }),
      "application/json",
      "xai",
    );
    expect(computeCost("xai", "grok-transcribe", usage)).toBeCloseTo(0.0025, 8);
  });

  it("uses provider-specific and long-context rates", () => {
    const usage = {
      inputTokens: 200_001,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 100,
    };
    expect(computeCost("xai", "grok-4.5", usage)).toBeCloseTo(0.801204, 8);
    expect(computeCost("openai", "grok-4.5", usage)).toBeNull();
  });

  it("reports malformed data to the caller so background bookkeeping can contain it", () => {
    expect(() => extractUsageText("not-json", "application/json", "openai")).toThrow();
  });
});

/**
 * What a cost-reporting response says about itself, read alongside the usage
 * counts from the same body. Bounded to the types the registry says report:
 * everyone else's responses are parsed exactly as before.
 */
describe("provider self-reports", () => {
  const MODEL = "google/gemini-3.6-flash";

  function completion(usage: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      id: "gen-1",
      model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: "hi" } }],
      usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35, ...usage },
      ...extra,
    });
  }

  it("reads the cost, the serving host, and the served model out of one response", () => {
    const seen = observeResponse(
      completion({ cost: 0.00025 }, {
        openrouter_metadata: {
          endpoints: {
            total: 2,
            available: [
              { provider: "Vertex", model: MODEL, selected: false },
              { provider: "Google AI Studio", model: MODEL, selected: true },
            ],
          },
        },
      }),
      "application/json",
      "openrouter",
    );
    expect(seen.usage).toEqual({
      inputTokens: 30,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 5,
    });
    expect(seen.report).toEqual({
      costUsd: 0.00025,
      servedProvider: "Google AI Studio",
      servedModel: MODEL,
      credentialSource: null,
    });
  });

  it("takes the report from the final chunk of a stream", () => {
    const chunk = (extra: Record<string, unknown>) =>
      `data: ${JSON.stringify({ id: "gen-2", model: MODEL, choices: [{ delta: {} }], ...extra })}\n\n`;
    const seen = observeResponse(
      [
        chunk({}),
        chunk({ usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12, cost: 0.00009 } }),
        "data: [DONE]\n\n",
      ].join(""),
      "text/event-stream",
      "openrouter",
    );
    expect(seen.report?.costUsd).toBe(0.00009);
    expect(seen.usage?.outputTokens).toBe(3);
  });

  it("calls the credential byok only when the response says so", () => {
    const byok = (usage: Record<string, unknown>) =>
      observeResponse(completion(usage), "application/json", "openrouter").report?.credentialSource;
    expect(byok({ cost: 0, is_byok: true })).toBe("byok");
    // The upstream's own charge is a figure OpenRouter only has when the
    // operator's key was billed for the inference.
    expect(byok({ cost: 0, cost_details: { upstream_inference_cost: 0.002 } })).toBe("byok");
    // Everything else is unknown, which is stored as nothing at all.
    expect(byok({ cost: 0.5, is_byok: false })).toBeNull();
    expect(byok({ cost: 0.5, cost_details: { upstream_inference_cost: null } })).toBeNull();
    expect(byok({ cost: 0.5, cost_details: { upstream_inference_cost: 0 } })).toBeNull();
  });

  it("reports nothing when the response reports nothing", () => {
    // A body with no cost, no model and no routing metadata leaves every
    // observed field unknown rather than defaulting any of them.
    expect(
      observeResponse(
        JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        "application/json",
        "openrouter",
      ).report,
    ).toBeNull();
  });

  it("reads no report at all for a provider type that does not report costs", () => {
    // Same body, non-reporting type: the type is what decides, not the shape,
    // so nothing can start billing on a field a provider never promised.
    const seen = observeResponse(completion({ cost: 9.99 }), "application/json", "openai");
    expect(seen.report).toBeNull();
    expect(seen.usage?.inputTokens).toBe(30);
  });
});

/**
 * One representative response per shape the pipeline claims to support. Every
 * new provider inherits these shapes, so a regression that quietly stops reading
 * one of them is a silent spend-limit bypass rather than a visible failure.
 */
const RECOGNISED_SHAPES: {
  name: string;
  provider: ProviderType;
  contentType: string;
  body: string;
  expected: { inputTokens: number; cachedInputTokens: number; cacheWriteTokens: number; outputTokens: number };
  audioSeconds?: number;
}[] = [
  {
    name: "OpenAI Responses JSON",
    provider: "openai",
    contentType: "application/json",
    body: JSON.stringify({
      id: "resp_1",
      usage: { input_tokens: 30, output_tokens: 7 },
    }),
    expected: { inputTokens: 30, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 7 },
  },
  {
    name: "OpenAI Chat Completions JSON",
    provider: "openai",
    contentType: "application/json",
    body: JSON.stringify({
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 41, completion_tokens: 9 },
    }),
    expected: { inputTokens: 41, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 9 },
  },
  {
    name: "OpenAI Responses SSE",
    provider: "openai",
    contentType: "text/event-stream",
    body: `event: response.completed\ndata: ${JSON.stringify({
      response: { usage: { input_tokens: 12, output_tokens: 4 } },
    })}\n\n`,
    expected: { inputTokens: 12, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 4 },
  },
  {
    name: "Anthropic Messages JSON",
    provider: "anthropic",
    contentType: "application/json",
    body: JSON.stringify({
      type: "message",
      usage: {
        input_tokens: 55,
        cache_read_input_tokens: 11,
        cache_creation_input_tokens: 3,
        output_tokens: 17,
      },
    }),
    expected: { inputTokens: 55, cachedInputTokens: 11, cacheWriteTokens: 3, outputTokens: 17 },
  },
  {
    name: "Anthropic SSE across merged events",
    provider: "anthropic",
    contentType: "text/event-stream",
    body:
      [
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: { usage: { input_tokens: 21, output_tokens: 1 } },
        })}`,
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          usage: { output_tokens: 33 },
        })}`,
      ].join("\n\n") + "\n\n",
    expected: { inputTokens: 21, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 33 },
  },
  {
    name: "Gemini native JSON",
    provider: "gemini",
    contentType: "application/json",
    body: JSON.stringify({
      candidates: [{ content: {} }],
      usageMetadata: { promptTokenCount: 64, candidatesTokenCount: 8 },
    }),
    expected: { inputTokens: 64, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 8 },
  },
  {
    name: "Gemini native SSE",
    provider: "gemini",
    contentType: "text/event-stream",
    body:
      [
        `data: ${JSON.stringify({ candidates: [{ content: {} }] })}`,
        `data: ${JSON.stringify({
          usageMetadata: { promptTokenCount: 70, cachedContentTokenCount: 20, candidatesTokenCount: 5 },
        })}`,
        "",
      ].join("\n\n"),
    expected: { inputTokens: 50, cachedInputTokens: 20, cacheWriteTokens: 0, outputTokens: 5 },
  },
  {
    name: "audio transcription duration",
    provider: "openai",
    contentType: "application/json",
    body: JSON.stringify({ text: "hello", duration: 42 }),
    expected: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    audioSeconds: 42,
  },
  // The OpenAI-compatible batch. All four spell the cache hit differently, and
  // every one of them prices it at a discount, so reading only OpenAI's
  // spelling would over-bill exactly the traffic the discount exists for.
  {
    name: "Groq chat completions, no cache fields at all",
    provider: "groq",
    contentType: "application/json",
    body: JSON.stringify({
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 80, completion_tokens: 12, total_tokens: 92, queue_time: 0.01 },
      x_groq: { id: "req_1" },
    }),
    expected: { inputTokens: 80, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 12 },
  },
  {
    name: "DeepSeek prompt_cache_hit_tokens",
    provider: "deepseek",
    contentType: "application/json",
    body: JSON.stringify({
      choices: [{ message: { content: "hi" } }],
      usage: {
        // DeepSeek documents prompt_tokens as hit + miss, so the hit count is a
        // subset of the prompt total exactly as OpenAI's cached_tokens is.
        prompt_tokens: 1000,
        prompt_cache_hit_tokens: 640,
        prompt_cache_miss_tokens: 360,
        completion_tokens: 50,
      },
    }),
    expected: { inputTokens: 360, cachedInputTokens: 640, cacheWriteTokens: 0, outputTokens: 50 },
  },
  {
    name: "Moonshot cached_tokens at the usage root",
    provider: "moonshot",
    contentType: "application/json",
    body: JSON.stringify({
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520, cached_tokens: 300 },
    }),
    expected: { inputTokens: 200, cachedInputTokens: 300, cacheWriteTokens: 0, outputTokens: 20 },
  },
  {
    name: "Mistral prompt_tokens_details on a chat completion",
    provider: "mistral",
    contentType: "application/json",
    body: JSON.stringify({
      choices: [{ message: { content: "hi" } }],
      usage: {
        prompt_tokens: 900,
        prompt_tokens_details: { cached_tokens: 400 },
        completion_tokens: 30,
      },
    }),
    expected: { inputTokens: 500, cachedInputTokens: 400, cacheWriteTokens: 0, outputTokens: 30 },
  },
  {
    name: "ByteDance Ark chat completions SSE",
    provider: "bytedance",
    contentType: "text/event-stream",
    body:
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}`,
        `data: ${JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 240,
            prompt_tokens_details: { cached_tokens: 40 },
            completion_tokens: 16,
          },
        })}`,
        "data: [DONE]",
        "",
      ].join("\n\n"),
    expected: { inputTokens: 200, cachedInputTokens: 40, cacheWriteTokens: 0, outputTokens: 16 },
  },
];

describe("recognised usage shapes", () => {
  for (const shape of RECOGNISED_SHAPES) {
    it(`reads billable usage from ${shape.name}`, () => {
      const usage = extracted(shape.body, shape.contentType, shape.provider);
      expect(usage).toEqual(
        shape.audioSeconds === undefined
          ? shape.expected
          : { ...shape.expected, audioSeconds: shape.audioSeconds },
      );
      // Nothing here may meter as free: every fixture reports either tokens or
      // a duration, and both are priced.
      const metered = shape.audioSeconds ?? usage.inputTokens + usage.cachedInputTokens
        + usage.cacheWriteTokens + usage.outputTokens;
      expect(metered).toBeGreaterThan(0);
    });
  }
});

describe("unrecognised usage shapes", () => {
  it("reports no usage for a Cohere-style billed_units object", () => {
    // The worked example from the provider-expansion review: proxying works,
    // `usage.billed_units` is invisible here, and the request would bill $0.
    expect(
      extractUsageText(
        JSON.stringify({
          text: "hello",
          usage: { billed_units: { input_tokens: 120, output_tokens: 30 } },
        }),
        "application/json",
        "openai",
      ),
    ).toBeNull();
  });

  it("reports no usage for a successful response that carries none", () => {
    expect(
      extractUsageText(
        JSON.stringify({ id: "resp_1", output: [{ type: "message" }] }),
        "application/json",
        "openai",
      ),
    ).toBeNull();
  });

  it("reports no usage for a stream that never emitted a usage event", () => {
    expect(
      extractUsageText(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\ndata: [DONE]\n\n`,
        "text/event-stream",
        "openai",
      ),
    ).toBeNull();
  });

  it("reports no usage for Anthropic events that never carried a usage object", () => {
    expect(
      extractUsageText(
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: {} })}\n\n`,
        "text/event-stream",
        "anthropic",
      ),
    ).toBeNull();
  });

  it("separates a reported zero from an unreadable response", () => {
    // A genuinely free call reports zeros, and that stays a measurement.
    expect(
      extractUsageText(
        JSON.stringify({ usage: { input_tokens: 0, output_tokens: 0 } }),
        "application/json",
        "openai",
      ),
    ).toEqual({ inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
  });
});

/**
 * The catalog is market data typed by hand, and its one unit mistake — a price
 * entered per 1K tokens, or in cents — would be invisible: the request still
 * proxies, the event still records, and the bill is wrong by three orders of
 * magnitude. These assertions are about the *shape* of the numbers, not their
 * values, so they keep holding as prices move.
 */
describe("the shipped price catalog", () => {
  const catalog = prices as Record<string, Record<string, Record<string, unknown>>>;

  it("prices every catalogued model in dollars per million tokens", () => {
    for (const [provider, models] of Object.entries(catalog)) {
      expect([provider, PROVIDER_TYPES]).toContainEqual(provider);
      for (const [model, entry] of Object.entries(models)) {
        const where = `${provider}/${model}`;
        for (const [field, value] of Object.entries(entry)) {
          if (field === "author") {
            expect([where, typeof value]).toEqual([where, "string"]);
            continue;
          }
          expect([where, field, typeof value]).toEqual([where, field, "number"]);
          expect([where, field, (value as number) >= 0]).toEqual([where, field, true]);
        }
        if (entry.per_minute !== undefined || entry.per_hour !== undefined) continue;
        // Per-1M units: a $3/1M model is `3`, not `0.000003` and not `300`.
        // Nothing real sits outside this band, and both mistakes leave it.
        for (const field of ["input", "output", "cached_input", "cache_write"]) {
          const value = entry[field] as number | undefined;
          if (value === undefined || value === 0) continue;
          expect([where, field, value > 0.001 && value < 1000])
            .toEqual([where, field, true]);
        }
        // A discount that is not a discount is a data-entry slip, and it would
        // over-bill every cached token on that model.
        if (typeof entry.cached_input === "number") {
          expect([where, entry.cached_input <= (entry.input as number)])
            .toEqual([where, true]);
        }
        expect([where, hasTokenModelPrice(provider as ProviderType, model)])
          .toEqual([where, true]);
      }
    }
  });

  /**
   * A provider type with no default author has to name one per entry, or its
   * usage rows aggregate under "unknown" — which is the whole reason the
   * dimension is stored rather than derived from the provider type.
   */
  it("names an author for every model whose provider type has none", () => {
    for (const type of PROVIDER_TYPES) {
      if (providerModelAuthor(type) !== null) continue;
      for (const model of Object.keys(catalog[type] ?? {})) {
        expect([`${type}/${model}`, resolveModelAuthor(type, model)])
          .not.toEqual([`${type}/${model}`, null]);
      }
    }
  });

  it("resolves the same author for one model however it is served", () => {
    // gpt-oss-120b is OpenAI's, whether Groq, Cerebras, Together, Baseten or
    // ByteDance is the counterparty. That equality is the point of the field.
    expect(resolveModelAuthor("groq", "openai/gpt-oss-120b")).toBe("OpenAI");
    expect(resolveModelAuthor("together", "openai/gpt-oss-120b")).toBe("OpenAI");
    expect(resolveModelAuthor("baseten", "openai/gpt-oss-120b")).toBe("OpenAI");
    expect(resolveModelAuthor("cerebras", "gpt-oss-120b")).toBe("OpenAI");
    expect(resolveModelAuthor("bytedance", "gpt-oss-120b-250805")).toBe("OpenAI");
    // And a host's own default never overwrites a curated one.
    expect(resolveModelAuthor("together", "meta-llama/Llama-3.3-70B-Instruct-Turbo")).toBe("Meta");
    expect(resolveModelAuthor("bytedance", "seed-2-0-pro-260328")).toBe("ByteDance");
    // The three types that do make every model they serve.
    expect(resolveModelAuthor("deepseek", "deepseek-v4-pro")).toBe("DeepSeek");
    expect(resolveModelAuthor("moonshot", "kimi-k3")).toBe("Moonshot AI");
    expect(resolveModelAuthor("mistral", "mistral-large-latest")).toBe("Mistral");
  });

  /**
   * Mistral's size names are generations, not a price ladder, so `medium`
   * really does cost more than `large`: `mistral-medium-latest` is Medium 3.5,
   * the current frontier model, and `mistral-large-latest` is the older Large
   * 3. Asserted so that "correcting" the apparent swap fails here instead of
   * silently under-billing every Medium request by 3x on input and 5x on
   * output. Verified against docs.mistral.ai/inference/pricing.
   */
  it("keeps Mistral Medium priced above Mistral Large, which is not a typo", () => {
    const medium = catalog.mistral!["mistral-medium-latest"]!;
    const large = catalog.mistral!["mistral-large-latest"]!;
    const small = catalog.mistral!["mistral-small-latest"]!;
    expect(medium).toEqual({ input: 1.5, cached_input: 0.15, output: 7.5 });
    expect(large).toEqual({ input: 0.5, cached_input: 0.05, output: 1.5 });
    expect(small).toEqual({ input: 0.15, cached_input: 0.015, output: 0.6 });
    expect(medium.input as number).toBeGreaterThan(large.input as number);
    // Mistral discounts cached input by a flat 90% across the lineup.
    for (const entry of [medium, large, small]) {
      expect(entry.cached_input as number).toBeCloseTo((entry.input as number) * 0.1, 10);
    }
  });

  it("bills a cache hit at the cached rate on the providers that discount it", () => {
    const usage = {
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWriteTokens: 0,
      outputTokens: 0,
    };
    // DeepSeek: $0.44 fresh + $0.014 cached per 1M. Reading the cache hit as
    // fresh input would charge $0.88 — a 96% over-bill on the cached half.
    expect(computeCost("deepseek", "deepseek-v4-flash", usage)).toBeCloseTo(0.454, 8);
    // Moonshot K3: $3.00 fresh + $0.30 cached.
    expect(computeCost("moonshot", "kimi-k3", usage)).toBeCloseTo(3.3, 8);
    // Mistral applies a flat -90% modifier to cached input.
    expect(computeCost("mistral", "mistral-large-latest", usage)).toBeCloseTo(0.55, 8);
  });

  it("charges ByteDance's long-prompt bracket above its threshold", () => {
    // ModelArk doubles both rates above a 128K prompt; one flat pair per model
    // would under-bill every long-context request by half.
    const short = {
      inputTokens: 100_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1000,
    };
    const long = { ...short, inputTokens: 200_000 };
    expect(computeCost("bytedance", "seed-2-0-pro-260328", short))
      .toBeCloseTo(100_000 * 0.5e-6 + 1000 * 3.0e-6, 10);
    expect(computeCost("bytedance", "seed-2-0-pro-260328", long))
      .toBeCloseTo(200_000 * 1.0e-6 + 1000 * 6.0e-6, 10);
  });

  /**
   * The aggregator link of the chain. OpenRouter slugs bypass the catalog
   * entirely — they are billed on a reported cost — so without this they would
   * be the one billable traffic with no author at all.
   */
  it("reads an aggregator model's author out of its slug namespace", () => {
    expect(catalog.openrouter).toBeUndefined();
    for (
      const [model, author] of [
        ["google/gemini-3.6-flash", "Google"],
        ["openai/gpt-5.6-sol", "OpenAI"],
        ["anthropic/claude-opus-4-6", "Anthropic"],
        ["meta-llama/llama-4-maverick", "Meta"],
        ["qwen/qwen3.8-max", "Alibaba"],
        ["deepseek/deepseek-v4-pro", "DeepSeek"],
        ["mistralai/mistral-medium-3-5", "Mistral"],
        ["x-ai/grok-4.6", "xAI"],
        ["moonshotai/kimi-k3", "Moonshot AI"],
        ["bytedance-seed/seed-2-1-turbo", "ByteDance"],
        // Alias slugs are published with a leading tilde.
        ["~anthropic/claude-opus-latest", "Anthropic"],
      ] as const
    ) {
      expect([model, resolveModelAuthor("openrouter", model)]).toEqual([model, author]);
    }
    // An unlisted namespace is no answer rather than a guess, and so is a slug
    // with no namespace at all.
    expect(resolveModelAuthor("openrouter", "some-lab/some-model")).toBeNull();
    expect(resolveModelAuthor("openrouter", "openrouter/auto")).toBeNull();
    expect(resolveModelAuthor("openrouter", "unnamespaced-model")).toBeNull();
  });

  it("reads a slug namespace only where the provider type declares one", () => {
    // Together's IDs look identical, but a leading segment elsewhere can mean
    // an account or a region, so authorship there stays curated per entry.
    expect(resolveModelAuthor("together", "google/never-priced-model")).toBeNull();
    expect(resolveModelAuthor("fireworks", "accounts/acme/models/llama")).toBeNull();
  });

  it("prefers a curated catalog author over the slug namespace", () => {
    const mutable = prices as unknown as Record<
      string,
      Record<string, { input: number; output: number; author?: string }>
    >;
    mutable.openrouter = { "meta-llama/llama-4-maverick": { input: 1, output: 2, author: "Meta AI" } };
    try {
      expect(resolveModelAuthor("openrouter", "meta-llama/llama-4-maverick")).toBe("Meta AI");
      // Sibling models still fall through to the namespace.
      expect(resolveModelAuthor("openrouter", "meta-llama/llama-4-scout")).toBe("Meta");
    } finally {
      delete mutable.openrouter;
    }
  });

  it("refuses to proxy a model this deployment ships no price for", () => {
    // Fireworks names models per account and Hugging Face's router re-prices
    // the same ID per upstream, so neither ships a catalog. Fail-closed means
    // their traffic waits for an operator price rather than billing $0.
    for (const type of ["fireworks", "huggingface"] as const) {
      expect(catalog[type]).toBeUndefined();
      expect(isBillable(type, "any/model")).toBe(false);
      expect(isBillable(type, "any/model", { "any/model": { input: 1, output: 2 } })).toBe(true);
    }
  });
});

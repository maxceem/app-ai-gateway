import { describe, expect, it } from "vitest";
import { ProviderPricingSchema } from "../src/contracts/schemas";
import { computeCost, type UsageObservation } from "../src/usage/pricing";
import { extractUsageText } from "../src/usage/usage-readers";
import {
  LONG_RATE_FIELDS,
  RATE_LABELS,
  TOKEN_RATE_FIELDS,
  VARIANTS,
  bucketRates,
  variantRate,
} from "../src/shared/token-rates";
import { shippedRates } from "./shipped-rates";

const SONNET = "claude-sonnet-5";

function anthropicBody(usage: Record<string, unknown>): string {
  return JSON.stringify({ type: "message", usage });
}

function written(cacheWriteTokens: number, oneHour?: unknown): UsageObservation {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens,
    outputTokens: 0,
    ...(oneHour !== undefined && { tokenVariants: { cache_write: { "1h": oneHour as number } } }),
  };
}

describe("Anthropic cache-write TTL split", () => {
  it("bills the one-hour share at its own rate and the rest at the default write rate", () => {
    const usage = extractUsageText(
      anthropicBody({
        input_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 100,
        cache_creation: { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 40 },
        output_tokens: 2,
      }),
      "application/json",
      "anthropic_messages",
    );
    expect(usage).toEqual({
      inputTokens: 5,
      cachedInputTokens: 0,
      cacheWriteTokens: 100,
      outputTokens: 2,
      tokenVariants: { cache_write: { "1h": 40 } },
    });
    const rates = shippedRates("anthropic", SONNET);
    expect(computeCost("anthropic", SONNET, usage!)).toBeCloseTo(
      (5 * rates.input + 60 * rates.cache_write + 40 * rates.cache_write_1h + 2 * rates.output) / 1e6,
      12,
    );
  });

  it("keeps the split from message_start when later stream events omit it", () => {
    const usage = extractUsageText(
      [
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 30,
              cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 30 },
              output_tokens: 1,
            },
          },
        })}`,
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          usage: { input_tokens: 10, cache_creation_input_tokens: 30, output_tokens: 9 },
        })}`,
      ].join("\n\n") + "\n\n",
      "text/event-stream",
      "anthropic_messages",
    );
    expect(usage).toMatchObject({ cacheWriteTokens: 30, outputTokens: 9 });
    expect(usage?.tokenVariants).toEqual({ cache_write: { "1h": 30 } });
  });

  it("bills an unsplit write at the default rate, as before the split was read", () => {
    const usage = extractUsageText(
      anthropicBody({ input_tokens: 1, cache_creation_input_tokens: 50, output_tokens: 1 }),
      "application/json",
      "anthropic_messages",
    );
    expect(usage?.tokenVariants).toBeUndefined();
    const rates = shippedRates("anthropic", SONNET);
    expect(computeCost("anthropic", SONNET, usage!)).toBeCloseTo(
      (rates.input + 50 * rates.cache_write + rates.output) / 1e6,
      12,
    );
  });

  it("never bills more variant tokens than the bucket holds", () => {
    const rates = shippedRates("anthropic", SONNET);
    expect(computeCost("anthropic", SONNET, written(10, 500))).toBeCloseTo(10 * rates.cache_write_1h / 1e6, 12);
  });

  it("ignores a stored variant count that is not a non-negative number", () => {
    const rates = shippedRates("anthropic", SONNET);
    for (const bad of [-5, "40", Number.NaN, null]) {
      expect(computeCost("anthropic", SONNET, written(20, bad))).toBeCloseTo(20 * rates.cache_write / 1e6, 12);
    }
  });

  it("uses the long-context one-hour rate above the threshold", () => {
    const rates = shippedRates("anthropic", "claude-haiku-5-5");
    const usage: UsageObservation = {
      inputTokens: rates.long_context_threshold,
      cachedInputTokens: 0,
      cacheWriteTokens: 1000,
      outputTokens: 0,
      tokenVariants: { cache_write: { "1h": 1000 } },
    };
    expect(computeCost("anthropic", "claude-haiku-5-5", usage)).toBeCloseTo(
      (rates.long_context_threshold * rates.long_input + 1000 * rates.long_cache_write_1h) / 1e6,
      12,
    );
  });
});

describe("OpenAI cache-write TTL split", () => {
  const SOL = "gpt-5.6-sol";

  function responsesUsage(cacheWrites: { ttl_30m_tokens: number; ttl_12h_tokens: number }, inputTokens = 12_000) {
    const written = cacheWrites.ttl_30m_tokens + cacheWrites.ttl_12h_tokens;
    return extractUsageText(
      JSON.stringify({
        object: "response",
        usage: {
          input_tokens: inputTokens,
          input_tokens_details: {
            cached_tokens: 4000,
            cache_write_tokens: written,
            cache_write_tokens_details: cacheWrites,
          },
          output_tokens: 10,
        },
      }),
      "application/json",
      "responses",
    );
  }

  it("bills the 12-hour share at its own rate and the rest at the 30-minute rate", () => {
    // OpenAI's own worked example: 1,000 ordinary, 4,000 cached, 3,000 + 4,000 written.
    const usage = responsesUsage({ ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 });
    expect(usage).toEqual({
      inputTokens: 1000,
      cachedInputTokens: 4000,
      cacheWriteTokens: 7000,
      outputTokens: 10,
      tokenVariants: { cache_write: { "12h": 4000 } },
    });
    const rates = shippedRates("openai", SOL);
    expect(computeCost("openai", SOL, usage!)).toBeCloseTo(
      (1000 * rates.input + 4000 * rates.cached_input + 3000 * rates.cache_write + 4000 * rates.cache_write_12h
        + 10 * rates.output) / 1e6,
      12,
    );
  });

  it("stores no split when nothing was kept for 12 hours", () => {
    // OpenAI reports both lifetimes even when one is zero.
    const usage = responsesUsage({ ttl_30m_tokens: 7000, ttl_12h_tokens: 0 });
    expect(usage?.tokenVariants).toBeUndefined();
    const rates = shippedRates("openai", SOL);
    expect(computeCost("openai", SOL, usage!)).toBeCloseTo(
      (1000 * rates.input + 4000 * rates.cached_input + 7000 * rates.cache_write + 10 * rates.output) / 1e6,
      12,
    );
  });

  it("uses the long-context 12-hour rate above the threshold", () => {
    const rates = shippedRates("openai", SOL);
    const usage = responsesUsage({ ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 }, rates.long_context_threshold + 12_000);
    expect(computeCost("openai", SOL, usage!)).toBeCloseTo(
      ((rates.long_context_threshold + 1000) * rates.long_input + 4000 * rates.long_cached_input
        + 3000 * rates.long_cache_write + 4000 * rates.long_cache_write_12h + 10 * rates.long_output) / 1e6,
      12,
    );
  });

  it("bills a 12-hour share at the default write rate where the model has no 12-hour price", () => {
    const usage = responsesUsage({ ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 });
    const pricing = { [SOL]: { input: 1, output: 4, cached_input: 0.1, cache_write: 1.25 } };
    expect(computeCost("openai", SOL, usage!, pricing)).toBeCloseTo(
      (1000 * 1 + 4000 * 0.1 + 7000 * 1.25 + 10 * 4) / 1e6,
      12,
    );
  });
});

describe("the rate config", () => {
  it("lists each variant's rate after its bucket's, and every short rate again for long context", () => {
    expect(TOKEN_RATE_FIELDS).toEqual([
      "input",
      "cached_input",
      "cache_write",
      "cache_write_1h",
      "cache_write_12h",
      "output",
      "image_input",
      "audio_input",
      "video_input",
      "image_output",
      "long_input",
      "long_cached_input",
      "long_cache_write",
      "long_cache_write_1h",
      "long_cache_write_12h",
      "long_output",
    ]);
    expect(LONG_RATE_FIELDS).toEqual(TOKEN_RATE_FIELDS.filter((field) => field.startsWith("long_")));
  });

  it("gives every variant a readable path and every rate a label", () => {
    for (const variant of VARIANTS) {
      expect(variant.reportedAt.length).toBeGreaterThan(0);
      expect(TOKEN_RATE_FIELDS).toContain(variant.field);
      expect(TOKEN_RATE_FIELDS).toContain(`long_${variant.field}`);
    }
    expect(RATE_LABELS.cached_input).toBe("cached");
    expect(RATE_LABELS.long_cache_write_12h).toBe("long 12h cache write");
  });

  it("falls back from a variant to its bucket, and from long context to short", () => {
    const price = { input: 1, output: 2, cache_write: 1.25, long_context_threshold: 10, long_input: 2 };
    expect(bucketRates(price, false)).toEqual({ input: 1, cached_input: 1, cache_write: 1.25, output: 2 });
    // Long cache reads and writes fall back to their short rate, then to long input.
    expect(bucketRates(price, true)).toEqual({ input: 2, cached_input: 2, cache_write: 1.25, output: 2 });
    const twelve = VARIANTS.find((variant) => variant.field === "cache_write_12h")!;
    expect(variantRate(price, twelve, true, 1.25)).toBe(1.25);
    expect(variantRate({ ...price, cache_write_12h: 2.5 }, twelve, true, 1.25)).toBe(2.5);
    expect(variantRate({ ...price, cache_write_12h: 2.5, long_cache_write_12h: 5 }, twelve, true, 1.25)).toBe(5);
    expect(variantRate({ ...price, cache_write_12h: 2.5, long_cache_write_12h: 5 }, twelve, false, 1.25)).toBe(2.5);
  });
});

describe("custom prices", () => {
  const usage: UsageObservation = {
    inputTokens: 100,
    cachedInputTokens: 200,
    cacheWriteTokens: 50,
    outputTokens: 10,
    tokenVariants: { cache_write: { "1h": 20 } },
  };

  it("bill each bucket at the rates the custom price sets", () => {
    const pricing = {
      [SONNET]: { input: 1, output: 4, cached_input: 0.1, cache_write: 1.5, cache_write_1h: 3 },
    };
    expect(computeCost("anthropic", SONNET, usage, pricing)).toBeCloseTo(
      (100 * 1 + 200 * 0.1 + 30 * 1.5 + 20 * 3 + 10 * 4) / 1e6,
      12,
    );
  });

  it("replace the catalog's rates instead of inheriting its cache discount", () => {
    // Only input and output given: cache reads and writes, one-hour ones
    // included, bill at input — never at the catalog's cheaper cache rates.
    const pricing = { [SONNET]: { input: 1, output: 4 } };
    expect(computeCost("anthropic", SONNET, usage, pricing)).toBeCloseTo((350 * 1 + 10 * 4) / 1e6, 12);
  });

  it("bill an unpriced variant at its bucket's rate", () => {
    const pricing = { [SONNET]: { input: 1, output: 4, cache_write: 1.5 } };
    expect(computeCost("anthropic", SONNET, usage, pricing)).toBeCloseTo(
      (100 * 1 + 200 * 1 + 50 * 1.5 + 10 * 4) / 1e6,
      12,
    );
  });

  it("carry no field the rate list does not name into the arithmetic", () => {
    const pricing = { [SONNET]: { input: 1, output: 4, per_minute: 100 } } as never;
    expect(computeCost("anthropic", SONNET, usage, pricing)).toBeCloseTo((350 * 1 + 10 * 4) / 1e6, 12);
  });
});

describe("the custom price schema", () => {
  it("accepts every rate the config names", () => {
    const price = Object.fromEntries(TOKEN_RATE_FIELDS.map((field) => [field, 1]));
    expect(ProviderPricingSchema.safeParse({ m: { ...price, long_context_threshold: 1000 } }).success).toBe(true);
  });

  it("accepts every per-token rate", () => {
    const parsed = ProviderPricingSchema.safeParse({
      m: {
        input: 1,
        output: 2,
        cached_input: 0.1,
        cache_write: 1.25,
        cache_write_1h: 2,
        image_input: 3,
        long_context_threshold: 200_000,
        long_input: 2,
        long_cache_write_1h: 4,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("still requires input and output", () => {
    expect(ProviderPricingSchema.safeParse({ m: { input: 1, cached_input: 0.1 } }).success).toBe(false);
  });

  it("refuses a field that is not a per-token rate", () => {
    expect(ProviderPricingSchema.safeParse({ m: { input: 1, output: 2, per_minute: 1 } }).success).toBe(false);
    expect(ProviderPricingSchema.safeParse({ m: { input: 1, output: 2, kind: "text" } }).success).toBe(false);
  });

  it("refuses a negative rate", () => {
    expect(ProviderPricingSchema.safeParse({ m: { input: 1, output: 2, cache_write: -1 } }).success).toBe(false);
  });

  it("refuses long-context rates without their threshold", () => {
    expect(ProviderPricingSchema.safeParse({ m: { input: 1, output: 2, long_input: 2 } }).success).toBe(false);
  });
});

/**
 * Pricing a token call (OpenAI chat and every other token-priced style).
 *
 * The usage is split into buckets the way providers bill them: uncached
 * input, cached input, cache writes and output. Each bucket takes its rate,
 * falling back as v1 does: a missing cached or cache-write rate bills at the
 * input rate, never free. Above the model's long-context threshold the
 * `long_*` rates apply. The whole is rounded up once.
 */
import { priceUnitsSum, type NanoDollars, type RateNanoPerMillion } from "../money.ts";
import type { ModelPrice } from "./prices.ts";

/** Token counts as a usage reader reports them. `inputTokens` excludes cached and cache-write tokens. */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
}

export interface TokenPricing {
  readonly cost: NanoDollars;
  /** The rate each bucket was billed at, stored on the charge for later corrections. */
  readonly rates: Readonly<Record<"input" | "cached_input" | "cache_write" | "output", RateNanoPerMillion>>;
  readonly longContext: boolean;
}

/** Prices token usage, or returns null when the price has no input or output rate. */
export function priceTokens(price: ModelPrice, usage: TokenUsage): TokenPricing | null {
  const { rates } = price;
  if (rates.input === undefined || rates.output === undefined) return null;
  const prompt = usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens;
  const longContext = price.longContextThreshold !== undefined && prompt > price.longContextThreshold;
  const input = longContext ? (rates.long_input ?? rates.input) : rates.input;
  const used = {
    input,
    cached_input: longContext
      ? (rates.long_cached_input ?? rates.cached_input ?? input)
      : (rates.cached_input ?? input),
    cache_write: longContext
      ? (rates.long_cache_write ?? rates.cache_write ?? input)
      : (rates.cache_write ?? input),
    output: longContext ? (rates.long_output ?? rates.output) : rates.output,
  };
  const cost = priceUnitsSum([
    [usage.inputTokens, used.input],
    [usage.cachedInputTokens, used.cached_input],
    [usage.cacheWriteTokens, used.cache_write],
    [usage.outputTokens, used.output],
  ]);
  return { cost, rates: used, longContext };
}

/** All tokens of a call: the main billed unit kept in the rollups. */
export function totalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens + usage.outputTokens;
}

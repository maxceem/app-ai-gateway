// Models.dev and LiteLLM, read into the same `Price` shape the parsers return.
//
// Both are community lists: they are only consulted for a provider with no
// official parser, or whose parser failed, and only trusted when they agree.
// A shape either list does not use plainly (two context tiers, a tier of an
// unknown kind) is read as "not listed", never guessed at.

import { round6 } from "./price.mjs";

function perMillion(value) {
  return typeof value === "number" && Number.isFinite(value) ? round6(value * 1e6) : undefined;
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? round6(value) : undefined;
}

/** A Models.dev model's `cost`, or undefined when it has no plain token price. */
export function fromModelsDev(api, provider, model) {
  const entry = api?.[provider]?.models;
  if (entry === undefined || !Object.hasOwn(entry, model)) return undefined;
  const cost = entry[model]?.cost;
  const input = number(cost?.input);
  const output = number(cost?.output);
  if (input === undefined || output === undefined) return undefined;
  const price = { input, output };
  if (number(cost.cache_read) !== undefined) price.cached_input = number(cost.cache_read);
  if (number(cost.cache_write) !== undefined) price.cache_write = number(cost.cache_write);

  const tiers = cost.tiers ?? [];
  if (!Array.isArray(tiers) || tiers.length > 1) return undefined;
  if (tiers.length === 1) {
    const tier = tiers[0];
    if (tier?.tier?.type !== "context" || !Number.isInteger(tier.tier.size)) return undefined;
    if (number(tier.input) === undefined || number(tier.output) === undefined) return undefined;
    price.long_context_threshold = tier.tier.size;
    price.long_input = number(tier.input);
    if (number(tier.cache_read) !== undefined) price.long_cached_input = number(tier.cache_read);
    if (number(tier.cache_write) !== undefined) price.long_cache_write = number(tier.cache_write);
    price.long_output = number(tier.output);
  }
  return price;
}

const LONG_KEY =
  /^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)_above_(\d+)k_tokens$/u;
const LONG_FIELDS = {
  input_cost_per_token: "long_input",
  output_cost_per_token: "long_output",
  cache_read_input_token_cost: "long_cached_input",
  cache_creation_input_token_cost: "long_cache_write",
};

/**
 * A LiteLLM entry. Token prices are $ per token; `*_above_<N>k_tokens` is the
 * long-context price above N×1000 prompt tokens; `input_cost_per_second` is
 * an audio price, read per minute.
 */
export function fromLitellm(prices, key) {
  if (prices === null || typeof prices !== "object" || !Object.hasOwn(prices, key)) return undefined;
  const entry = prices[key];
  const price = {};
  const input = perMillion(entry?.input_cost_per_token);
  const output = perMillion(entry?.output_cost_per_token);
  if (input !== undefined && output !== undefined) {
    price.input = input;
    price.output = output;
    const cached = perMillion(entry.cache_read_input_token_cost);
    if (cached !== undefined) price.cached_input = cached;
    const write = perMillion(entry.cache_creation_input_token_cost);
    if (write !== undefined) price.cache_write = write;

    const thresholds = new Set();
    const long = {};
    for (const [name, value] of Object.entries(entry)) {
      const match = LONG_KEY.exec(name);
      if (!match || perMillion(value) === undefined) continue;
      thresholds.add(Number(match[2]) * 1000);
      long[LONG_FIELDS[match[1]]] = perMillion(value);
    }
    if (thresholds.size > 1) return undefined;
    if (thresholds.size === 1) {
      if (long.long_input === undefined || long.long_output === undefined) return undefined;
      price.long_context_threshold = [...thresholds][0];
      price.long_input = long.long_input;
      if (long.long_cached_input !== undefined) price.long_cached_input = long.long_cached_input;
      if (long.long_cache_write !== undefined) price.long_cache_write = long.long_cache_write;
      price.long_output = long.long_output;
    }
  }
  const perSecond = entry?.input_cost_per_second;
  if (typeof perSecond === "number" && Number.isFinite(perSecond)) {
    price.per_minute = round6(perSecond * 60);
  }
  return Object.keys(price).length > 0 ? price : undefined;
}

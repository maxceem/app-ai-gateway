/**
 * What a model costs, and whether this deployment may bill it at all.
 *
 * The shipped catalog, the operator's own overrides, the cost of one observed
 * usage figure, and who wrote the model. Nothing here reads a response body:
 * the readers in `./usage-readers.ts` turn a body into a {@link
 * UsageObservation}, and this module is what puts a number on one.
 */

import models from "./models.json";
import { namespaceModelAuthor, providerModelAuthor } from "../providers/provider-type";
import { lookup } from "../shared/records";
import type { Modality, ModalityCounts, ModalityTokens, UsageCounts } from "../core/types";
import type { ProviderPricing } from "../db/schema";
import { type ProviderType, reportsCost } from "../shared/providers";

export interface Price {
  input?: number;
  output?: number;
  /**
   * What an input token of one modality costs, where it is priced apart from
   * text, as an embedding model's are. Absent means it bills at `input`.
   */
  image_input?: number;
  audio_input?: number;
  video_input?: number;
  /**
   * What a generated image token costs, where the model's text output costs
   * less. Absent means every output token bills at `output`.
   */
  image_output?: number;
  audio_output?: number;
  cached_audio_input?: number;
  cached_input?: number;
  cache_write?: number;
  per_minute?: number;
  per_hour?: number;
  long_context_threshold?: number;
  long_input?: number;
  long_output?: number;
  long_cached_input?: number;
  long_cache_write?: number;
  /**
   * Who made the model, where the catalog knows better than the provider type
   * does — a Llama model served by Groq is Meta's. Curated per entry alongside
   * the prices; absent falls back to the provider type's own author.
   */
  author?: string;
  /**
   * The day (`YYYY-MM-DD`) the provider stops, or stopped, serving the model,
   * kept current by the daily model sync. Informational: a retired model
   * stays priced, so an app that still names it keeps billing exactly.
   */
  retirement_date?: string;
}

export interface UsageObservation extends UsageCounts {
  audioSeconds?: number;
  modalityTokens?: ModalityTokens;
  /**
   * Set when the response reported a duration and no token counts, so its
   * zeroed counters are absent rather than a measured zero. Only a transcription
   * can say this; a token reader always measured what it returns.
   */
  durationOnly?: true;
}

/** What a response that said nothing readable is priced as: nothing at all. */
export const EMPTY_USAGE: UsageCounts = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
};

/**
 * The shipped catalog entry: the only source that carries model authorship.
 *
 * `Partial` because a provider type may ship with no catalog section at all —
 * Fireworks names models per account and Hugging Face's router re-prices the
 * same model ID per upstream, so no static list would be right for either.
 * Their models are priced by the operator, and until one is, nothing proxies.
 */
function catalogPrice(provider: ProviderType, model: string): Price | undefined {
  // The model name comes from the request body, and "constructor" is a legal
  // one: an unguarded read would answer with a function off Object.prototype
  // and price a model nobody listed.
  const catalog = models as Partial<Record<ProviderType, Record<string, Price>>>;
  return lookup(catalog[provider], model);
}

/**
 * Model pricing is a two-level lookup: the resolved provider row's own
 * overrides win, then the deployment-global catalog. A model priced by neither
 * never proxies unless its route reports cost, so `cost_usd` is never NULL.
 */
export function modelPrice(
  provider: ProviderType,
  model: string,
  overrides?: ProviderPricing | null,
): Price | undefined {
  const override = lookup(overrides, model);
  if (override) return { ...override };
  return catalogPrice(provider, model);
}

export function hasModelPrice(
  provider: ProviderType,
  model: string,
  overrides?: ProviderPricing | null,
): boolean {
  const price = modelPrice(provider, model, overrides);
  if (!price) return false;
  if (price.per_minute !== undefined) return Number.isFinite(price.per_minute) && price.per_minute >= 0;
  if (price.per_hour !== undefined) return Number.isFinite(price.per_hour) && price.per_hour >= 0;
  return price.input !== undefined
    && Number.isFinite(price.input)
    && price.input >= 0
    && price.output !== undefined
    && Number.isFinite(price.output)
    && price.output >= 0;
}

export function hasTokenModelPrice(
  provider: ProviderType,
  model: string,
  overrides?: ProviderPricing | null,
): boolean {
  const price = modelPrice(provider, model, overrides);
  return price?.input !== undefined
    && Number.isFinite(price.input)
    && price.input >= 0
    && price.output !== undefined
    && Number.isFinite(price.output)
    && price.output >= 0;
}

/**
 * Whether a request can be billed at all, which is the only reason it is
 * allowed to proxy. Two ways to know what it costs: a local price for the
 * canonical model, or a route that reports its own cost per request. Neither
 * means the spend would be invisible, and an invisible spend is a limit bypass.
 */
export function isBillable(
  provider: ProviderType,
  model: string,
  overrides?: ProviderPricing | null,
): boolean {
  return reportsCost(provider) || hasModelPrice(provider, model, overrides);
}

/**
 * Who made a model, resolved once when the event is recorded so console
 * aggregations stay plain SQL. The catalog is consulted first because it is
 * curated per model; an aggregator's slug namespace answers next, because that
 * is where authorship lives for models no catalog prices; the provider type's
 * own author answers for the rest.
 *
 * Operator price overrides are deliberately not consulted: they carry prices
 * only, and shadowing a catalog entry must not erase who wrote the model.
 */
export function resolveModelAuthor(provider: ProviderType, model: string): string | null {
  return catalogPrice(provider, model)?.author
    ?? namespaceModelAuthor(provider, model)
    ?? providerModelAuthor(provider);
}

/**
 * Whether an observation carries the measure the model's price is denominated
 * in. A time-priced model needs a duration and a token-priced one needs token
 * counts; anything else would compute a confident $0 from the counters left at
 * zero — a free-looking request that escapes every budget. `true` where no
 * price applies, because that is {@link computeCost}'s `null` to report.
 */
export function reportsPricedMeasure(
  provider: ProviderType,
  model: string,
  usage: UsageObservation,
  overrides?: ProviderPricing | null,
): boolean {
  const price = modelPrice(provider, model, overrides);
  if (!price) return true;
  if (price.per_minute !== undefined || price.per_hour !== undefined) {
    return usage.audioSeconds !== undefined;
  }
  return usage.durationOnly !== true;
}

const INPUT_RATES = { image: "image_input", audio: "audio_input", video: "video_input" } as const;
const OUTPUT_RATES = { image: "image_output", audio: "audio_output" } as const;

/** The modalities a model prices apart on one side, with their rates. */
function modalityRates(
  price: Price,
  fields: Partial<Record<Modality, keyof Price>>,
): [Modality, number][] {
  return (Object.entries(fields) as [Modality, keyof Price][]).flatMap(([modality, field]) => {
    const rate = price[field];
    return typeof rate === "number" ? [[modality, rate] as [Modality, number]] : [];
  });
}

/**
 * What one side's tokens cost when the model prices some modalities apart from
 * text. Each modality the response counted bills at its own rate and the rest
 * at `base`. Tokens it did not account for, and a whole side it did not break
 * down, bill at the highest rate the model has, rather than let an image or a
 * recording pass at the text price and escape the budget it should consume.
 *
 * Gemini counts a modality over the whole prompt, cached part included, so the
 * modality tokens are taken out of `tokens`, unknown ones first, and never
 * exceed it.
 */
function sideCost(
  tokens: number,
  base: number,
  rates: [Modality, number][],
  counts: ModalityCounts | undefined,
): number {
  if (rates.length === 0) return tokens * base;
  const highest = Math.max(base, ...rates.map(([, rate]) => rate));
  if (!counts) return tokens * highest;
  const unknown = Math.min(tokens, counts.unknown ?? 0);
  let rest = tokens - unknown;
  let cost = unknown * highest;
  for (const [modality, rate] of rates) {
    const billed = Math.min(rest, counts[modality] ?? 0);
    cost += billed * rate;
    rest -= billed;
  }
  return cost + rest * base;
}

/**
 * Whether a model's price depends on what its requests were made of, so a
 * usage figure with no modality record cannot be priced exactly.
 */
export function pricesModalities(
  provider: ProviderType,
  model: string,
  overrides?: ProviderPricing | null,
): boolean {
  const price = modelPrice(provider, model, overrides);
  return price !== undefined
    && (modalityRates(price, INPUT_RATES).length > 0 || modalityRates(price, OUTPUT_RATES).length > 0 || price.cached_audio_input !== undefined);
}

export function computeCost(
  provider: ProviderType,
  model: string,
  usage: UsageObservation,
  overrides?: ProviderPricing | null,
): number | null {
  const price = modelPrice(provider, model, overrides);
  if (!price) return null;
  if (price.per_minute !== undefined) {
    return ((usage.audioSeconds ?? 0) / 60) * price.per_minute;
  }
  if (price.per_hour !== undefined) {
    return ((usage.audioSeconds ?? 0) / 3600) * price.per_hour;
  }
  if (price.input === undefined || price.output === undefined) return null;
  const promptTokens = usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens;
  const longContext =
    price.long_context_threshold !== undefined && promptTokens > price.long_context_threshold;
  const inputPrice = longContext ? (price.long_input ?? price.input) : price.input;
  const outputPrice = longContext ? (price.long_output ?? price.output) : price.output;
  const cachedPrice = longContext
    ? (price.long_cached_input ?? price.cached_input ?? inputPrice)
    : (price.cached_input ?? inputPrice);
  const cacheWritePrice = longContext
    ? (price.long_cache_write ?? price.cache_write ?? inputPrice)
    : (price.cache_write ?? inputPrice);
  return (
    sideCost(usage.inputTokens, inputPrice, modalityRates(price, INPUT_RATES), usage.modalityTokens?.input) +
    sideCost(usage.cachedInputTokens, cachedPrice, modalityRates(price, { audio: "cached_audio_input" }), usage.modalityTokens?.cachedInput) +
    usage.cacheWriteTokens * cacheWritePrice +
    sideCost(usage.outputTokens, outputPrice, modalityRates(price, OUTPUT_RATES), usage.modalityTokens?.output)
  ) / 1_000_000;
}

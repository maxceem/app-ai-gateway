/**
 * What one usage costs, in whole nano-dollars (ported from v1's
 * `computeCost`, with integer money, D20).
 *
 * - Tokens are split into buckets the way providers bill them: uncached
 *   input, cached input, cache writes and output. Each bucket takes its rate,
 *   falling back as v1 does: a missing cached or cache-write rate bills at the
 *   input rate, never free. Above the model's long-context threshold the
 *   `long_*` rates apply.
 * - A model that prices image, audio or video tokens apart bills each
 *   modality the response counted at its rate. Tokens the response did not
 *   account for, or a side it did not break down, bill at the highest rate the
 *   model has, so an image never passes at the text price.
 * - A variant (Anthropic's one-hour cache write, say) bills its share of the
 *   bucket at its own rate.
 *
 * The whole is rounded up once. A model priced per minute, per hour or per
 * image bills that measure instead (`priceUsage`).
 */
import { MILLI_SCALE, priceUnitsPer, priceUnitsSum, rate, toMilli, type NanoDollars, type RateNanoPerMillion } from "../money.ts";
import type { Modality, ModalityCounts, TokenCounts, TokenVariants, UsageObservation } from "../usage/observation.ts";
import { SERVICE_TIERS, STANDARD_MODE, type ServiceMode, type ServiceRegion, type ServiceTier } from "../usage/service-modes.ts";
import { bucketRates, modalityRate, VARIANTS, variantRate, type ModalityRate, type Variant } from "../usage/token-rates.ts";
import { listedModes, priceInMode, type ModelPrice } from "./prices.ts";

/** Token counts as a usage reader reports them. */
export type TokenUsage = TokenCounts;

export interface Pricing {
  readonly cost: NanoDollars;
  /**
   * The rates billed with, stored on the charge: the four buckets for a token
   * price (a units correction prices with them), plus each modality and
   * variant rate used.
   */
  readonly rates: Readonly<Record<string, RateNanoPerMillion>>;
  readonly longContext: boolean;
}

type Part = readonly [units: number, rate: RateNanoPerMillion];

const INPUT_RATES: Readonly<Partial<Record<Modality, ModalityRate>>> = { image: "image_input", audio: "audio_input", video: "video_input" };
const OUTPUT_RATES: Readonly<Partial<Record<Modality, ModalityRate>>> = { image: "image_output" };

function modalityRates(
  price: ModelPrice,
  fields: Readonly<Partial<Record<Modality, ModalityRate>>>,
  longContext: boolean,
  used: Record<string, RateNanoPerMillion>,
): [Modality, RateNanoPerMillion][] {
  return (Object.entries(fields) as [Modality, ModalityRate][]).flatMap(([modality, field]) => {
    const found = modalityRate(price.rates, field, longContext);
    if (found === undefined) return [];
    used[field] = found as RateNanoPerMillion;
    return [[modality, found as RateNanoPerMillion]];
  });
}

/** One side's tokens as parts, when the model prices some modalities apart from text. */
function sideParts(tokens: number, base: RateNanoPerMillion, rates: [Modality, RateNanoPerMillion][], counts: ModalityCounts | undefined): Part[] {
  if (rates.length === 0) return [[tokens, base]];
  const highest = rate(Math.max(base, ...rates.map(([, value]) => value)));
  if (!counts) return [[tokens, highest]];
  const unknown = Math.min(tokens, counts.unknown ?? 0);
  let rest = tokens - unknown;
  const parts: Part[] = [[unknown, highest]];
  for (const [modality, value] of rates) {
    const billed = Math.min(rest, counts[modality] ?? 0);
    parts.push([billed, value]);
    rest -= billed;
  }
  parts.push([rest, base]);
  return parts;
}

/** A variant count as something safe to bill: never negative or fractional. */
function variantCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** One bucket's tokens as parts, with the variants the response split out at their own rates. */
function bucketParts(
  bucket: "cached_input" | "cache_write",
  tokens: number,
  base: RateNanoPerMillion,
  price: ModelPrice,
  longContext: boolean,
  variants: TokenVariants | undefined,
  used: Record<string, RateNanoPerMillion>,
): Part[] {
  const counts = variants?.[bucket] as Partial<Record<string, unknown>> | undefined;
  if (!counts) return [[tokens, base]];
  let rest = tokens;
  const parts: Part[] = [];
  for (const variant of VARIANTS) {
    if (variant.bucket !== bucket) continue;
    const billed = Math.min(rest, variantCount(counts[variant.name]));
    if (billed === 0) continue;
    const value = variantRate(price.rates, variant, longContext, base) as RateNanoPerMillion;
    used[variant.field] = value;
    parts.push([billed, value]);
    rest -= billed;
  }
  parts.push([rest, base]);
  return parts;
}

const CACHED_MODALITIES = VARIANTS.filter((variant): variant is Variant & { modality: Modality } => variant.bucket === "cached_input" && variant.modality !== undefined);

/**
 * A prompt's modality counts and variants, with each modality that has a
 * cached-input variant (BytePlus's cached audio) split between the uncached
 * input and the cache. The rest is taken to be uncached first, at the full
 * modality rate, so where a response does not say what was cached the guess
 * bills high, never low.
 */
function splitCachedModalities(usage: UsageObservation): { input: ModalityCounts | undefined; tokenVariants: TokenVariants | undefined } {
  let input = usage.modalityTokens?.input;
  let tokenVariants = usage.tokenVariants;
  if (!input) return { input, tokenVariants };
  for (const variant of CACHED_MODALITIES) {
    const total = variantCount(input[variant.modality]);
    const shares = tokenVariants?.cached_input as Partial<Record<string, unknown>> | undefined;
    const reported = Math.min(usage.cachedInputTokens, variantCount(shares?.[variant.name]));
    if (reported === 0 && total <= usage.inputTokens) continue;
    const rest = Math.max(0, total - reported);
    const uncached = Math.min(rest, usage.inputTokens);
    const cached = Math.min(usage.cachedInputTokens, reported + rest - uncached);
    input = { ...input, [variant.modality]: uncached };
    tokenVariants = { ...tokenVariants, cached_input: { ...tokenVariants?.cached_input, [variant.name]: cached } };
  }
  return { input, tokenVariants };
}

/**
 * The cost of one usage at one price, or null when the price cannot bill
 * tokens: it has no input or output rate (a model priced per minute, say).
 */
export function priceTokens(price: ModelPrice, usage: UsageObservation): Pricing | null {
  const { rates } = price;
  if (rates.input === undefined || rates.output === undefined) return null;
  const prompt = usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens;
  const longContext = price.longContextThreshold !== undefined && prompt > price.longContextThreshold;
  const buckets = bucketRates({ ...rates, input: rates.input, output: rates.output }, longContext) as Record<
    "input" | "cached_input" | "cache_write" | "output",
    RateNanoPerMillion
  >;
  const used: Record<string, RateNanoPerMillion> = { ...buckets };
  const { input, tokenVariants } = splitCachedModalities(usage);
  const parts: Part[] = [
    ...sideParts(usage.inputTokens, buckets.input, modalityRates(price, INPUT_RATES, longContext, used), input),
    ...bucketParts("cached_input", usage.cachedInputTokens, buckets.cached_input, price, longContext, tokenVariants, used),
    ...bucketParts("cache_write", usage.cacheWriteTokens, buckets.cache_write, price, longContext, tokenVariants, used),
    ...sideParts(usage.outputTokens, buckets.output, modalityRates(price, OUTPUT_RATES, longContext, used), usage.modalityTokens?.output),
  ];
  return { cost: priceUnitsSum(parts), rates: used, longContext };
}

/**
 * The cost of a usage at a price per minute, per hour or per image (v1's
 * `costAt`), or undefined when the price is not one of those. Time is priced
 * on the audio's milliseconds, so the measure is a whole number; images on
 * their count. A measure the usage does not report prices as null: its
 * counter was never sent, and pricing it would claim a confident $0.
 */
function priceUnitRate(price: ModelPrice, usage: UsageObservation): Pricing | null | undefined {
  const { rates } = price;
  for (const [field, per] of [
    ["per_minute", 60 * MILLI_SCALE],
    ["per_hour", 3600 * MILLI_SCALE],
  ] as const) {
    const value = rates[field];
    if (value === undefined) continue;
    if (usage.audioSeconds === undefined) return null;
    return { cost: priceUnitsPer(toMilli(usage.audioSeconds), value, per), rates: { [field]: value }, longContext: false };
  }
  const perImage = rates.per_image;
  if (perImage === undefined) return undefined;
  if (usage.images === undefined) return null;
  return { cost: priceUnitsPer(usage.images, perImage, 1), rates: { per_image: perImage }, longContext: false };
}

/**
 * The cost of one usage at one price, in the unit the price is in: time or
 * images where it states one, else tokens. Null when the usage does not
 * report that unit (v1's `reportsPricedMeasure`): a duration alone for a
 * token-priced model, or tokens alone for a time-priced one.
 */
export function priceUsage(price: ModelPrice, usage: UsageObservation): Pricing | null {
  const unit = priceUnitRate(price, usage);
  if (unit !== undefined) return unit;
  if (usage.noTokens === true) return null;
  return priceTokens(price, usage);
}

/**
 * Whether a usage reports the measure a price bills (v1's
 * `reportsPricedMeasure`): a duration for a time price, an image count for an
 * image price, tokens for a token price.
 */
export function reportsPricedMeasure(price: ModelPrice, usage: UsageObservation): boolean {
  const { rates } = price;
  if (rates.per_minute !== undefined || rates.per_hour !== undefined) return usage.audioSeconds !== undefined;
  if (rates.per_image !== undefined) return usage.images !== undefined;
  return usage.noTokens !== true;
}

/**
 * The cost of one usage in the service mode that served it (v1's
 * `computeCost`). A mode the model has no price in is billed at an estimate,
 * on the axis that lacks a price only: a tier cheaper than standard at
 * standard, a dearer tier at the dearest tier the model is priced in, a region
 * at the dearest priced region. `estimated` says so.
 *
 * `doubt` is any reason the gateway is not sure what it is pricing: a mode
 * value it does not know, a served model it cannot tell, or any later one.
 * The one rule for every estimate, whatever made it one, is applied once, at
 * the end, after every path: an estimate is never billed below what the same
 * usage costs at the model's standard price (`AGENTS.md`).
 */
export function priceInServedMode(
  price: ModelPrice,
  usage: UsageObservation,
  served: ServiceMode = STANDARD_MODE,
  doubt = false,
): (Pricing & { readonly estimated: boolean }) | null {
  const priced = priceIn(price, usage, served);
  if (priced === null) return null;
  const estimated = priced.estimated || doubt;
  if (!estimated) return { ...priced, estimated: false };
  // The one floor, after every path: an estimate costs at least what the same
  // usage costs at the model's standard price, whichever axis lacked a price.
  const standard = priceUsage(priceInMode(price, STANDARD_MODE) ?? price, usage);
  return standard !== null && standard.cost > priced.cost ? { ...standard, estimated: true } : { ...priced, estimated: true };
}

function priceIn(price: ModelPrice, usage: UsageObservation, mode: ServiceMode): (Pricing & { readonly estimated: boolean }) | null {
  const served = priceInMode(price, mode);
  if (served !== undefined) {
    const priced = priceUsage(served, usage);
    return priced === null ? null : { ...priced, estimated: false };
  }
  const tiers = new Set<ServiceTier>();
  const regions = new Set<ServiceRegion>();
  // Priced on its own only: a tier or region that appears only inside a pair
  // has no price of its own.
  for (const listed of listedModes(price)) {
    if (listed.region === "global") tiers.add(listed.tier);
    else if (listed.tier === "standard") regions.add(listed.region);
  }
  const tierPriced = mode.tier === "standard" || tiers.has(mode.tier);
  const regionPriced = mode.region === "global" || regions.has(mode.region);
  const cheaper = SERVICE_TIERS[mode.tier].rank < SERVICE_TIERS.standard.rank;
  const tryTiers: ServiceTier[] = tierPriced ? [mode.tier] : cheaper ? ["standard"] : ["standard", ...tiers];
  const tryRegions: ServiceRegion[] = regionPriced ? [mode.region] : ["global", ...regions];
  let dearest: Pricing | null = null;
  for (const tier of tryTiers) {
    for (const region of tryRegions) {
      const candidate = priceInMode(price, { tier, region });
      const priced = candidate === undefined ? null : priceUsage(candidate, usage);
      if (priced !== null && (dearest === null || priced.cost > dearest.cost)) dearest = priced;
    }
  }
  const fallback = dearest ?? priceUsage(price, usage);
  return fallback === null ? null : { ...fallback, estimated: true };
}

/** All tokens of a usage: the main billed unit kept in the rollups. */
export function totalTokens(usage: TokenCounts): number {
  return usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens + usage.outputTokens;
}

/**
 * A usage's main billed unit and its count, kept on the charge and in the
 * rollups: the unit its price bills, else the one the usage reports. Audio is
 * in milliseconds (`audio_seconds` at `MILLI_SCALE`).
 */
export function billedUnits(usage: UsageObservation, price: ModelPrice | null): { unit: "tokens" | "audio_seconds" | "images"; units: number } {
  const rates = price?.rates;
  const byTime = rates !== undefined ? rates.per_minute !== undefined || rates.per_hour !== undefined : usage.noTokens === true;
  if (byTime && usage.audioSeconds !== undefined) return { unit: "audio_seconds", units: toMilli(usage.audioSeconds) };
  const byImage = rates !== undefined ? rates.per_image !== undefined : usage.noTokens === true;
  if (byImage && usage.images !== undefined) return { unit: "images", units: usage.images };
  return { unit: "tokens", units: totalTokens(usage) };
}

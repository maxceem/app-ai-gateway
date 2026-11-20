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
import { priceUnitsPer, priceUnitsSum, rate, toMilli, type NanoDollars, type RateNanoPerMillion } from "../money.ts";
import type { Unit } from "../providers/operation.ts";
import type { Modality, ModalityCounts, TokenCounts, TokenVariants, UsageObservation } from "../usage/observation.ts";
import { SERVICE_TIERS, STANDARD_MODE, type ServiceMode, type ServiceRegion, type ServiceTier } from "../usage/service-modes.ts";
import { bucketRates, modalityRate, VARIANTS, variantRate, type ModalityRate, type Variant } from "../usage/token-rates.ts";
import { keyCandidates, listedModes, priceInMode, type ModelPrice } from "./prices.ts";
import { UNIT_RATES, type UnitRate } from "./units.ts";

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
  /** The unit the price billed, and its count at the unit's scale: the charge's unit and units. */
  readonly unit: Unit | "tokens";
  readonly units: number;
  /** The measure billed was worked out from the request, not reported by the provider. */
  readonly fromEstimate: boolean;
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
  return { cost: priceUnitsSum(parts), rates: used, longContext, unit: "tokens", units: totalTokens(usage), fromEstimate: false };
}

/**
 * A usage's count in a unit, at the unit's scale, or undefined when the usage
 * does not report it. A transcription's duration and an image API's count
 * have fields of their own; every other unit is in `units`.
 */
export function unitCount(usage: UsageObservation, unit: Unit): number | undefined {
  const counted = usage.units?.[unit];
  if (counted !== undefined) return counted;
  if (unit === "audio_seconds" && usage.audioSeconds !== undefined) return toMilli(usage.audioSeconds);
  if (unit === "images" && usage.images !== undefined) return usage.images;
  return undefined;
}

/** The unit rates a price states, in table order. */
function statedUnitRates(price: ModelPrice): UnitRate[] {
  return UNIT_RATES.filter((unitRate) => price.rates[unitRate.field] !== undefined);
}

/**
 * The first unit a stated rate bills that the usage reports, with its count.
 * With `reportedOnly`, a unit worked out from the request is passed over.
 */
function reportedUnit(unitRate: UnitRate, usage: UsageObservation, reportedOnly = false): { unit: Unit; count: number } | null {
  for (const unit of unitRate.units) {
    if (reportedOnly && usage.estimatedUnits?.includes(unit) === true) continue;
    const count = unitCount(usage, unit);
    if (count !== undefined) return { unit, count };
  }
  return null;
}

/**
 * The cost of a usage at a unit rate (`./units.ts`: per minute, per image,
 * per million characters, ...), or undefined when the price states none.
 * A unit the provider reported is billed before one worked out from the
 * request (a header's credits before the request's characters); among them,
 * the table's order. A price with unit rates but none the usage reports
 * prices as null: the counter was never sent, and pricing it would claim a
 * confident $0. A price that also bills tokens falls back to them.
 */
function priceUnitRate(price: ModelPrice, usage: UsageObservation): Pricing | null | undefined {
  const stated = statedUnitRates(price);
  if (stated.length === 0) return undefined;
  const tokensReported = price.rates.input !== undefined && price.rates.output !== undefined && usage.noTokens !== true;
  for (const reportedOnly of [true, false]) {
    // Reported tokens the price bills come before a unit worked out from the request.
    if (!reportedOnly && tokensReported) return undefined;
    for (const unitRate of stated) {
      const reported = reportedUnit(unitRate, usage, reportedOnly);
      if (reported === null) continue;
      const value = price.rates[unitRate.field]!;
      return {
        cost: priceUnitsPer(reported.count, value, unitRate.per),
        rates: { [unitRate.field]: value },
        longContext: false,
        unit: reported.unit,
        units: reported.count,
        fromEstimate: usage.estimatedUnits?.includes(reported.unit) === true,
      };
    }
  }
  return price.rates.input !== undefined && price.rates.output !== undefined && usage.noTokens !== true ? undefined : null;
}

/**
 * The cost of one usage at one price, in the unit the price is in: a unit
 * rate where it states one the usage reports, else tokens. Null when the
 * usage does not report that unit (v1's `reportsPricedMeasure`): a duration
 * alone for a token-priced model, or tokens alone for a time-priced one.
 */
export function priceUsage(price: ModelPrice, usage: UsageObservation): Pricing | null {
  const unit = priceUnitRate(price, usage);
  if (unit !== undefined) return unit;
  if (usage.noTokens === true) return null;
  return priceTokens(price, usage);
}

/**
 * A usage priced on one given unit only, or null when the price has no rate
 * for it or the usage does not report it: the standard floor is worked out on
 * the same measure the chosen price billed.
 */
function priceOnUnit(price: ModelPrice, usage: UsageObservation, unit: Unit | "tokens"): Pricing | null {
  if (unit === "tokens") return usage.noTokens === true ? null : priceTokens(price, usage);
  const count = unitCount(usage, unit);
  if (count === undefined) return null;
  const unitRate = UNIT_RATES.find((candidate) => candidate.units.includes(unit) && price.rates[candidate.field] !== undefined);
  if (unitRate === undefined) return null;
  const value = price.rates[unitRate.field]!;
  return {
    cost: priceUnitsPer(count, value, unitRate.per),
    rates: { [unitRate.field]: value },
    longContext: false,
    unit,
    units: count,
    fromEstimate: usage.estimatedUnits?.includes(unit) === true,
  };
}

/**
 * The one rule for picking among prices of the same usage, wherever several
 * are tried (key candidates, the modes an estimate searches): one billing a
 * measure the provider reported before any billing the request's estimate;
 * among those, the dearest. Null when there are none.
 */
function preferred<P extends Pricing>(prices: readonly P[]): P | null {
  const reported = prices.filter((one) => !one.fromEstimate);
  const pool = reported.length > 0 ? reported : prices;
  let dearest: P | null = null;
  for (const one of pool) if (dearest === null || one.cost > dearest.cost) dearest = one;
  return dearest;
}

/** A charge's price, as one result: what both a live charge and the sweep write. */
export type ChargePricing = Pricing & {
  /** Billed at an estimate: a mode or key value with no price, a missing report, or any other doubt. */
  readonly estimated: boolean;
  /** `estimated` when the measure billed was worked out from the request, else `complete`. */
  readonly measured: "complete" | "estimated";
};

/**
 * The price of one usage, chosen once (v1's `computeCost`, plus price keys
 * and measures worked out from the request). The only place a charge's price,
 * unit, count and labels are decided; the live charge and the sweep use it.
 *
 * 1. Each candidate (the price, or one per listed value of a price key the
 *    request named no listed value for) is priced on its own, never merged,
 *    in the service mode that served the request, billing the measure the
 *    provider reported first, else the request's estimate.
 * 2. The dearest candidate that bills a reported measure wins; only when none
 *    can, the dearest that bills the estimate.
 * 3. An estimate (a mode or key value with no price, a missing report, or
 *    `doubt`: a mode value the gateway does not know, a served model it
 *    cannot tell, ...) is floored at the model's own standard price, before
 *    any key value or mode, worked out on the same measure (`AGENTS.md`).
 * 4. When no candidate can bill, the model's own standard price bills, as an
 *    estimate, if it can. Only otherwise is the usage unpriced (null).
 */
export function priceInServedMode(
  price: ModelPrice,
  usage: UsageObservation,
  served: ServiceMode = STANDARD_MODE,
  doubt = false,
): ChargePricing | null {
  const keyed = keyCandidates(price, usage.priceKeys);
  const priced: (Pricing & { readonly estimated: boolean })[] = [];
  for (const candidate of keyed.candidates) {
    const one = priceIn(candidate.price, usage, served);
    if (one !== null) priced.push(one);
  }
  const standardPrice = priceInMode(price, STANDARD_MODE) ?? price;
  const chosen = preferred(priced);
  if (chosen === null) {
    const standard = priceUsage(standardPrice, usage);
    return standard === null ? null : { ...standard, estimated: true, measured: standard.fromEstimate ? "estimated" : "complete" };
  }
  const estimated = chosen.estimated || doubt || keyed.estimated || usage.reportMissing === true;
  const measured = chosen.fromEstimate ? "estimated" : "complete";
  if (!estimated) return { ...chosen, estimated: false, measured };
  // The one floor: at least the model's own standard price on the same measure.
  const floor = priceOnUnit(standardPrice, usage, chosen.unit);
  return floor !== null && floor.cost > chosen.cost ? { ...floor, estimated: true, measured } : { ...chosen, estimated: true, measured };
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
  const tried: Pricing[] = [];
  for (const tier of tryTiers) {
    for (const region of tryRegions) {
      const candidate = priceInMode(price, { tier, region });
      const priced = candidate === undefined ? null : priceUsage(candidate, usage);
      if (priced !== null) tried.push(priced);
    }
  }
  const fallback = preferred(tried) ?? priceUsage(price, usage);
  return fallback === null ? null : { ...fallback, estimated: true };
}

/** All tokens of a usage: the main billed unit kept in the rollups. */
export function totalTokens(usage: TokenCounts): number {
  return usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens + usage.outputTokens;
}

/**
 * The unit and count an unpriced usage is kept under, on the charge and in
 * the rollups: the unit it reports (an estimate's only when it reports
 * nothing else), else its tokens. A priced usage is kept under the unit its
 * price billed (`Pricing.unit`). Counts are at the unit's scale.
 */
export function reportedUnits(usage: UsageObservation): { unit: Unit | "tokens"; units: number } {
  if (usage.noTokens === true) {
    const entries = Object.entries(usage.units ?? {}).filter(([, count]) => count !== undefined) as [Unit, number][];
    const reported = entries.find(([unit]) => usage.estimatedUnits?.includes(unit) !== true) ?? entries[0];
    if (reported !== undefined) return { unit: reported[0], units: reported[1] };
    if (usage.audioSeconds !== undefined) return { unit: "audio_seconds", units: toMilli(usage.audioSeconds) };
    if (usage.images !== undefined) return { unit: "images", units: usage.images };
  }
  return { unit: "tokens", units: totalTokens(usage) };
}

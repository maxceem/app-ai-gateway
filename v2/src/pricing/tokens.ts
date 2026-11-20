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
import { log } from "../core/log.ts";
import { assertStorable, compareExact, exactCost, MoneyError, rate, roundUp, toMilli, type ExactCost, type NanoDollars, type RateNanoPerMillion } from "../money.ts";
import type { Unit } from "../providers/operation.ts";
import type { Modality, ModalityCounts, TokenCounts, TokenVariants, UsageObservation } from "../usage/observation.ts";
import { SERVICE_TIERS, STANDARD_MODE, type ServiceMode, type ServiceRegion, type ServiceTier } from "../usage/service-modes.ts";
import { bucketRates, modalityRate, VARIANTS, variantRate, type ModalityRate, type Variant } from "../usage/token-rates.ts";
import { chargeCandidates, modeAxes, priceInMode, type ModelPrice } from "./prices.ts";
import { UNIT_RATES, type UnitRate } from "./units.ts";

/** Token counts as a usage reader reports them. */
export type TokenUsage = TokenCounts;

export interface Pricing {
  readonly cost: NanoDollars;
  /** The cost before rounding, so candidates are compared exactly and only the winner is rounded. */
  readonly exact: ExactCost;
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
  /** The billed measure's rank (`measureRank`): which one wins comes from it first, then the dearest. */
  readonly rank: MeasureRank;
}

/**
 * How a measure ranks when a usage has several a price can bill: the
 * provider's own billing unit (and its tokens) first, then a usage measure it
 * reported beside it (`secondaryUnits`), then the request's estimate. A
 * customer's rate per credit bills the credits, never a dearer duration.
 */
export type MeasureRank = 0 | 1 | 2;

function measureRank(usage: UsageObservation, unit: Unit | "tokens"): MeasureRank {
  if (unit === "tokens") return 0;
  if (usage.estimatedUnits?.includes(unit) === true) return 2;
  return usage.secondaryUnits?.includes(unit) === true ? 1 : 0;
}

/**
 * A price before rounding: what candidates are compared on. Only the chosen
 * one is rounded, once (`withCost`); a candidate whose cost could not be
 * stored is refused before that (`assertStorable`).
 */
type Candidate = Omit<Pricing, "cost">;

/** A candidate's cost rounded, once: it has passed `assertStorable`, so this cannot overflow. */
function withCost<C extends Candidate>(candidate: C): C & { readonly cost: NanoDollars } {
  return { ...candidate, cost: roundUp(candidate.exact) };
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
  const candidate = tokenCandidate(price, usage);
  return candidate === null ? null : withCost(candidate);
}

/** `priceTokens` before rounding. */
function tokenCandidate(price: ModelPrice, usage: UsageObservation): Candidate | null {
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
  const exact = exactCost(parts.map(([units, value]) => [units, value, 1_000_000] as const));
  assertStorable(exact);
  return { exact, rates: used, longContext, unit: "tokens", units: totalTokens(usage), fromEstimate: false, rank: 0 };
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

/** What divides a count at a rate: the unit rate's amount (`./units.ts`), else a million (a token rate). */
export function rateDivisor(field: string): number {
  return UNIT_RATES.find((unitRate) => unitRate.field === field)?.per ?? 1_000_000;
}

/**
 * The one cost formula for counts at named rates: Σ count × rate ÷ the rate's
 * divisor, rounded up once. A live charge on a unit rate and a settlement's
 * final units both use it, so the same count at the same rate always costs
 * the same.
 */
export function costOfRates(parts: readonly (readonly [field: string, count: number, rate: RateNanoPerMillion])[]): NanoDollars {
  return roundUp(exactOfRates(parts));
}

/** `costOfRates` before rounding. */
function exactOfRates(parts: readonly (readonly [field: string, count: number, rate: RateNanoPerMillion])[]): ExactCost {
  return exactCost(parts.map(([field, count, value]) => [count, value, rateDivisor(field)] as const));
}

/** `costOfRates` for one count at one rate. */
export function costAtRate(field: string, count: number, value: RateNanoPerMillion): NanoDollars {
  return costOfRates([[field, count, value]]);
}

/** A usage priced on one unit rate, for one unit it bills. */
function atUnitRate(price: ModelPrice, unitRate: UnitRate, unit: Unit, count: number, usage: UsageObservation): Candidate {
  const value = price.rates[unitRate.field]!;
  const exact = exactOfRates([[unitRate.field, count, value]]);
  assertStorable(exact);
  return {
    exact,
    rates: { [unitRate.field]: value },
    longContext: false,
    unit,
    units: count,
    fromEstimate: usage.estimatedUnits?.includes(unit) === true,
    rank: measureRank(usage, unit),
  };
}

/**
 * The unit-rate options a price has for a usage at one measure rank
 * (`measureRank`): the provider's billing units, the usage measures it
 * reported beside them, or the units worked out from the request. An
 * option is priced only when it can win, so a rate whose cost cannot be
 * stored voids its candidate only if it would have been billed. Pricing one
 * throws `MoneyError` when its cost cannot be stored (not isolated per
 * option: the whole candidate is refused, `isolated` in `priceInServedMode`,
 * so a charge never falls to a cheaper measure as if exact).
 */
function unitOptions(price: ModelPrice, usage: UsageObservation, units: (unit: Unit) => boolean, rank: MeasureRank): Candidate[] {
  const options: Candidate[] = [];
  for (const unitRate of UNIT_RATES) {
    if (price.rates[unitRate.field] === undefined) continue;
    for (const unit of unitRate.units) {
      if (!units(unit) || measureRank(usage, unit) !== rank) continue;
      const count = unitCount(usage, unit);
      if (count !== undefined) options.push(atUnitRate(price, unitRate, unit, count, usage));
    }
  }
  return options;
}

/**
 * The cost of a usage at a unit rate (`./units.ts`: per minute, per image,
 * per million characters, ...), or undefined when the price states none.
 * The order a measure can win in: a billing unit the provider reported (the
 * dearest of those, `preferred`), then reported tokens the price bills, then
 * a usage measure the provider reported beside its billing unit (an audio
 * length beside credits), then a unit worked out from the request (a header's
 * credits before the request's characters). A price with unit rates but none the usage reports prices as
 * null: the counter was never sent, and pricing it would claim a confident
 * $0. A price that also bills tokens falls back to them.
 */
function priceUnitRate(price: ModelPrice, usage: UsageObservation): Candidate | null | undefined {
  if (!UNIT_RATES.some((unitRate) => price.rates[unitRate.field] !== undefined)) return undefined;
  const billsTokens = price.rates.input !== undefined && price.rates.output !== undefined && usage.noTokens !== true;
  const billed = preferred(unitOptions(price, usage, () => true, 0));
  if (billed !== null) return billed;
  if (billsTokens) return undefined;
  return preferred([...unitOptions(price, usage, () => true, 1), ...unitOptions(price, usage, () => true, 2)]);
}

/**
 * A usage priced on one given unit only, reported or worked out from the
 * request as the usage says, or null when the price has no rate for it or the
 * usage does not report it. Throws `MoneyError` when its cost cannot be stored.
 */
function onUnit(price: ModelPrice, usage: UsageObservation, unit: Unit | "tokens"): Candidate | null {
  if (unit === "tokens") return usage.noTokens === true ? null : tokenCandidate(price, usage);
  return preferred(unitOptions(price, usage, (one) => one === unit, measureRank(usage, unit)));
}

/**
 * The dearest charge a price can make for a usage, at the best measure rank
 * it can bill (`preferred`): across the billing units the provider reported
 * and its tokens; only when it can bill none of them, across the usage
 * measures reported beside them; only then across the units worked out from
 * the request. Throws `MoneyError` when a cost it must compare cannot be stored.
 */
function dearestCharge(price: ModelPrice, usage: UsageObservation): Candidate | null {
  const tokens = usage.noTokens === true ? null : tokenCandidate(price, usage);
  const ranks = [0, 1, 2] as const;
  return preferred([...ranks.flatMap((rank) => unitOptions(price, usage, () => true, rank)), ...(tokens === null ? [] : [tokens])]);
}

/**
 * The cost of one usage at one price, in the unit the price is in: a unit
 * rate where it states one the usage reports, else tokens. Null when the
 * usage does not report that unit (v1's `reportsPricedMeasure`): a duration
 * alone for a token-priced model, or tokens alone for a time-priced one.
 */
export function priceUsage(price: ModelPrice, usage: UsageObservation): Pricing | null {
  const candidate = usageCandidate(price, usage);
  return candidate === null ? null : withCost(candidate);
}

/** `priceUsage` before rounding. */
function usageCandidate(price: ModelPrice, usage: UsageObservation): Candidate | null {
  const unit = priceUnitRate(price, usage);
  if (unit !== undefined) return unit;
  if (usage.noTokens === true) return null;
  return tokenCandidate(price, usage);
}

/**
 * The one rule for picking among prices of the same usage, wherever several
 * are tried (a usage's measures, key candidates, the modes an estimate
 * searches): the best measure rank first (`measureRank`: the provider's
 * billing unit, then a usage measure it reported, then the request's
 * estimate); within it, the dearest. Null when there are none.
 */
function preferred<P extends Candidate>(prices: readonly P[]): P | null {
  const best = Math.min(...prices.map((one) => one.rank));
  let dearest: P | null = null;
  for (const one of prices) if (one.rank === best && (dearest === null || compareExact(one.exact, dearest.exact) > 0)) dearest = one;
  return dearest;
}

/** The dearest of several prices, whatever their measure: the floor takes the higher, never the cheaper. */
function preferredAny(prices: readonly (Candidate | null)[]): Candidate | null {
  let dearest: Candidate | null = null;
  for (const one of prices) if (one !== null && (dearest === null || compareExact(one.exact, dearest.exact) > 0)) dearest = one;
  return dearest;
}

/**
 * One candidate's price, or null when it cannot be worked out because a rate
 * or count is too large to store: that candidate is skipped and logged, and
 * the others still compete. A charge none can price is left unresolved.
 */
function isolated<P>(price: () => P | null, facts: Record<string, unknown>): P | null {
  try {
    return price();
  } catch (error) {
    if (!(error instanceof MoneyError)) throw error;
    log("warn", "price_candidate_too_large", { ...facts, error: error.message });
    return null;
  }
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
 *    any key value or mode: the dearer of that price on the unit the
 *    estimate billed, and the dearest charge that price can make across every
 *    measure the provider reported (the request's estimate only when none can
 *    be billed). An estimate bills more than either, never less (`AGENTS.md`).
 *
 * A candidate whose cost cannot be stored is skipped and logged; a floor that
 * cannot be stored leaves the usage unpriced, never billed below it.
 * 4. When no candidate can bill, the model's own standard price bills, as an
 *    estimate, if it can. Only otherwise is the usage unpriced (null).
 */
export function priceInServedMode(
  price: ModelPrice,
  usage: UsageObservation,
  served: ServiceMode = STANDARD_MODE,
  doubt = false,
): ChargePricing | null {
  // The one candidate list, which eligibility judges too (`chargeCandidates`).
  const keyed = chargeCandidates(price, usage.priceKeys);
  const priced: (Candidate & { readonly estimated: boolean })[] = [];
  for (const candidate of keyed.keyed) {
    const one = isolated(() => priceIn(candidate, usage, served), { candidate: "key" });
    if (one !== null) priced.push(one);
  }
  const standardPrice = keyed.fallback;
  const chosen = preferred(priced);
  if (chosen === null) {
    const standard = isolated(() => usageCandidate(standardPrice, usage), { candidate: "standard" });
    if (standard === null) return null;
    const standardMeasured: ChargePricing["measured"] = standard.fromEstimate ? "estimated" : "complete";
    return withCost({ ...standard, estimated: true, measured: standardMeasured });
  }
  const estimated = chosen.estimated || doubt || keyed.estimated || usage.reportMissing === true;
  const measured: ChargePricing["measured"] = chosen.fromEstimate ? "estimated" : "complete";
  if (!estimated) return withCost({ ...chosen, estimated: false, measured });
  // The one floor, both parts applied: the dearer of (a) the model's own standard price on the unit the
  // estimate billed, so it never bills below the standard rate for its own unit, and (b) the dearest charge
  // the standard price can make for this usage (`dearestCharge`), so it never bills below base whichever
  // unit won. A floor that cannot be stored is never dropped for the lower estimate: the charge is left
  // unresolved.
  let floor: Candidate | null;
  try {
    floor = preferredAny([onUnit(standardPrice, usage, chosen.unit), dearestCharge(standardPrice, usage)]);
  } catch (error) {
    if (!(error instanceof MoneyError)) throw error;
    log("error", "price_floor_too_large", { error: error.message });
    return null;
  }
  const billed = floor !== null && compareExact(floor.exact, chosen.exact) > 0 ? floor : chosen;
  // The label follows the measure actually billed: the floor may bill the request's estimate.
  return withCost({ ...billed, estimated: true, measured: billed.fromEstimate ? "estimated" : measured });
}

function priceIn(price: ModelPrice, usage: UsageObservation, mode: ServiceMode): (Candidate & { readonly estimated: boolean }) | null {
  const served = priceInMode(price, mode);
  if (served !== undefined) {
    const priced = usageCandidate(served, usage);
    return priced === null ? null : { ...priced, estimated: false };
  }
  // Priced on its own only: a tier or region that appears only inside a pair
  // has no price of its own (the same axes `servedModes` combines).
  const { tiers, regions } = modeAxes(price);
  const tierPriced = mode.tier === "standard" || tiers.has(mode.tier);
  const regionPriced = mode.region === "global" || regions.has(mode.region);
  const cheaper = SERVICE_TIERS[mode.tier].rank < SERVICE_TIERS.standard.rank;
  const tryTiers: ServiceTier[] = tierPriced ? [mode.tier] : cheaper ? ["standard"] : ["standard", ...tiers];
  const tryRegions: ServiceRegion[] = regionPriced ? [mode.region] : ["global", ...regions];
  const tried: Candidate[] = [];
  for (const tier of tryTiers) {
    for (const region of tryRegions) {
      const priced = isolated(() => {
        const candidate = priceInMode(price, { tier, region });
        return candidate === undefined ? null : usageCandidate(candidate, usage);
      }, { tier, region });
      if (priced !== null) tried.push(priced);
    }
  }
  const fallback = preferred(tried) ?? usageCandidate(price, usage);
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

/**
 * The unit, count and `measured` label a charge keeps for its usage: a priced
 * one's from its pricing result, an unpriced one's from the unit it reports
 * (`reportedUnits`), estimated when that unit was worked out from the request.
 * The one place a charge's measure is labelled; a cut answer is `partial`
 * whatever this says.
 */
export function chargedMeasure(
  priced: ChargePricing | null,
  usage: UsageObservation,
): { readonly unit: Unit | "tokens"; readonly units: number; readonly measured: "complete" | "estimated" } {
  if (priced !== null) return { unit: priced.unit, units: priced.units, measured: priced.measured };
  const kept = reportedUnits(usage);
  const estimated = kept.unit !== "tokens" && usage.estimatedUnits?.includes(kept.unit) === true;
  return { ...kept, measured: estimated ? "estimated" : "complete" };
}

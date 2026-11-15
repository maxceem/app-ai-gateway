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
import type { ModalityCounts, ModalityTokens, UsageCounts } from "../core/types";
import type { ProviderPricing } from "../db/schema";
import { baseUrlRegion, type ProviderType, providerDescriptor, reportsCost } from "../shared/providers";
import { GATEWAY_DESCRIPTORS } from "../shared/gateways";
import type { ApiStyle, ProviderRoute } from "../shared/capabilities";
import { type KindCatalog, type ModelKind, modelKind } from "../shared/model-kinds";
import {
  SERVICE_TIERS,
  isStandardMode,
  parseServiceModeName,
  priceInMode,
  readServiceMode,
  serviceModeName,
  STANDARD_MODE,
  type ServiceMode,
  type ServiceModeField,
  type ServiceModeValue,
  type ServiceRegion,
  type ServiceTier,
} from "../shared/service-modes";
import {
  TOKEN_RATE_FIELDS,
  VARIANTS,
  bucketRates,
  type Modality,
  type ModalityRate,
  modalityRate,
  type SplitBucket,
  type ModePrice,
  type TokenPrice,
  type TokenRateField,
  type TokenVariants,
  type Variant,
  variantRate,
} from "../shared/token-rates";

/**
 * A catalog entry. Its per-token rates are the ones `src/shared/token-rates.ts`
 * names: a modality rate absent means that modality bills at `input` or
 * `output`, and every other absent rate falls back as `bucketRates` says.
 */
interface Price extends Partial<Record<TokenRateField, number>> {
  /** What the model does, which decides the custom endpoints it may serve. */
  kind: ModelKind;
  per_minute?: number;
  per_hour?: number;
  /**
   * What one generated image costs, for a model billed per image rather than
   * per token. Only where the response counts the images it billed for, as
   * BytePlus Seedream's `usage.generated_images` does; a price that also
   * depends on size, quality or steps has no exact figure here.
   */
  per_image?: number;
  long_context_threshold?: number;
  /**
   * Who made the model, where the catalog knows better than the provider type
   * does — a Llama model served by Groq is Meta's. Curated per entry alongside
   * the prices; absent falls back to the provider type's own author.
   */
  author?: string;
  /**
   * The day (`YYYY-MM-DD`) the provider stops, or stopped, serving the model,
   * kept current by price-list updates. Informational: a retired model
   * stays priced, so an app that still names it keeps billing exactly.
   */
  retirement_date?: string;
  /**
   * The day (`YYYY-MM-DD`) the provider's official price page stopped listing
   * or pricing the model, kept current by price-list updates. Informational:
   * the entry keeps the last rates that page gave, so an app that still names
   * the model keeps working and billing, and the provider decides whether it
   * still serves it. Absent once the page prices the model again.
   */
  unlisted_since?: string;
  /**
   * Price changes a provider has announced, earliest first, kept current by
   * price-list updates. Each names the day it takes effect (`from`,
   * `YYYY-MM-DD`, from 00:00 UTC) and only the rates that change then, under
   * the same names as the entry's own; a rate it leaves out keeps its value.
   * The entry's own rates are the ones in force today. Billing does not read
   * this yet: a price-list update folds a change into those rates on its day.
   */
  price_changes?: PriceChange[];
  /**
   * What the model costs in each service mode it is sold in other than the
   * standard one, keyed by the mode's name (`flex`, `fast`, `us`, `fast+us`;
   * see `serviceModeName`). A mode it does not list has no price. See
   * {@link priceInMode} for how an entry and a combination are read.
   */
  modes?: Record<string, ModePrice>;
}

/** One announced change to a catalog entry's rates; see `Price.price_changes`. */
export interface PriceChange extends Partial<Record<TokenRateField, number>> {
  from: string;
  per_minute?: number;
  per_hour?: number;
  per_image?: number;
  long_context_threshold?: number;
  /** Mode entries replaced from that day, whole; a mode it leaves out keeps its entry. */
  modes?: Record<string, ModePrice>;
}

export interface UsageObservation extends UsageCounts {
  audioSeconds?: number;
  /** The images the response says it generated and billed, for a per-image model. */
  images?: number;
  modalityTokens?: ModalityTokens;
  /** The parts of a bucket the response split out to bill apart; see `TOKEN_VARIANTS`. */
  tokenVariants?: TokenVariants;
  /**
   * The values the response names its served mode with, as the readers found
   * them (`REPORTED_MODE_FIELDS` in `./usage-readers.ts`). The provider's own
   * table says what they mean.
   */
  reportedModes?: Partial<Record<string, string>>;
  /**
   * Set when a reported mode was read by scanning the text of a body too big
   * to keep whole, rather than from a value parsed whole: the client may have
   * written it, echoed back.
   */
  modesScanned?: true;
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
 *
 * An override replaces the catalog's rates rather than merging over them: a
 * provider that resells a model at its own input and output price has not said
 * it passes on the catalog's cache discount, so a rate the override leaves out
 * falls back as it would on a catalog entry without it, never to the catalog's
 * figure. Only the model's kind still comes from the catalog.
 */
function modelPrice(
  provider: ProviderType,
  model: string,
  overrides?: ProviderPricing | null,
): Price | undefined {
  const override = lookup(overrides, model);
  if (override) {
    const price: Price = { kind: catalogKind(provider, model, overrides) ?? "text" };
    // Copied field by field from the list the override schema was built from,
    // so a stored row can never carry anything else into the arithmetic.
    for (const field of TOKEN_RATE_FIELDS) {
      const rate = override[field];
      if (typeof rate === "number") price[field] = rate;
    }
    if (typeof override.long_context_threshold === "number") {
      price.long_context_threshold = override.long_context_threshold;
    }
    // An override with modes of its own is used as written, `{}` included,
    // which prices no mode. One without keeps the catalog's factors: a price
    // set because the list's was stale or missing says nothing against the
    // provider's modes, but a rate the list states for a mode is the list's
    // figure, not the override's, so only each mode's factor applies.
    const modes = override.modes ?? modeFactors(catalogPrice(provider, model)?.modes);
    if (modes) price.modes = modes;
    return price;
  }
  return catalogPrice(provider, model);
}

/** Each mode's factor alone, without the rates a price list states for it. */
function modeFactors(modes: Record<string, ModePrice> | undefined): Record<string, ModePrice> | undefined {
  if (!modes) return undefined;
  return Object.fromEntries(Object.entries(modes).map(([name, entry]) => [name, { factor: entry.factor ?? 1 }]));
}

/**
 * A model's kind on one provider type, or `null` where neither the catalog nor
 * the row's own prices know it — see `modelKind` in `src/shared/model-kinds.ts`,
 * which the console runs over the same catalog.
 */
export function catalogKind(
  provider: ProviderType,
  model: string,
  overrides?: ProviderPricing | null,
): ModelKind | null {
  return modelKind(models as KindCatalog, provider, model, overrides);
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
  if (price.per_image !== undefined) return Number.isFinite(price.per_image) && price.per_image >= 0;
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
 * Whether a model has a price in a service mode: always in the standard one,
 * and in any other only where its entry lists the mode — see
 * {@link priceInMode}. Where it has none, {@link computeCost} bills an
 * estimate and the event is recorded as `estimated`.
 */
export function hasModePrice(
  provider: ProviderType,
  model: string,
  overrides: ProviderPricing | null | undefined,
  mode: ServiceMode,
): boolean {
  if (isStandardMode(mode)) return true;
  const price = modelPrice(provider, model, overrides);
  return price !== undefined && priceInMode(price, mode) !== undefined;
}

/**
 * Whether a request can be billed at all, which is the only reason it is
 * allowed to proxy. Two ways to know what it costs: a local price for the
 * canonical model, or a route that reports its own cost per request. Neither
 * means the spend would be invisible, and an invisible spend is a limit bypass.
 * `style` is the request's API, or `null` on a configuration write that has
 * none yet — see `routeCostReport`. The service mode never stops a request: see
 * {@link requestedServiceMode} and {@link computeCost}.
 */
export function isBillable(
  provider: ProviderType,
  route: ProviderRoute | null,
  style: ApiStyle | null,
  model: string,
  overrides?: ProviderPricing | null,
): boolean {
  return reportsCost(provider, route, style) || hasModelPrice(provider, model, overrides);
}

/** The fields a request on this route names its service mode in: the provider's, and its gateway's own. */
function serviceModeFields(type: ProviderType, route: ProviderRoute): readonly ServiceModeField[] {
  const own = providerDescriptor(type).serviceModes;
  const gateway: readonly ServiceModeField[] = route === "direct" ? [] : GATEWAY_DESCRIPTORS[route].serviceModes;
  if (gateway.length === 0) return own;
  // A gateway field the gateway passes on as one of the provider's own is read
  // with the provider's table for it.
  const passedOn = gateway.map((field) => {
    const as = field.as;
    const target = as === undefined ? undefined : own.find((candidate) => candidate.names.includes(as));
    return target ? { ...target, names: field.names } : field;
  });
  return [...own, ...passedOn];
}

/**
 * The service mode a request asks one target for: read, never judged.
 *
 * `read` returns one field of the body as it will be sent — the client's JSON
 * merged with anything the configuration adds, or a form field — and the
 * target's own table says what its value means. The region is the one a field
 * names, else the one the row's own base URL serves (`regionalOrigins`).
 * `unknown` is the first value the table does not know, which leaves its axis
 * at the default.
 *
 * A mode a request chooses is never refused: an app may already rely on it,
 * and nothing can tell a mode it started using today from one that worked
 * yesterday. Whether it is billed exactly is decided once, where the event is
 * recorded, against the mode that actually served it (`usage-record.ts`). So
 * this is only a few property reads on a body already parsed. A mode the
 * owner's own configuration names is judged where it is saved instead, by
 * {@link configuredModeProblem}.
 */
export function requestedServiceMode(input: {
  type: ProviderType;
  route: ProviderRoute;
  /** The row's own base URL, whose host may pin a region. */
  baseUrl: string | null;
  read: (name: string) => unknown;
}): { mode: ServiceMode; unknown?: ServiceModeValue } {
  const reading = readServiceMode(serviceModeFields(input.type, input.route), input.read);
  const baseRegion = baseUrlRegion(input.type, input.baseUrl);
  const mode: ServiceMode = reading.mode.region === "global" && baseRegion !== "global"
    ? { tier: reading.mode.tier, region: baseRegion }
    : reading.mode;
  return reading.unknown ? { mode, unknown: reading.unknown } : { mode };
}

/**
 * Why a service mode the owner's configuration names — a custom endpoint's
 * `params` — cannot be billed on one target, or `null` when it can. Naming a
 * mode is choosing it, so a mode with no price is refused where it is saved,
 * as a model with no price is: the owner adds the price, or leaves the mode
 * out. A value the gateway does not know is refused too: chosen in the
 * configuration, it could never be priced. A region is not judged here: a
 * row's base URL is its own setting.
 */
export function configuredModeProblem(input: {
  type: ProviderType;
  route: ProviderRoute;
  pricing?: ProviderPricing | null;
  style: ApiStyle;
  model: string;
  read: (name: string) => unknown;
}): string | null {
  const { type, route } = input;
  if (reportsCost(type, route, input.style)) return null;
  const reading = readServiceMode(serviceModeFields(type, route), input.read);
  if (reading.unknown) {
    const { field, value } = reading.unknown;
    return `${field}: "${value}" is not a service mode the gateway knows for ${type}, so it cannot be priced. `
      + `Leave ${field} out of the parameters.`;
  }
  if (hasModePrice(type, input.model, input.pricing, reading.mode)) return null;
  const asked = reading.askedBy.map((field) => `${field.field}: "${field.value}"`).join(", ");
  const fields = reading.askedBy.map((field) => field.field).join(" and ");
  return `Model ${input.model} has no price on ${type} in service mode ${serviceModeName(reading.mode)}, `
    + `which the parameters set with ${asked}. Add a price for that mode under custom model pricing in the `
    + `provider settings, or leave ${fields} out of the parameters.`;
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
 * in. A time-priced model needs a duration, an image-priced one an image count
 * and a token-priced one token counts; anything else would compute a confident
 * $0 from the counters left at zero — a free-looking request that escapes every
 * budget. `true` where no
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
  if (price.per_image !== undefined) return usage.images !== undefined;
  return usage.durationOnly !== true;
}

const INPUT_RATES = { image: "image_input", audio: "audio_input", video: "video_input" } as const;
const OUTPUT_RATES = { image: "image_output" } as const;

/** The modalities a model prices apart on one side, with their rates in or out of long context. */
function modalityRates(
  price: Price,
  fields: Partial<Record<Modality, ModalityRate>>,
  longContext: boolean,
): [Modality, number][] {
  return (Object.entries(fields) as [Modality, ModalityRate][]).flatMap(([modality, field]) => {
    const rate = modalityRate(price, field, longContext);
    return rate === undefined ? [] : [[modality, rate] as [Modality, number]];
  });
}

/**
 * What one side's tokens cost when the model prices some modalities apart from
 * text. Each modality the response counted bills at its own rate and the rest
 * at `base`. Tokens it did not account for, and a whole side it did not break
 * down, bill at the highest rate the model has, rather than let an image or a
 * recording pass at the text price and escape the budget it should consume.
 *
 * A modality count covers the whole prompt, cached part included, so the
 * modality tokens are taken out of `tokens`, unknown ones first, and never
 * exceed it. {@link splitCachedModalities} has already moved out what the
 * cache holds, where the price bills a modality's cached part apart.
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
    && [false, true].some((longContext) =>
      modalityRates(price, INPUT_RATES, longContext).length > 0
      || modalityRates(price, OUTPUT_RATES, longContext).length > 0);
}

/**
 * What one usage figure costs, in the service mode that served it.
 *
 * A served mode the model has no price in is billed at an estimate, on the
 * axis that lacks a price only: a tier cheaper than standard at standard, a
 * dearer tier at the dearest tier the model is priced in, a region at the
 * dearest priced region, while the axis that is priced keeps its own value.
 * Such an event is recorded as `estimated`.
 */
export function computeCost(
  provider: ProviderType,
  model: string,
  usage: UsageObservation,
  overrides?: ProviderPricing | null,
  mode: ServiceMode = STANDARD_MODE,
): number | null {
  const price = modelPrice(provider, model, overrides);
  if (!price) return null;
  const served = priceInMode(price, mode);
  if (served) return costAt(served, usage);
  // Searched on the axis that has no price only: the served tier is kept
  // where the model prices it, and so is the served region. An unpriced tier
  // cheaper than standard (flex) bills at standard, never at a dearer tier; an
  // unpriced dearer one at the dearest tier the model is priced in, a pair that
  // only composes (`fast` in `us`) included; an unpriced region at the dearest
  // priced region.
  const tiers = new Set<ServiceTier>();
  const regions = new Set<ServiceRegion>();
  // Priced on its own only: a tier or region that appears only inside a pair
  // (`priority+eu`) has no price of its own, and the pair is still reached
  // through `priceInMode` when both of its parts are tried.
  for (const name of Object.keys(price.modes ?? {})) {
    const listed = parseServiceModeName(name);
    if (!listed) continue;
    if (listed.region === "global") tiers.add(listed.tier);
    else if (listed.tier === "standard") regions.add(listed.region);
  }
  const tierPriced = mode.tier === "standard" || tiers.has(mode.tier);
  const regionPriced = mode.region === "global" || regions.has(mode.region);
  const cheaper = SERVICE_TIERS[mode.tier].rank < SERVICE_TIERS.standard.rank;
  const tryTiers = tierPriced ? [mode.tier] : cheaper ? ["standard" as const] : ["standard" as const, ...tiers];
  const tryRegions = regionPriced ? [mode.region] : ["global" as const, ...regions];
  let dearest: number | null = null;
  for (const tier of tryTiers) {
    for (const region of tryRegions) {
      const priced = priceInMode(price, { tier, region });
      const cost = priced ? costAt(priced, usage) : null;
      if (cost !== null && (dearest === null || cost > dearest)) dearest = cost;
    }
  }
  return dearest ?? costAt(price, usage);
}

function costAt(price: Price, usage: UsageObservation): number | null {
  if (price.per_minute !== undefined) {
    return ((usage.audioSeconds ?? 0) / 60) * price.per_minute;
  }
  if (price.per_hour !== undefined) {
    return ((usage.audioSeconds ?? 0) / 3600) * price.per_hour;
  }
  if (price.per_image !== undefined) {
    return (usage.images ?? 0) * price.per_image;
  }
  if (price.input === undefined || price.output === undefined) return null;
  const promptTokens = usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens;
  const longContext =
    price.long_context_threshold !== undefined && promptTokens > price.long_context_threshold;
  const rates = bucketRates(price as Price & TokenPrice, longContext);
  const { input, tokenVariants } = splitCachedModalities(usage);
  return (
    sideCost(usage.inputTokens, rates.input, modalityRates(price, INPUT_RATES, longContext), input) +
    variantCost("cached_input", usage.cachedInputTokens, rates.cached_input, price, longContext, tokenVariants) +
    variantCost("cache_write", usage.cacheWriteTokens, rates.cache_write, price, longContext, tokenVariants) +
    sideCost(
      usage.outputTokens,
      rates.output,
      modalityRates(price, OUTPUT_RATES, longContext),
      usage.modalityTokens?.output,
    )
  ) / 1_000_000;
}

/** The cached-input variants that are one modality's share of the cache. */
const CACHED_MODALITIES = VARIANTS.filter(
  (variant): variant is Variant & { modality: Modality } =>
    variant.bucket === "cached_input" && variant.modality !== undefined,
);

/**
 * A prompt's modality counts and token variants, with each modality that has a
 * cached-input variant (BytePlus's cached audio) split between the uncached
 * input and the cache.
 *
 * The count covers the whole prompt, and the variant is the part of it the
 * response reported as cached. The rest is taken to be uncached first, at the
 * modality's full rate, and only what the uncached input cannot hold is moved
 * into the variant: where a response does not say what was cached — BytePlus
 * under an explicit cache — the guess bills high rather than low, as images do
 * under OpenAI's `cached_tokens`. A count that fits the uncached input, with
 * nothing reported cached, comes back as it came, without a copy.
 */
function splitCachedModalities(
  usage: UsageObservation,
): { input: ModalityCounts | undefined; tokenVariants: TokenVariants | undefined } {
  let input = usage.modalityTokens?.input;
  let tokenVariants = usage.tokenVariants;
  if (!input) return { input, tokenVariants };
  for (const variant of CACHED_MODALITIES) {
    const total = variantCount(input[variant.modality]);
    const shares: Partial<Record<string, unknown>> | undefined = tokenVariants?.cached_input;
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
 * A variant count as something safe to bill: a stored row is JSON, and a
 * negative, fractional or non-numeric figure must never lower a cost.
 */
function variantCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * What one bucket's tokens cost when the response split some of them out as
 * variants billed at their own rate (see `TOKEN_VARIANTS`). The variants are
 * taken out of the bucket in a fixed order and never past it, so together they
 * can claim no more than the bucket holds and no token bills twice; the rest
 * bills at `base`, the bucket's own rate. A response that split nothing costs
 * one multiplication, as it did before variants existed.
 */
function variantCost(
  bucket: SplitBucket,
  tokens: number,
  base: number,
  price: Price,
  longContext: boolean,
  variants: TokenVariants | undefined,
): number {
  const counts: Partial<Record<string, unknown>> | undefined = variants?.[bucket as keyof TokenVariants];
  if (!counts) return tokens * base;
  let rest = tokens;
  let cost = 0;
  for (const variant of VARIANTS) {
    if (variant.bucket !== bucket) continue;
    const billed = Math.min(rest, variantCount(counts[variant.name]));
    if (billed === 0) continue;
    cost += billed * variantRate(price, variant, longContext, base);
    rest -= billed;
  }
  return cost + rest * base;
}

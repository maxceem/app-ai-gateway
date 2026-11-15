/**
 * Every per-token rate a model price may carry, and the rules for which rate a
 * token bills at, in one place.
 *
 * The rest of the code reads this file rather than restating it:
 *
 * - the cost arithmetic in `src/usage/pricing.ts` bills through
 *   {@link bucketRates} and {@link variantRate};
 * - the response readers in `src/usage/usage-readers.ts` read each variant's
 *   count from where {@link TOKEN_VARIANTS} says a response reports it;
 * - the override schema in `src/contracts/schemas.ts` and the catalog schema
 *   in `src/contracts/responses.ts` are built from {@link TOKEN_RATE_FIELDS}.
 *
 * So a rate added here is at once priceable, readable, overridable and
 * documented.
 */

import type { ApiStyle } from "./capabilities.ts";
import type { ProviderType } from "./providers.ts";

/** The buckets a variant may split. Input and output split by modality instead. */
export type SplitBucket = "cached_input" | "cache_write";

/** The kinds of token a provider may price apart from text. */
export type Modality = "image" | "audio" | "video";

/**
 * A named part of a token bucket that a provider bills at a rate of its own.
 *
 * `reportedAt` lists the paths, from a response's `usage` object, where a
 * provider may report the count of the bucket's tokens that were this variant;
 * the first one present is read. They are read from every usage object,
 * whatever its provider: each path is a field name only its own provider uses,
 * as with cache hits in `usage-readers.ts`.
 *
 * `modality` marks a variant that is the cached part of one modality's tokens.
 * A modality count covers the whole prompt, cached part included, so
 * `computeCost` takes the variant out of it before it bills the rest as
 * uncached.
 */
interface VariantSpec {
  /** The rate's description in the API reference. */
  readonly description: string;
  readonly reportedAt: readonly (readonly string[])[];
  readonly modality?: Modality;
  /**
   * Where one provider reports the count in a response header instead, because
   * its body on that API carries only the bucket's total. Unlike `reportedAt`,
   * a header is read only from that provider type's responses to that API, and
   * only where the body did not report the count itself.
   */
  readonly reportedInHeader?: HeaderReport;
}

/** A response header that carries one variant's count, as a whole number. */
interface HeaderReport {
  readonly provider: ProviderType;
  readonly style: ApiStyle;
  /** Written lowercase; `Headers` matches names case-insensitively. */
  readonly header: string;
}

/**
 * Named parts of a canonical token bucket that a provider bills at a rate of
 * their own. The four canonical buckets — uncached input, cached input, cache
 * writes and output — are the only token counts stored as columns; a variant
 * is never extra tokens, only a share of its bucket. Its rate is
 * `<bucket>_<variant>`, and `long_<bucket>_<variant>` above the long-context
 * threshold; unpriced, it bills at its bucket's rate.
 *
 * Input and output are not listed: their split is by modality, which has its
 * own record because a modality count also covers the cached part of a prompt.
 *
 * Adding a variant is one entry here and the rates in the catalog.
 */
export const TOKEN_VARIANTS = {
  cached_input: {
    // BytePlus ModelArk: audio read from the cache bills at its own rate, 15x
    // the cached text rate on Seed 2.0 Lite. Chat Completions and Responses
    // report it under their own details object, and only when the cache was
    // implicit; with an explicit cache it is absent, see
    // `splitCachedModalities` in `src/usage/pricing.ts`.
    audio: {
      description: "USD per 1M cached audio input tokens, where they are priced apart from cached text input.",
      reportedAt: [
        ["prompt_tokens_details", "audio_cached_tokens"],
        ["input_tokens_details", "audio_cached_tokens"],
      ],
      modality: "audio",
    },
  },
  cache_write: {
    // Anthropic: a write kept for an hour bills at 2x input, against 1.25x for
    // the default five minutes. `usage.cache_creation` splits the write by TTL.
    // Moonshot's Kimi bills the same split and reports it the same way on its
    // Messages API.
    "1h": {
      description: "USD per 1M tokens written to a one-hour cache, where it costs more than the default cache write.",
      reportedAt: [["cache_creation", "ephemeral_1h_input_tokens"]],
      // Kimi's Chat Completions body reports only the total write, in
      // `prompt_tokens_details.cache_write_tokens`; the one-hour share is in
      // the `Msh-Usage-Cache-Write-Tokens-1h` header of a non-streamed
      // response. A streamed one reports only the total (see `headerVariants`
      // in `usage-readers.ts`), so it bills every write at the default rate.
      reportedInHeader: { provider: "moonshot", style: "chat_completions", header: "msh-usage-cache-write-tokens-1h" },
    },
    // OpenAI (Responses API): a write kept for 12 hours bills at 2.5x input,
    // against 1.25x for the default 30 minutes.
    "12h": {
      description: "USD per 1M tokens written to a 12-hour cache, where it costs more than the default cache write.",
      reportedAt: [["input_tokens_details", "cache_write_tokens_details", "ttl_12h_tokens"]],
    },
  },
} as const satisfies Partial<Record<SplitBucket, Record<string, VariantSpec>>>;

export type VariantBucket = keyof typeof TOKEN_VARIANTS;
export type VariantName<B extends VariantBucket = VariantBucket> = keyof (typeof TOKEN_VARIANTS)[B] & string;

/** The rate field a variant bills at. */
export type VariantRateField = { [B in VariantBucket]: `${B}_${VariantName<B>}` }[VariantBucket];

/**
 * How many of a bucket's tokens were each variant, as a response reported
 * them. Absent means the response did not split the bucket, and every token of
 * it bills at the bucket's own rate.
 */
export type TokenVariants = {
  [B in VariantBucket]?: Partial<Record<VariantName<B>, number>>;
};

/** One variant of {@link TOKEN_VARIANTS}, flattened, for code that walks them all. */
export interface Variant extends VariantSpec {
  readonly bucket: VariantBucket;
  readonly name: VariantName;
  readonly field: VariantRateField;
}

export const VARIANTS: readonly Variant[] = Object.entries(TOKEN_VARIANTS).flatMap(([bucket, variants]) =>
  Object.entries(variants as Record<string, VariantSpec>).map(([name, spec]) => ({
    ...spec,
    bucket: bucket as VariantBucket,
    name: name as VariantName,
    field: `${bucket}_${name}` as VariantRateField,
  })),
);

/** The canonical token buckets, in the order rates are reported. Each has a long-context rate. */
const BUCKETS = ["input", "cached_input", "cache_write", "output"] as const;
type Bucket = (typeof BUCKETS)[number];

/** Input or output tokens of one modality, priced apart from text. */
const MODALITY_RATES = ["image_input", "audio_input", "video_input", "image_output", "audio_output"] as const;
export type ModalityRate = (typeof MODALITY_RATES)[number];

type ShortRateField = Bucket | VariantRateField | ModalityRate;
type LongRateField = `long_${ShortRateField}`;

/** Rates in USD per 1M tokens. Time- and image-priced rates are not here. */
export type TokenRateField = ShortRateField | LongRateField;

const MODALITY_DESCRIPTIONS: Record<ModalityRate, string> = {
  image_input: "USD per 1M image input tokens, where they are priced apart from text input.",
  audio_input: "USD per 1M audio input tokens, where they are priced apart from text input.",
  video_input: "USD per 1M video input tokens, where they are priced apart from text input.",
  image_output: "USD per 1M generated image tokens, where they cost more than text output.",
  audio_output: "USD per 1M generated audio tokens, where they are priced apart from text output.",
};

/** Each bucket followed by its variants: input, cached_input, cache_write, cache_write_1h, … */
const BUCKET_FIELDS = BUCKETS.flatMap((bucket) => [
  bucket,
  ...VARIANTS.filter((variant) => variant.bucket === bucket).map((variant) => variant.field),
]) as readonly (Bucket | VariantRateField)[];

/** The `long_*` rates, which only apply above `long_context_threshold`: one for every other rate. */
export const LONG_RATE_FIELDS = [...BUCKET_FIELDS, ...MODALITY_RATES].map(
  (field) => `long_${field}`,
) as readonly LongRateField[];

/** Every token rate: each bucket and its variants, the modality rates, then their long-context rates. */
export const TOKEN_RATE_FIELDS: readonly TokenRateField[] = [...BUCKET_FIELDS, ...MODALITY_RATES, ...LONG_RATE_FIELDS];

const DESCRIPTIONS = new Map<string, string>([
  ...Object.entries(MODALITY_DESCRIPTIONS),
  ...VARIANTS.map((variant) => [variant.field, variant.description] as const),
]);

/** The API reference's description of a rate, where it says more than its name. */
export function rateDescription(field: TokenRateField): string | undefined {
  return DESCRIPTIONS.get(field);
}

/**
 * A model's price in one service mode: every rate multiplied by `factor` (1
 * where it is left out), then any rate named here in place of its multiplied
 * figure. See `priceInMode` in `src/shared/service-modes.ts`.
 */
export type ModePrice = Partial<Record<TokenRateField | "per_minute" | "per_hour" | "per_image", number>>
  & {
    factor?: number;
    /**
     * In the price list only: the day (`YYYY-MM-DD`) the provider's page
     * stopped listing the mode for this model. The mode keeps its last price,
     * as a model the page stops listing does, so nothing that used it breaks.
     */
    unlisted_since?: string;
  };

/**
 * A provider's own price for one model. Only input and output are required:
 * every other rate falls back exactly as a catalog entry's does. `modes` holds
 * its price in each service mode other than standard, keyed by the mode's name.
 */
export type TokenPrice = { input: number; output: number }
  & Partial<Record<Exclude<TokenRateField, "input" | "output">, number>>
  & { long_context_threshold?: number; modes?: Record<string, ModePrice> };

/**
 * What a token in each canonical bucket bills at, in or out of long context.
 *
 * The one statement of the fallbacks: an unpriced cache read or write bills at
 * input, and an unpriced long-context rate at its short-context one — except
 * that a cache read or write falls back to the long input rate, since the whole
 * prompt is billed as long. `computeCost` bills with it.
 */
export function bucketRates(price: TokenPrice, longContext: boolean): Record<Bucket, number> {
  if (!longContext) {
    return {
      input: price.input,
      cached_input: price.cached_input ?? price.input,
      cache_write: price.cache_write ?? price.input,
      output: price.output,
    };
  }
  const input = price.long_input ?? price.input;
  return {
    input,
    cached_input: price.long_cached_input ?? price.cached_input ?? input,
    cache_write: price.long_cache_write ?? price.cache_write ?? input,
    output: price.long_output ?? price.output,
  };
}

/**
 * What one modality's tokens bill at, where the price has a rate for it: its
 * long-context rate in long context, then its own. Undefined where neither is
 * set, and the modality bills at its side's rate like text.
 */
export function modalityRate(
  price: Partial<Record<TokenRateField, number>>,
  field: ModalityRate,
  longContext: boolean,
): number | undefined {
  return (longContext ? price[`long_${field}`] : undefined) ?? price[field];
}

/**
 * What one variant's tokens bill at: its long-context rate in long context,
 * then its own rate, then `bucketRate`, the rate {@link bucketRates} gives its
 * bucket. Unpriced, a variant therefore bills exactly as it did before it was
 * read, so a catalog that has not priced it yet charges what it always did.
 */
export function variantRate(
  price: Partial<Record<TokenRateField, number>>,
  variant: Pick<Variant, "field">,
  longContext: boolean,
  bucketRate: number,
): number {
  return (longContext ? price[`long_${variant.field}`] : undefined) ?? price[variant.field] ?? bucketRate;
}

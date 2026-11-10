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
 *   in `src/contracts/responses.ts` are built from {@link TOKEN_RATE_FIELDS};
 * - the daily model sync in `scripts/models/` compares prices with the same
 *   two functions and labels each rate with {@link RATE_LABELS}.
 *
 * So a rate added here is at once priceable, readable, overridable, documented
 * and synced. The sync loads this file under Node's type stripping, so it
 * imports nothing and uses only syntax that can be erased.
 */

/** The buckets a variant may split. Input and output split by modality instead. */
export type SplitBucket = "cached_input" | "cache_write";

/**
 * A named part of a token bucket that a provider bills at a rate of its own.
 *
 * `reportedAt` is the path, from a response's `usage` object, of the count of
 * the bucket's tokens that were this variant. It is read from every usage
 * object, whatever its provider: each path is a field name only its own
 * provider uses, as with cache hits in `usage-readers.ts`.
 */
interface VariantSpec {
  /** How the model sync's report names the rate. */
  readonly label: string;
  /** The rate's description in the API reference. */
  readonly description: string;
  readonly reportedAt: readonly string[];
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
 * Adding a variant is one entry here, the rates in the catalog, and the
 * provider's page parser reading them.
 */
export const TOKEN_VARIANTS = {
  cache_write: {
    // Anthropic: a write kept for an hour bills at 2x input, against 1.25x for
    // the default five minutes. `usage.cache_creation` splits the write by TTL.
    "1h": {
      label: "1h cache write",
      description: "USD per 1M tokens written to a one-hour cache, where it costs more than the default cache write.",
      reportedAt: ["cache_creation", "ephemeral_1h_input_tokens"],
    },
    // OpenAI (Responses API): a write kept for 12 hours bills at 2.5x input,
    // against 1.25x for the default 30 minutes.
    "12h": {
      label: "12h cache write",
      description: "USD per 1M tokens written to a 12-hour cache, where it costs more than the default cache write.",
      reportedAt: ["input_tokens_details", "cache_write_tokens_details", "ttl_12h_tokens"],
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

/** Input or output tokens of one modality, priced apart from text. They have no long-context rate. */
const MODALITY_RATES = ["image_input", "audio_input", "video_input", "image_output"] as const;
type ModalityRate = (typeof MODALITY_RATES)[number];

type ShortRateField = Bucket | VariantRateField | ModalityRate;
type LongRateField = `long_${Bucket | VariantRateField}`;

/** Rates in USD per 1M tokens. Time- and image-priced rates are not here. */
export type TokenRateField = ShortRateField | LongRateField;

const BASE_RATES: Record<Bucket | ModalityRate, { label: string; description?: string }> = {
  input: { label: "input" },
  cached_input: { label: "cached" },
  cache_write: { label: "cache write" },
  output: { label: "output" },
  image_input: {
    label: "image input",
    description: "USD per 1M image input tokens, where they are priced apart from text input.",
  },
  audio_input: {
    label: "audio input",
    description: "USD per 1M audio input tokens, where they are priced apart from text input.",
  },
  video_input: {
    label: "video input",
    description: "USD per 1M video input tokens, where they are priced apart from text input.",
  },
  image_output: {
    label: "image output",
    description: "USD per 1M generated image tokens, where they cost more than text output.",
  },
};

/** Each bucket followed by its variants: input, cached_input, cache_write, cache_write_1h, … */
const BUCKET_FIELDS = BUCKETS.flatMap((bucket) => [
  bucket,
  ...VARIANTS.filter((variant) => variant.bucket === bucket).map((variant) => variant.field),
]) as readonly (Bucket | VariantRateField)[];

/** The `long_*` rates, which only apply above `long_context_threshold`. */
export const LONG_RATE_FIELDS = BUCKET_FIELDS.map((field) => `long_${field}`) as readonly LongRateField[];

/** Every token rate, in the order the model sync reports them. */
export const TOKEN_RATE_FIELDS: readonly TokenRateField[] = [...BUCKET_FIELDS, ...MODALITY_RATES, ...LONG_RATE_FIELDS];

const SHORT_INFO = new Map<string, { label: string; description?: string }>([
  ...Object.entries(BASE_RATES),
  ...VARIANTS.map((variant) => [variant.field, variant] as const),
]);

/** What the model sync's report calls each rate: "cached", "long 1h cache write", … */
export const RATE_LABELS = Object.fromEntries(
  TOKEN_RATE_FIELDS.map((field) => {
    const short = field.startsWith("long_") ? field.slice("long_".length) : field;
    const label = SHORT_INFO.get(short)?.label ?? short;
    return [field, short === field ? label : `long ${label}`];
  }),
) as Record<TokenRateField, string>;

/** The API reference's description of a rate, where it says more than its name. */
export function rateDescription(field: TokenRateField): string | undefined {
  return SHORT_INFO.get(field)?.description;
}

/**
 * A provider's own price for one model. Only input and output are required:
 * every other rate falls back exactly as a catalog entry's does.
 */
export type TokenPrice = { input: number; output: number }
  & Partial<Record<Exclude<TokenRateField, "input" | "output">, number>>
  & { long_context_threshold?: number };

/**
 * What a token in each canonical bucket bills at, in or out of long context.
 *
 * The one statement of the fallbacks: an unpriced cache read or write bills at
 * input, and an unpriced long-context rate at its short-context one — except
 * that a cache read or write falls back to the long input rate, since the whole
 * prompt is billed as long. `computeCost` bills with it and the model sync
 * compares prices with it, so the two can never disagree on what a price means.
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

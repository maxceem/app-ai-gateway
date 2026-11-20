/**
 * Every per-token rate a price may carry, and which rate a token bills at
 * (ported from v1's `src/shared/token-rates.ts`).
 *
 * - The four buckets: uncached input, cached input, cache writes and output.
 * - Variants: a named part of a bucket that a provider bills at a rate of its
 *   own, such as Anthropic's one-hour cache write. A variant is never extra
 *   tokens, only a share of its bucket. Its rate is `<bucket>_<variant>`.
 * - Modality rates: image, audio and video tokens priced apart from text.
 * - `long_*` rates: one for each of the above, used above the model's
 *   long-context threshold.
 *
 * Unpriced, a cache read or write bills at the input rate, a variant at its
 * bucket's rate, a modality at its side's rate and a long rate at its short
 * one. Never free.
 */
import type { ApiStyle } from "../providers/operation.ts";
import type { Modality } from "./observation.ts";

export type SplitBucket = "cached_input" | "cache_write";

/** A response header that carries one variant's count, for one provider and API style. */
interface HeaderReport {
  readonly provider: string;
  readonly style: ApiStyle;
  /** Lowercase. */
  readonly header: string;
}

export interface Variant {
  readonly bucket: SplitBucket;
  readonly name: "audio" | "1h" | "12h";
  /** The rate field: `<bucket>_<name>`. */
  readonly field: "cached_input_audio" | "cache_write_1h" | "cache_write_12h";
  /** Paths from a response's `usage` object where the count may be. The first present wins. */
  readonly reportedAt: readonly (readonly string[])[];
  /** A variant that is one modality's share of the cache. */
  readonly modality?: Modality;
  /** Where one provider reports the count in a header instead, because its body has only the total. */
  readonly reportedInHeader?: HeaderReport;
}

/** Every variant, in billing order within its bucket. */
export const VARIANTS: readonly Variant[] = [
  {
    // BytePlus ModelArk: audio read from the cache bills at its own rate.
    bucket: "cached_input",
    name: "audio",
    field: "cached_input_audio",
    reportedAt: [
      ["prompt_tokens_details", "audio_cached_tokens"],
      ["input_tokens_details", "audio_cached_tokens"],
    ],
    modality: "audio",
  },
  {
    // Anthropic, and Moonshot's Messages API: a write kept for an hour bills
    // at 2x input, against 1.25x for the default five minutes. Kimi's Chat
    // Completions body reports only the total write; the one-hour share is in
    // a header of a response that does not stream.
    bucket: "cache_write",
    name: "1h",
    field: "cache_write_1h",
    reportedAt: [["cache_creation", "ephemeral_1h_input_tokens"]],
    reportedInHeader: { provider: "moonshot", style: "openai-chat", header: "msh-usage-cache-write-tokens-1h" },
  },
  {
    // OpenAI Responses: a write kept for 12 hours bills at 2.5x input.
    bucket: "cache_write",
    name: "12h",
    field: "cache_write_12h",
    reportedAt: [["input_tokens_details", "cache_write_tokens_details", "ttl_12h_tokens"]],
  },
];

const BUCKETS = ["input", "cached_input", "cache_write", "output"] as const;
export type Bucket = (typeof BUCKETS)[number];

const MODALITY_RATES = ["image_input", "audio_input", "video_input", "image_output"] as const;
export type ModalityRate = (typeof MODALITY_RATES)[number];

const SHORT_FIELDS = [
  ...BUCKETS.flatMap((bucket) => [bucket, ...VARIANTS.filter((variant) => variant.bucket === bucket).map((variant) => variant.field)]),
  ...MODALITY_RATES,
];

/** Every token rate: each bucket and its variants, the modality rates, then their long-context rates. */
const TOKEN_RATE_FIELDS: readonly string[] = [...SHORT_FIELDS, ...SHORT_FIELDS.map((field) => `long_${field}`)];

/** Every rate a price may carry: the token rates, and the rates priced per minute, hour or image. */
export const RATE_FIELDS: readonly string[] = [...TOKEN_RATE_FIELDS, "per_minute", "per_hour", "per_image"];

/** Rates by field. The unit is whatever the caller works in. */
export type Rates = Readonly<Partial<Record<string, number>>>;

/** What a token in each bucket bills at, in or out of long context. Needs `input` and `output`. */
export function bucketRates(rates: Rates & { input: number; output: number }, longContext: boolean): Record<Bucket, number> {
  if (!longContext) {
    return {
      input: rates.input,
      cached_input: rates.cached_input ?? rates.input,
      cache_write: rates.cache_write ?? rates.input,
      output: rates.output,
    };
  }
  const input = rates.long_input ?? rates.input;
  return {
    input,
    cached_input: rates.long_cached_input ?? rates.cached_input ?? input,
    cache_write: rates.long_cache_write ?? rates.cache_write ?? input,
    output: rates.long_output ?? rates.output,
  };
}

/** A modality's own rate, in or out of long context, or undefined where it bills like text. */
export function modalityRate(rates: Rates, field: ModalityRate, longContext: boolean): number | undefined {
  return (longContext ? rates[`long_${field}`] : undefined) ?? rates[field];
}

/** A variant's rate: its long rate in long context, then its own, then its bucket's. */
export function variantRate(rates: Rates, variant: Pick<Variant, "field">, longContext: boolean, bucketRate: number): number {
  return (longContext ? rates[`long_${variant.field}`] : undefined) ?? rates[variant.field] ?? bucketRate;
}

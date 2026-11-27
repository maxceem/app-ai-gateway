/**
 * What a usage reader takes from a response (ported from v1's
 * `UsageObservation`). Plain types only: the console's type graph reaches
 * this file through the provider descriptions.
 */

import type { Unit } from "../providers/operation.ts";

/** The kinds of token a provider may price apart from text. */
export type Modality = "image" | "audio" | "video";

/**
 * One side of a usage broken down by modality. `unknown` counts tokens the
 * breakdown did not account for, which bill at the highest rate the model has.
 */
export type ModalityCounts = Partial<Record<Modality | "unknown", number>>;

export interface ModalityTokens {
  readonly input?: ModalityCounts;
  readonly output?: ModalityCounts;
}

/**
 * How many of a bucket's tokens were each variant (`./token-rates.ts`), as a
 * response reported them. Absent means the response did not split the bucket.
 */
export type TokenVariants = {
  readonly cached_input?: Partial<Record<"audio" | "image", number>>;
  readonly cache_write?: Partial<Record<"1h" | "12h", number>>;
};

/** Token counts. `inputTokens` excludes cached and cache-write tokens. */
export interface TokenCounts {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
}

export interface UsageObservation extends TokenCounts {
  readonly modalityTokens?: ModalityTokens;
  readonly tokenVariants?: TokenVariants;
  /**
   * The values the response names its served mode with, by field name
   * (`REPORTED_MODE_FIELDS` in `./readers.ts`). The provider's table says
   * what they mean.
   */
  readonly reportedModes?: Readonly<Record<string, string>>;
  /** Seconds of audio a transcription reports, for a model priced by time. */
  readonly audioSeconds?: number;
  /** Images an image API reports it made, for a model priced per image. */
  readonly images?: number;
  /**
   * The answer reported no token counts, only a duration or an image count.
   * Its zero token counts are not a measure: a token-priced model cannot be
   * billed from them, never as $0.
   */
  readonly noTokens?: true;
  /**
   * Counts in units other than tokens, each a whole number at its unit's
   * scale (`src/pricing/units.ts`): characters, milliseconds of video,
   * credits at 1000 per credit, and so on. A transcription's duration and an
   * image API's image count stay in `audioSeconds` and `images`.
   */
  readonly units?: Readonly<Partial<Record<Unit, number>>>;
  /**
   * The units in `units` that were worked out from the request, not reported
   * by the provider (a request measure, or a response header's estimate). A
   * charge billed in one of them is `measured: estimated`. A unit the
   * provider reported is billed before them.
   */
  readonly estimatedUnits?: readonly Unit[];
  /**
   * The units the provider reported beside its own billing unit, as a usage
   * measure (an answer's audio length beside the credits it charged), which
   * the meter declares (`body` on a response header meter). One bills only
   * when no billing unit the provider reported can, and before the request's
   * estimate (`measureRank` in `src/pricing/tokens.ts`).
   */
  readonly secondaryUnits?: readonly Unit[];
  /**
   * The provider was meant to report the billed amount (a response header)
   * and did not, so the request's estimate bills instead: priced as an estimate.
   */
  readonly reportMissing?: true;
  /**
   * The values of the operation's price keys this request was priced with,
   * such as an image size (`src/pricing/prices.ts`, `by`).
   */
  readonly priceKeys?: Readonly<Record<string, string>>;
  /**
   * Price keys with several values for one request, such as the languages
   * Deepgram detected on each channel: billed at the dearest of them, and an
   * estimate unless they all price the same (`keyCandidates`).
   */
  readonly priceKeyChoices?: Readonly<Record<string, readonly string[]>>;
  /**
   * The answer did not end whole: its last document was cut, the stream did
   * not close, or a value was too large to keep. What was read may be short,
   * an earlier event's count, say. Billed as an estimate, never as exact.
   */
  readonly finalEventUnread?: true;
  /**
   * The answer did not report its measure, and the reader worked it out from
   * what it did report (Deepgram's last utterance end, with no duration).
   * Billed as an estimate, and logged.
   */
  readonly measureWorkedOut?: true;
  /**
   * Price key values the answer reports, for a key the provider may choose
   * itself (`answeredWhen`): the language Deepgram detected, one per channel.
   * A null is a channel that named none.
   */
  readonly reportedPriceKeys?: Readonly<Record<string, readonly (string | null)[]>>;
  /**
   * The audio's channels, for a meter that bills audio once per channel only
   * when the request asks for it (Deepgram's `multichannel`): `audioSeconds`
   * is one channel's length until then.
   */
  readonly audioChannels?: number;
  /**
   * The models the answer says served it, for a model the provider may change
   * (`answeredWhen`): one entry per model it names (a channel's, say), each
   * with the names it goes by (Deepgram's `arch` and `name`). Every entry
   * must be the billed model; any other is a fallback.
   */
  readonly reportedModels?: readonly (readonly string[])[];
}

/** Whether a usage measures anything a price could bill: tokens, or a count above 0 in another unit. */
export function hasMeasure(usage: UsageObservation): boolean {
  if ((usage.audioSeconds ?? 0) > 0 || (usage.images ?? 0) > 0) return true;
  if (Object.values(usage.units ?? {}).some((count) => count !== undefined && count > 0)) return true;
  if (usage.noTokens === true) return false;
  return usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens + usage.outputTokens > 0;
}

/**
 * The usage as if the provider had reported nothing: only the units worked
 * out from the request, marked `reportMissing`, or null when there are none.
 * A report whose charge cannot be stored (a figure far too large) is treated
 * this way, so the request's estimate prices the call instead.
 */
export function withoutReport(usage: UsageObservation): UsageObservation | null {
  const estimated = usage.estimatedUnits ?? [];
  const units = Object.fromEntries(Object.entries(usage.units ?? {}).filter(([unit]) => estimated.includes(unit as Unit)));
  if (Object.keys(units).length === 0) return null;
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    noTokens: true,
    units,
    estimatedUnits: estimated,
    reportMissing: true,
    ...(usage.priceKeys !== undefined ? { priceKeys: usage.priceKeys } : {}),
  };
}

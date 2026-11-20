/**
 * What a usage reader takes from a response (ported from v1's
 * `UsageObservation`). Plain types only: the console's type graph reaches
 * this file through the provider descriptions.
 */

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
  readonly cached_input?: Partial<Record<"audio", number>>;
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
  /**
   * Set when a reported mode was found by scanning the text of a body too big
   * to keep whole: the client may have written it, echoed back.
   */
  readonly modesScanned?: true;
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
   * A stream's final event was cut by the kept window and its usage could not
   * be read: what was read came from an earlier event, so it may be short.
   * Billed as an estimate, never as exact.
   */
  readonly finalEventUnread?: true;
}

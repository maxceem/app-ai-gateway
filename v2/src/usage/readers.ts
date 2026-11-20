/**
 * Reading what a provider reported off its own response (ported from v1's
 * `src/usage/usage-readers.ts`, plan section 4.1 "one usage reader per API
 * style").
 *
 * The gateway knows which API it called before the first byte comes back, so
 * the operation's API style picks the reader. A body that does not say what
 * that API says is unreadable, never an invitation to guess: it is recorded
 * as unresolved, never as free.
 *
 * Two rules v2 adds to v1's readers:
 *
 * - A count that is not an exact whole number is not usage the gateway can
 *   price. The reader returns nothing, so the charge is recorded unresolved
 *   and logged, never stored rounded.
 * - A document whose JSON never closed (a cut stream) still gives up a whole
 *   `usage` object it holds, after every whole one was tried.
 *
 * A body is read as it streams past (`./frames.ts`, `./skim.ts`), every byte
 * once, keeping only the values at `READ_PATHS`: a body of any size is read
 * whole, never from kept fragments.
 */
import type { ApiStyle, ProviderCostReport } from "../providers/operation.ts";
import { costReader } from "./cost-reports.ts";
import { framer, isEventStream, type BodyDocument, type SseFrame } from "./frames.ts";
import type { Modality, ModalityCounts, TokenVariants, UsageObservation } from "./observation.ts";
import type { PathTree } from "./skim.ts";
import { VARIANTS } from "./token-rates.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A non-negative whole count at `key`, or 0 when it is absent or not a count. */
function numberAt(record: Record<string, unknown>, key: string): number {
  const value = finiteNumber(record[key]);
  return value === null ? 0 : Math.max(0, Math.trunc(value));
}

/** Whether any of `keys` holds a number that is not a whole count: such usage is not priced. */
function inexact(record: Record<string, unknown> | null, keys: readonly string[]): boolean {
  if (record === null) return false;
  return keys.some((key) => {
    const value = record[key];
    return typeof value === "number" && !Number.isSafeInteger(value);
  });
}

/**
 * Whether a `usage` object carries at least one counter this reader can
 * price. One made only of fields we do not know (Cohere's `billed_units`)
 * would otherwise read as a free request.
 */
function countsAny(usage: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => finiteNumber(usage[key]) !== null);
}

const NOTHING_COUNTED: readonly Modality[] = [];

/**
 * One side of an OpenAI usage object broken down by modality: `text_tokens`
 * and `image_tokens`, with `audio_tokens` where a model hears. Only what the
 * split accounts for is believed; the rest of `total` is `unknown`.
 *
 * `counted` is what the provider declares it always counts. Then the side is
 * always broken down, a missing count is none, and the rest is text.
 */
function openAiModalities(
  details: Record<string, unknown> | null,
  total: number,
  counted: readonly Modality[] = NOTHING_COUNTED,
): ModalityCounts | undefined {
  if (counted.length > 0) {
    const counts: Partial<Record<Modality, number>> = {};
    for (const modality of counted) {
      const tokens = details ? numberAt(details, `${modality}_tokens`) : 0;
      if (tokens > 0) counts[modality] = tokens;
    }
    return counts;
  }
  if (!details || !countsAny(details, ["text_tokens", "image_tokens"])) return undefined;
  const counts: Partial<Record<Modality | "unknown", number>> = {};
  const image = numberAt(details, "image_tokens");
  const audio = numberAt(details, "audio_tokens");
  if (image > 0) counts.image = image;
  if (audio > 0) counts.audio = audio;
  const accounted = numberAt(details, "text_tokens") + image + audio;
  if (accounted < total) counts.unknown = total - accounted;
  return counts;
}

/**
 * The fields a response names its served mode with, by the name a provider's
 * `servedModes` table reads:
 *
 * - `service_tier`: OpenAI, xAI, Groq, Perplexity and OpenRouter at the top of
 *   a chat answer or under `response`; Mistral and Anthropic inside `usage`.
 * - `speed` and `inference_geo`: Anthropic, inside `usage`.
 * - `serviceTier`: Gemini, inside `usageMetadata`.
 * - `response_service_tier`: BytePlus.
 */
export const REPORTED_MODE_FIELDS = ["service_tier", "speed", "inference_geo", "serviceTier", "response_service_tier"] as const;
type ReportedModeField = (typeof REPORTED_MODE_FIELDS)[number];

function reportedModes(
  records: readonly (Record<string, unknown> | null)[],
  names: readonly ReportedModeField[],
): Pick<UsageObservation, "reportedModes"> {
  let found: Record<string, string> | undefined;
  for (const name of names) {
    for (const record of records) {
      const value = record?.[name];
      if (value === undefined || value === null) continue;
      // A value that is not a usable string is kept too, as one no table
      // knows: the gateway then bills at least at standard, as an estimate.
      (found ??= {})[name] = typeof value === "string" && value.length > 0 ? value : "(other)";
      break;
    }
  }
  return found ? { reportedModes: found } : {};
}

/** The count at `path` under `usage`, read as `numberAt` reads one. */
function countAt(usage: Record<string, unknown>, path: readonly string[]): number {
  let value: unknown = usage;
  for (const key of path) {
    const record = asRecord(value);
    if (!record) return 0;
    value = record[key];
  }
  const count = finiteNumber(value);
  return count === null ? 0 : Math.max(0, Math.trunc(count));
}

type VariantCounts = Partial<Record<string, Partial<Record<string, number>>>>;

/** The bucket shares a `usage` object reports, each read from where its variant says. */
function readTokenVariants(usage: Record<string, unknown>): TokenVariants | undefined {
  let found: VariantCounts | undefined;
  for (const variant of VARIANTS) {
    let count = 0;
    for (const path of variant.reportedAt) {
      count = countAt(usage, path);
      if (count > 0) break;
    }
    if (count === 0) continue;
    found ??= {};
    (found[variant.bucket] ??= {})[variant.name] = count;
  }
  return found as TokenVariants | undefined;
}

/** Two events' shares as one: field-wise `max`, so an event that names none never erases one that did. */
function mergeTokenVariants(left?: TokenVariants, right?: TokenVariants): TokenVariants | undefined {
  if (!left || !right) return left ?? right;
  const [a, b] = [left as VariantCounts, right as VariantCounts];
  const merged: VariantCounts = {};
  for (const { bucket, name } of VARIANTS) {
    const counts = [a[bucket]?.[name], b[bucket]?.[name]].filter((count): count is number => count !== undefined);
    if (counts.length > 0) (merged[bucket] ??= {})[name] = Math.max(...counts);
  }
  return merged as TokenVariants;
}

const OPENAI_COUNTS = ["input_tokens", "prompt_tokens", "output_tokens", "completion_tokens"] as const;

/** OpenAI usage: Chat Completions, legacy completions and Responses, at the root or under `response`. */
export function openAiUsage(value: unknown, countedInput: readonly Modality[] = NOTHING_COUNTED): UsageObservation | null {
  const root = asRecord(value);
  if (!root) return null;
  const response = asRecord(root.response) ?? root;
  const usage = asRecord(response.usage);
  if (!usage || !countsAny(usage, OPENAI_COUNTS)) return null;
  const details = asRecord(usage.input_tokens_details) ?? asRecord(usage.prompt_tokens_details);
  if (
    inexact(usage, [...OPENAI_COUNTS, "cached_tokens", "prompt_cache_hit_tokens"]) ||
    inexact(details, ["cached_tokens", "cache_write_tokens"])
  ) {
    return null;
  }
  const inputTotal = numberAt(usage, "input_tokens") || numberAt(usage, "prompt_tokens");
  // Cache hits are the same fact under several spellings: OpenAI, Mistral,
  // Fireworks and Cerebras nest it in the details; Moonshot and Together put
  // `cached_tokens` at the root; DeepSeek names it `prompt_cache_hit_tokens`.
  // A missed one would bill the cache at the full input rate.
  const cached =
    (details ? numberAt(details, "cached_tokens") : 0) || numberAt(usage, "cached_tokens") || numberAt(usage, "prompt_cache_hit_tokens");
  const cacheWrite = details ? numberAt(details, "cache_write_tokens") : 0;
  const outputTotal = numberAt(usage, "output_tokens") || numberAt(usage, "completion_tokens");
  const input = openAiModalities(details, inputTotal, countedInput);
  const output = openAiModalities(asRecord(usage.output_tokens_details) ?? asRecord(usage.completion_tokens_details), outputTotal);
  const tokenVariants = readTokenVariants(usage);
  const modes = reportedModes([response, root, usage], ["service_tier", "response_service_tier"]);
  return {
    inputTokens: Math.max(0, inputTotal - cached - cacheWrite),
    cachedInputTokens: Math.min(cached, inputTotal),
    cacheWriteTokens: Math.min(cacheWrite, Math.max(0, inputTotal - cached)),
    outputTokens: outputTotal,
    ...(input || output ? { modalityTokens: { ...(input ? { input } : {}), ...(output ? { output } : {}) } } : {}),
    ...(tokenVariants ? { tokenVariants } : {}),
    ...modes,
  };
}

/** A count that is a finite number, 0 or more, else null. */
function nonNegativeNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

const EMPTY_USAGE: UsageObservation = { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };

/**
 * A transcription reports whatever its model is billed by, and the reader
 * does not choose between them (v1's `audioUsage`): OpenAI's token-priced
 * models answer with a `usage` of tokens, its time-priced ones with
 * `usage: {type: "duration", seconds}`, and xAI and `verbose_json` with a
 * top-level `duration`. Every measure present is kept, and the model's price
 * decides which one bills, so a response shape can never move a model onto
 * another model's unit.
 *
 * `usage.seconds` wins over `duration` where both appear: it is the figure
 * the usage bills, and `duration` is the length of the audio as transcribed.
 * Mistral names the billed audio `prompt_audio_seconds`, beside its tokens.
 */
export function audioUsage(value: unknown, countedInput: readonly Modality[] = NOTHING_COUNTED): UsageObservation | null {
  const root = asRecord(value);
  if (!root) return null;
  const usage = asRecord(root.usage);
  // The first positive one: a `seconds: 0` beside a real duration must not bill the audio as nothing.
  const candidates = [usage?.seconds, usage?.prompt_audio_seconds, root.duration].map(nonNegativeNumber);
  const seconds = candidates.find((value) => value !== null && value > 0) ?? candidates.find((value) => value !== null) ?? null;
  const tokens = openAiUsage(root, countedInput);
  if (tokens) return seconds === null ? tokens : { ...tokens, audioSeconds: seconds };
  return seconds === null ? null : { ...EMPTY_USAGE, audioSeconds: seconds, noTokens: true };
}

/** ElevenLabs' speech to text: the audio's length, `audio_duration_secs`. It reports no tokens. */
export function elevenLabsTranscriptionUsage(value: unknown): UsageObservation | null {
  const seconds = nonNegativeNumber(asRecord(value)?.audio_duration_secs);
  return seconds === null ? null : { ...EMPTY_USAGE, audioSeconds: seconds, noTokens: true };
}

/** A short name an answer reports (a language, a model): kept only when it looks like one, so no answer text is stored. */
const REPORTED_NAME = /^[A-Za-z0-9_.-]{1,64}$/u;

/**
 * Deepgram's prerecorded speech to text: the audio's length
 * (`metadata.duration`) times its channels (`metadata.channels`, 1 when not
 * named). Deepgram bills multichannel audio by the total processed across
 * channels: a ten-minute stereo file bills as twenty minutes.
 *
 * - With no duration, the latest utterance end (`results.utterances[].end`,
 *   with `utterances=true`) stands for it, times the channels: worked out,
 *   so billed as an estimate (`measureWorkedOut`).
 * - The language it detected (`results.channels[].detected_language`, with
 *   `detect_language`), when every channel names the same one.
 * - The models that served it (`metadata.model_info`: each one's `arch` and
 *   `name`), so a fallback to another model is seen.
 */
export function deepgramListenUsage(value: unknown): UsageObservation | null {
  const root = asRecord(value);
  const metadata = asRecord(root?.metadata);
  const results = asRecord(root?.results);
  const reported = metadata?.channels;
  const channels = typeof reported === "number" && Number.isSafeInteger(reported) && reported >= 1 ? reported : 1;
  let duration = nonNegativeNumber(metadata?.duration);
  let workedOut = false;
  if (duration === null) {
    // The skimmer keeps only the largest `end` (`"max"` in `READ_PATHS`); a whole answer has the list.
    const utterances = results?.utterances;
    duration = Array.isArray(utterances)
      ? utterances.reduce<number | null>((latest, utterance) => {
          const end = nonNegativeNumber(asRecord(utterance)?.end);
          return end !== null && (latest === null || end > latest) ? end : latest;
        }, null)
      : nonNegativeNumber(asRecord(utterances)?.end);
    if (duration === null) return null;
    workedOut = true;
  }
  const languages = new Set(
    (Array.isArray(results?.channels) ? results.channels : []).map((channel) => {
      const language = asRecord(channel)?.detected_language;
      return typeof language === "string" && REPORTED_NAME.test(language) ? language : null;
    }),
  );
  const language = languages.size === 1 ? [...languages][0]! : null;
  const models = Object.values(asRecord(metadata?.model_info) ?? {}).flatMap((info) => {
    const record = asRecord(info);
    return [record?.arch, record?.name].filter((name): name is string => typeof name === "string" && REPORTED_NAME.test(name));
  });
  return {
    ...EMPTY_USAGE,
    audioSeconds: duration * channels,
    noTokens: true,
    ...(workedOut ? { measureWorkedOut: true as const } : {}),
    ...(language !== null ? { reportedPriceKeys: { language } } : {}),
    ...(models.length > 0 ? { reportedModels: models } : {}),
  };
}

/**
 * An image API's usage: the OpenAI shape, with image tokens apart, plus the
 * images BytePlus Seedream bills per image and counts as `generated_images`
 * (v1).
 */
export function imagesUsage(value: unknown, countedInput: readonly Modality[] = NOTHING_COUNTED): UsageObservation | null {
  const root = asRecord(value);
  if (!root) return null;
  const usage = asRecord(root.usage);
  // A count only: a whole number, 0 or more. Anything else is no count at all.
  const reported = usage?.generated_images;
  const images = typeof reported === "number" && Number.isSafeInteger(reported) && reported >= 0 ? reported : null;
  const tokens = openAiUsage(root, countedInput);
  if (images === null) return tokens;
  return tokens === null ? { ...EMPTY_USAGE, images, noTokens: true } : { ...tokens, images };
}

const ANTHROPIC_COUNTS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;

/** Anthropic usage: a whole message, or one stream event. */
export function anthropicUsage(value: unknown): UsageObservation | null {
  const root = asRecord(value);
  if (!root) return null;
  const message = asRecord(root.message) ?? root;
  const usage = asRecord(message.usage) ?? asRecord(root.usage);
  if (!usage || !countsAny(usage, ANTHROPIC_COUNTS) || inexact(usage, ANTHROPIC_COUNTS)) return null;
  const tokenVariants = readTokenVariants(usage);
  const modes = reportedModes([usage], ["speed", "inference_geo", "service_tier"]);
  return {
    inputTokens: numberAt(usage, "input_tokens"),
    cachedInputTokens: numberAt(usage, "cache_read_input_tokens"),
    cacheWriteTokens: numberAt(usage, "cache_creation_input_tokens"),
    outputTokens: numberAt(usage, "output_tokens"),
    ...(tokenVariants ? { tokenVariants } : {}),
    ...modes,
  };
}

/** Gemini's modality names, as the ones a price tells apart. A PDF is read as page images. */
const GEMINI_MODALITIES = new Map<unknown, Modality>([
  ["IMAGE", "image"],
  ["DOCUMENT", "image"],
  ["AUDIO", "audio"],
  ["VIDEO", "video"],
]);

type GeminiKind = Modality | "unknown" | "text";

/** A Gemini details list as counts per kind, or undefined when it is not a list. */
function geminiCounts(details: unknown): Map<GeminiKind, number> | undefined {
  if (!Array.isArray(details)) return undefined;
  const counts = new Map<GeminiKind, number>();
  for (const detail of details) {
    const entry = asRecord(detail);
    if (!entry) continue;
    const kind: GeminiKind = entry.modality === "TEXT" ? "text" : (GEMINI_MODALITIES.get(entry.modality) ?? "unknown");
    counts.set(kind, (counts.get(kind) ?? 0) + numberAt(entry, "tokenCount"));
  }
  return counts;
}

/** One side of a Gemini usage by modality. Only what the entries account for is believed. */
function geminiModalities(details: unknown, total: number): ModalityCounts | undefined {
  const counts = geminiCounts(details);
  if (counts === undefined) return undefined;
  const split: Partial<Record<Modality | "unknown", number>> = {};
  let accounted = 0;
  for (const [kind, tokens] of counts) {
    accounted += tokens;
    if (kind !== "text") split[kind] = (split[kind] ?? 0) + tokens;
  }
  if (accounted < total) split.unknown = (split.unknown ?? 0) + total - accounted;
  return split;
}

/**
 * A prompt's split when part of it came from the cache. `cacheTokensDetails`
 * says what the cache held, by modality; the prompt's own details cover the
 * whole prompt. v1 read only the prompt's, so cached image or video tokens
 * were billed again as uncached ones: a deliberate change from v1.
 *
 * - Image, video and unknown tokens: the cached ones are taken out of the
 *   split, so only uncached ones bill at their rates. The cached ones bill
 *   at the cached rate.
 * - Audio has a cached rate of its own (`cached_input_audio`): its count stays
 *   whole, and its cached share is the variant, as the pricing reads it.
 */
function geminiCachedSplit(
  prompt: unknown,
  cache: unknown,
  uncachedTotal: number,
): { input: ModalityCounts; tokenVariants?: TokenVariants } | undefined {
  const whole = geminiCounts(prompt);
  const cached = geminiCounts(cache);
  if (whole === undefined || cached === undefined) return undefined;
  const split: Partial<Record<Modality | "unknown", number>> = {};
  let accounted = 0;
  for (const [kind, tokens] of whole) {
    const uncached = Math.max(0, tokens - (cached.get(kind) ?? 0));
    accounted += uncached;
    if (kind === "text") continue;
    split[kind] = (split[kind] ?? 0) + (kind === "audio" ? tokens : uncached);
  }
  if (accounted < uncachedTotal) split.unknown = (split.unknown ?? 0) + uncachedTotal - accounted;
  const audio = Math.min(cached.get("audio") ?? 0, whole.get("audio") ?? 0);
  return { input: split, ...(audio > 0 ? { tokenVariants: { cached_input: { audio } } } : {}) };
}

const GEMINI_COUNTS = ["promptTokenCount", "cachedContentTokenCount", "candidatesTokenCount", "thoughtsTokenCount"] as const;

/** Gemini usage, from `usageMetadata`. */
export function geminiUsage(value: unknown): UsageObservation | null {
  const root = asRecord(value);
  if (!root) return null;
  const usage = asRecord(root.usageMetadata);
  if (!usage || !countsAny(usage, GEMINI_COUNTS) || inexact(usage, GEMINI_COUNTS)) return null;
  const promptTotal = numberAt(usage, "promptTokenCount");
  const cached = numberAt(usage, "cachedContentTokenCount");
  const candidates = numberAt(usage, "candidatesTokenCount");
  const thoughts = numberAt(usage, "thoughtsTokenCount");
  const promptDetails = usage.promptTokensDetails ?? usage.promptTokenDetails;
  const cachedSplit = cached > 0 ? geminiCachedSplit(promptDetails, usage.cacheTokensDetails, Math.max(0, promptTotal - cached)) : undefined;
  const input = cachedSplit?.input ?? geminiModalities(promptDetails, promptTotal);
  // Thinking is text even where the candidates are not broken down, so it
  // never bills at an image rate for want of a breakdown.
  const output = geminiModalities(usage.candidatesTokensDetails, candidates) ?? (thoughts > 0 ? { unknown: candidates } : undefined);
  const modes = reportedModes([usage], ["serviceTier"]);
  return {
    ...modes,
    inputTokens: Math.max(0, promptTotal - cached),
    cachedInputTokens: Math.min(cached, promptTotal),
    cacheWriteTokens: 0,
    // Thinking is not part of the candidates, and Gemini bills it as output.
    outputTokens: candidates + thoughts,
    ...(input || output ? { modalityTokens: { ...(input ? { input } : {}), ...(output ? { output } : {}) } } : {}),
    ...(cachedSplit?.tokenVariants ? { tokenVariants: cachedSplit.tokenVariants } : {}),
  };
}

// ---------------------------------------------------------------------------
// Reading a response as it streams past

/**
 * The values any reader takes from a document (`./frames.ts` keeps only
 * these, as they arrive): the usage objects, and what names the served
 * model, its tier, a transcription's duration and an SSE event's type. A
 * Responses event keeps its answer's under `response`, a Messages stream's
 * first event under `message`.
 */
export const READ_PATHS: PathTree = {
  usage: true,
  usageMetadata: true,
  model: true,
  service_tier: true,
  response_service_tier: true,
  duration: true,
  audio_duration_secs: true,
  metadata: { duration: true, channels: true, model_info: true },
  // Deepgram: the language each channel detected, and the utterances' ends.
  // Of the utterances, only the latest end: it holds the same however long the audio is.
  results: { channels: { detected_language: true }, utterances: { end: "max" } },
  type: true,
  response: { usage: true, model: true, service_tier: true, response_service_tier: true },
  message: { usage: true, model: true },
};

/**
 * A reducer: folds a response's documents, in order, into one reading,
 * keeping only what it needs. A stream of any length costs it the same.
 */
export interface Reducer<T> {
  step(document: BodyDocument): void;
  finish(): T;
}

/**
 * The reading the last document gives that `read` can read, as a whole
 * answer would give it: the latest whole document's, else the earliest cut
 * one's, since a cut document holds only what was whole when it stopped.
 */
function lastRead<T>(read: (value: Record<string, unknown>) => T | null): Reducer<T | null> {
  let whole: T | null = null;
  let cut: T | null = null;
  return {
    step(document) {
      if (document.whole) {
        const found = read(document.value);
        if (found !== null) whole = found;
      } else if (cut === null) cut = read(document.value);
    },
    finish: () => whole ?? cut,
  };
}

/** Two Anthropic events as one: field-wise `max`, as each reports its own half. */
function mergeAnthropicUsage(left: UsageObservation, right: UsageObservation): UsageObservation {
  const tokenVariants = mergeTokenVariants(left.tokenVariants, right.tokenVariants);
  // The left event's word wins where both name the mode.
  const modes = left.reportedModes || right.reportedModes ? { ...right.reportedModes, ...left.reportedModes } : undefined;
  return {
    inputTokens: Math.max(left.inputTokens, right.inputTokens),
    cachedInputTokens: Math.max(left.cachedInputTokens, right.cachedInputTokens),
    cacheWriteTokens: Math.max(left.cacheWriteTokens, right.cacheWriteTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
    ...(tokenVariants ? { tokenVariants } : {}),
    ...(modes ? { reportedModes: modes } : {}),
  };
}

/** Whether a value carries usage under `message`: Anthropic's `message_start`, the stream's first event. */
function carriesMessageUsage(value: Record<string, unknown>): boolean {
  return asRecord(value.message)?.usage !== undefined;
}

/**
 * Anthropic splits a stream in two: `message_start` has the input tokens and
 * every `message_delta` the cumulative output tokens. The last one, merged
 * with every event up to `message_start`, is the whole. A whole message, or
 * a last event that is `message_start` itself, is read alone.
 */
function anthropicReducer(): Reducer<UsageObservation | null> {
  const last = lastRead((value) => {
    const usage = anthropicUsage(value);
    return usage === null ? null : { usage, carries: carriesMessageUsage(value) };
  });
  // The events up to and including `message_start`, merged in order: an earlier event's mode wins.
  let start: UsageObservation | null = null;
  let started = false;
  return {
    step(document) {
      last.step(document);
      if (started || !document.whole) return;
      const usage = anthropicUsage(document.value);
      if (usage !== null) start = start === null ? usage : mergeAnthropicUsage(start, usage);
      if (carriesMessageUsage(document.value)) started = true;
    },
    finish() {
      const found = last.finish();
      if (found === null) return null;
      if (found.carries || start === null) return found.usage;
      return mergeAnthropicUsage(found.usage, start);
    },
  };
}

const CHUNK_TIER_FIELDS = ["service_tier", "response_service_tier"] as const;

/**
 * A Chat Completions stream names its served tier on its chunks, not always
 * on the last one with the usage: a content chunk may say `default` and the
 * usage chunk nothing. So the tier is read across every chunk, apart from the
 * counts. Two different values say nothing the gateway can price, so they
 * read as one no table knows, which bills at least at standard, as an
 * estimate.
 */
function chatReducer(counted: readonly Modality[]): Reducer<UsageObservation | null> {
  const usage = lastRead((value) => openAiUsage(value, counted));
  const tiers = new Map<string, string>();
  return {
    step(document) {
      usage.step(document);
      for (const record of [document.value, asRecord(document.value.usage)]) {
        for (const name of CHUNK_TIER_FIELDS) {
          const raw = record?.[name];
          if (raw === undefined || raw === null) continue;
          const named = typeof raw === "string" && raw.length > 0 ? raw : "(other)";
          const seen = tiers.get(name);
          tiers.set(name, seen === undefined || seen === named ? named : "(other)");
        }
      }
    },
    finish() {
      const found = usage.finish();
      if (found === null || tiers.size === 0) return found;
      return { ...found, reportedModes: { ...found.reportedModes, ...Object.fromEntries(tiers) } };
    },
  };
}

/** The reducer of an API style's usage. `counted` is what the provider always counts in the input. */
export function usageReducer(style: ApiStyle, counted: readonly Modality[] = NOTHING_COUNTED): Reducer<UsageObservation | null> {
  switch (style) {
    case "openai-chat":
    case "openai-completions":
      return chatReducer(counted);
    case "openai-responses":
      // The closing event carries the served tier beside the usage.
      return lastRead((value) => openAiUsage(value, counted));
    case "anthropic-messages":
      return anthropicReducer();
    case "gemini-generate":
    case "gemini-embed":
      return lastRead(geminiUsage);
    case "openai-transcription":
      return lastRead((value) => audioUsage(value, counted));
    case "elevenlabs-transcription":
      return lastRead(elevenLabsTranscriptionUsage);
    case "deepgram-listen":
      return lastRead(deepgramListenUsage);
    case "openai-images":
      return lastRead((value) => imagesUsage(value, counted));
    case "openai-embeddings":
    case "openai-speech":
      // A speech answer streamed as events ends with its usage; a plain audio answer has none.
      return lastRead((value) => openAiUsage(value, counted));
  }
}

/** The model an answer names: its root `model`, or a stream event's `response.model` (Responses) or `message.model` (Messages). */
export function answeredModel(value: Record<string, unknown>): string | null {
  for (const holder of [value, value.response, value.message]) {
    const model = asRecord(holder)?.model;
    if (typeof model === "string" && model.length > 0) return model;
  }
  return null;
}

/** Whether an SSE frame is one of `names`, by its data's `type`, else by its event name with whole JSON data. */
function namedFrame(frame: SseFrame, names: readonly string[]): boolean {
  if (frame.type !== null) return names.includes(frame.type);
  return frame.event !== null && names.includes(frame.event) && frame.data === "json";
}

/** Whether a frame is its style's closing event. Null for a style whose stream has none. */
const CLOSING: Readonly<Record<ApiStyle, ((frame: SseFrame) => boolean) | null>> = {
  "openai-chat": (frame) => frame.data === "done",
  "openai-completions": (frame) => frame.data === "done",
  "openai-responses": (frame) => namedFrame(frame, ["response.completed", "response.incomplete", "response.failed"]),
  "anthropic-messages": (frame) => namedFrame(frame, ["message_stop"]),
  // Gemini's stream has no closing event: it simply ends.
  "gemini-generate": null,
  // The media APIs' streams are judged by how they ended, as in v1: their
  // closing events differ from one provider to the next, and a stream booked
  // as cut that was not would say a successful call failed.
  "openai-transcription": null,
  "openai-images": null,
  "openai-embeddings": null,
  "gemini-embed": null,
  "openai-speech": null,
  "elevenlabs-transcription": null,
  "deepgram-listen": null,
};

/**
 * Whether a stream ended with its style's closing event: the provider had
 * sent everything. Null for a style whose stream has no closing event, so
 * only the end of the stream says it is whole. A `[DONE]` some services send
 * after a Responses or Messages stream's closing event is not the stream's
 * own last word.
 */
function closingReader(style: ApiStyle): { frame(frame: SseFrame): void; settle(): void; finish(): boolean | null } {
  const closing = CLOSING[style];
  const doneCloses = style === "openai-chat" || style === "openai-completions";
  let last: SseFrame | null = null;
  return {
    frame(frame) {
      // Told without judging the data: only the last frame is ever judged.
      if (!doneCloses && (frame.isDone ?? frame.data === "done")) return;
      last = frame;
    },
    /** The frame held when a push returns is kept past it. */
    settle: () => last?.settle?.(),
    finish: () => (closing === null ? null : last !== null && closing(last)),
  };
}

/** What a response says about itself, read as it streamed past. */
export interface BodyReading {
  readonly usage: UsageObservation | null;
  /** The provider's own cost report, when the operation has one. */
  readonly providerCostUsd: number | null;
  /** The model the answer says served it. */
  readonly servedModel: string | null;
  /** For a stream: whether it ended with its style's closing event; null when the style has none, or it is no stream. */
  readonly closed: boolean | null;
  /** A declared value was too large to keep. */
  readonly overflow: boolean;
  /** More events came than the reader's limit: it stopped, and the reading is not to be used. */
  readonly stopped: boolean;
}

export interface BodyReader {
  push(text: string): void;
  /** Nothing more pushed would be read: the body is not JSON (a binary answer, say). */
  readonly failed: boolean;
  /** More events came than `maxEvents`: nothing more pushed is read. */
  readonly stopped: boolean;
  /** The body ended. `clean` says it was read to its real end: neither the app nor the provider cut it. */
  end(clean?: boolean): BodyReading;
}

export interface BodyReaderOptions {
  readonly counted?: readonly Modality[];
  readonly providerCost?: ProviderCostReport;
  /** The most events read (an SSE stream's, or a JSON array's elements). */
  readonly maxEvents?: number;
}

/**
 * Reads a response body of `contentType`, by its API style, as its text
 * streams past.
 *
 * The usage read is complete only when the answer ended whole: a stream with
 * its style's closing event (or, for a style that has none, read to its real
 * end), a JSON body closed and read to its end, the last document whole, and
 * no declared value too large to keep. Otherwise what was read may be short,
 * an earlier event's count, say: it is marked `finalEventUnread`, and billed
 * as an estimate, never as exact. One rule, for every style.
 */
export function bodyReader(contentType: string, style: ApiStyle, options: BodyReaderOptions = {}): BodyReader {
  const usage = usageReducer(style, options.counted);
  const cost = options.providerCost === undefined ? null : lastRead(costReader(options.providerCost));
  const model = lastRead(answeredModel);
  const stream = isEventStream(contentType);
  const closing = closingReader(style);
  const frames = framer(
    contentType,
    READ_PATHS,
    {
      onDocument(document) {
        usage.step(document);
        cost?.step(document);
        model.step(document);
      },
      onFrame: (frame) => closing.frame(frame),
    },
    options.maxEvents === undefined ? {} : { maxEvents: options.maxEvents },
  );
  return {
    push(text) {
      frames.push(text);
      closing.settle();
    },
    get failed() {
      return frames.failed;
    },
    get stopped() {
      return frames.stopped;
    },
    end(clean = true) {
      frames.end();
      const closed = stream ? closing.finish() : null;
      // A closing event says the stream is whole; without one, its real end does.
      const ended = closed ?? clean;
      const whole = ended && !frames.cut && !frames.overflow;
      let read = usage.finish();
      if (read !== null && !whole) read = { ...read, finalEventUnread: true };
      return {
        usage: read,
        providerCostUsd: cost?.finish() ?? null,
        servedModel: model.finish(),
        closed,
        overflow: frames.overflow,
        stopped: frames.stopped,
      };
    },
  };
}

/** Reads a whole body at once. For tests, and the place a body's whole text is at hand. */
export function readBody(text: string, contentType: string, style: ApiStyle, options: BodyReaderOptions = {}): BodyReading {
  const reader = bodyReader(contentType, style, options);
  reader.push(text);
  return reader.end();
}

/** A header's value as a count: a whole number and nothing else, or null. */
function headerCount(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return /^\d{1,15}$/u.test(trimmed) ? Number(trimmed) : null;
}

/**
 * Adds the bucket shares a provider reports in its response headers rather
 * than its body: only that provider's headers, on that API, and only where
 * the body did not report the share. A streamed response is never read this
 * way: its headers are sent before the body, and Kimi documents that a
 * stream's split is not in them.
 */
export function withHeaderVariants(
  usage: UsageObservation,
  headers: Headers,
  contentType: string,
  providerType: string,
  style: ApiStyle,
): UsageObservation {
  if (isEventStream(contentType)) return usage;
  let found = usage.tokenVariants as VariantCounts | undefined;
  for (const variant of VARIANTS) {
    const report = variant.reportedInHeader;
    if (!report || report.provider !== providerType || report.style !== style) continue;
    if (found?.[variant.bucket]?.[variant.name] !== undefined) continue;
    const count = headerCount(headers.get(report.header));
    if (!count) continue;
    found = { ...found, [variant.bucket]: { ...found?.[variant.bucket], [variant.name]: count } };
  }
  return found === usage.tokenVariants ? usage : { ...usage, tokenVariants: found as TokenVariants };
}

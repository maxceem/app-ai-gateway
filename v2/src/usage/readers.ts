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
 * - A stream event whose JSON never closed (a cut stream) still gives up a
 *   whole `usage` object it holds, after every intact event was tried.
 */
import type { ObservedText } from "../proxy/observe.ts";
import type { ApiStyle } from "../providers/operation.ts";
import type { Modality, ModalityCounts, TokenVariants, UsageObservation } from "./observation.ts";
import { anchoredRootFields, type AnchoredText } from "./root-fields.ts";
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

/** Documents and objects read by scanning text, not parsed whole: a mode in one may be the client's own text. */
const SCANNED = new WeakSet<object>();

function reportedModes(
  records: readonly (Record<string, unknown> | null)[],
  names: readonly ReportedModeField[],
): Pick<UsageObservation, "reportedModes" | "modesScanned"> {
  let found: Record<string, string> | undefined;
  let scanned = false;
  for (const name of names) {
    for (const record of records) {
      const value = record?.[name];
      if (value === undefined || value === null) continue;
      // A value that is not a usable string is kept too, as one no table
      // knows: the gateway then bills at least at standard, as an estimate.
      (found ??= {})[name] = typeof value === "string" && value.length > 0 ? value : "(other)";
      if (record && SCANNED.has(record)) scanned = true;
      break;
    }
  }
  return found ? { reportedModes: found, ...(scanned ? { modesScanned: true as const } : {}) } : {};
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
// Response bodies as values

/** Marks a block that carries no value: empty, `[DONE]`, or cut. */
const NO_VALUE = Symbol("no SSE value");

/** One SSE block's `data:` payload, or null when it carries nothing. */
/**
 * An SSE event's data: its `data:` lines only, each without the field name and
 * one space after it, joined with line breaks as SSE does. Comments and other
 * fields are dropped. The one place an event's data is taken, for whole events
 * and cut ones alike. `cutAtStart` is for an event that a window cut at its
 * start, and that ended: its first line is the rest of a line whose field name
 * was cut off, of unknown kind. When a whole `data:` line follows it, it is
 * dropped: only whole lines after a line break the reader saw are classified.
 * When none does, it is the event's last line, holding the end of its data
 * (an image or a final answer larger than the kept tail), and it is kept as
 * data, read as a tail from the event's end.
 */
function sseData(block: string, cutAtStart = false): string | null {
  const lines = block.split("\n");
  const keepFirst = cutAtStart && !lines.slice(1).some((line) => line.startsWith("data:"));
  const data = lines
    .flatMap((line, index) => {
      if (index === 0 && cutAtStart) return keepFirst ? [line] : [];
      if (!line.startsWith("data:")) return [];
      const value = line.slice(5);
      return [value.startsWith(" ") ? value.slice(1) : value];
    })
    .join("\n");
  return data === "" || data === "[DONE]" ? null : data;
}

/**
 * One SSE window as its events, each parsed only when a reader reaches it,
 * and at most once. `cut` gives the events whose JSON never closed, as the
 * usage documents they may still hold, for the readers to try last.
 */
function sseEvents(text: string): { forwards(): Iterable<unknown>; backwards(): Iterable<unknown>; cut(): Iterable<unknown> } {
  const blocks = text.replace(/\r\n/gu, "\n").split("\n\n");
  const parsed = new Array<unknown>(blocks.length);
  // Events whose data is not whole JSON: each starts where its event starts,
  // and ended when a blank line follows it inside the text.
  const broken: { data: string; ended: boolean }[] = [];
  function valueAt(index: number): unknown {
    const seen = parsed[index];
    if (seen !== undefined) return seen;
    const data = sseData(blocks[index]!);
    let value: unknown = NO_VALUE;
    if (data !== null) {
      try {
        value = JSON.parse(data) as unknown;
      } catch {
        broken.push({ data, ended: index < blocks.length - 1 });
      }
    }
    parsed[index] = value;
    return value;
  }
  return {
    *forwards() {
      for (let index = 0; index < blocks.length; index += 1) {
        const value = valueAt(index);
        if (value !== NO_VALUE) yield value;
      }
    },
    *backwards() {
      for (let index = blocks.length - 1; index >= 0; index -= 1) {
        const value = valueAt(index);
        if (value !== NO_VALUE) yield value;
      }
    },
    *cut() {
      // Every block is parsed by now, so `broken` is complete.
      for (let index = 0; index < blocks.length; index += 1) valueAt(index);
      for (const { data, ended } of broken) {
        const document = rootFields({ head: data, ...(ended ? { tail: data } : {}) });
        if (document) yield document;
      }
    },
  };
}

/** Two Anthropic events as one: field-wise `max`, as each reports its own half. */
function mergeAnthropicUsage(left: UsageObservation, right: UsageObservation): UsageObservation {
  const tokenVariants = mergeTokenVariants(left.tokenVariants, right.tokenVariants);
  // The later event's word wins where both name the mode.
  const modes = left.reportedModes || right.reportedModes ? { ...right.reportedModes, ...left.reportedModes } : undefined;
  return {
    inputTokens: Math.max(left.inputTokens, right.inputTokens),
    cachedInputTokens: Math.max(left.cachedInputTokens, right.cachedInputTokens),
    cacheWriteTokens: Math.max(left.cacheWriteTokens, right.cacheWriteTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
    ...(tokenVariants ? { tokenVariants } : {}),
    ...(modes ? { reportedModes: modes } : {}),
    ...(left.modesScanned || right.modesScanned ? { modesScanned: true as const } : {}),
  };
}

/** Whether a value carries usage under `message`: Anthropic's `message_start`, the stream's first event. */
function carriesMessageUsage(value: unknown): boolean {
  return asRecord(asRecord(value)?.message)?.usage !== undefined;
}

/**
 * A tail window opens in the middle of an event, and half an event must never
 * read as a whole one, so the events are only those after the first boundary.
 * What comes before it is kept apart as `cut`.
 */
/**
 * A kept tail's first event, cut at its start, and the whole events after it.
 * `ended` says the cut event did end inside the tail, so its end is known.
 */
function splitTail(tail: string): { cut: string; ended: boolean; events: string } {
  const normalized = tail.replace(/\r\n/gu, "\n");
  const boundary = normalized.indexOf("\n\n");
  return boundary === -1
    ? { cut: normalized, ended: false, events: "" }
    : { cut: normalized.slice(0, boundary), ended: true, events: normalized.slice(boundary + 2) };
}

/**
 * The root fields a reader or the meter needs from a document it cannot parse
 * whole: its usage objects, and the values naming what served it and how much
 * (the model, the tier, a transcription's duration). `./root-fields.ts` is
 * the only way any reader gets them, through explicit anchors. Each value is
 * raw, whatever its type: the reader judges it, so a tier that is a number or
 * empty is present but unusable, which means unknown.
 */
const ROOT_PATHS: readonly (readonly string[])[] = [
  ["usage"],
  ["usageMetadata"],
  ["model"],
  ["service_tier"],
  ["duration"],
  // A Responses event keeps its answer's fields under `response`.
  ["response", "usage"],
  ["response", "model"],
  ["response", "service_tier"],
];

/** Marks a document and every object in it as scanned, not parsed whole. */
function markScanned(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  SCANNED.add(value);
  for (const inner of Object.values(value)) markScanned(inner);
}

function rootFields(text: AnchoredText): Record<string, unknown> | null {
  const root = anchoredRootFields(text, ROOT_PATHS);
  if (root !== null) markScanned(root);
  return root;
}

/** Whether a body was read to its real end: neither the app nor the provider cut it. */
function readToEnd(body: ObservedText): boolean {
  const flags = body as Partial<{ clientAborted: boolean; upstreamFailed: boolean }>;
  return flags.clientAborted !== true && flags.upstreamFailed !== true;
}

/** The values of one response, parsed where a reader reaches one and nowhere else. */
export interface ResponseValues {
  /** Every value, the last one first, then the cut ones. */
  backwards(): Iterable<unknown>;
  /** The values of the head window, first first. Only Anthropic needs it: `message_start` opens the stream. */
  headForwards(): Iterable<unknown>;
  /** A stream whose final event was cut and gave no usage: any usage read is from an earlier event. */
  finalEventUnread?(): boolean;
}

function documentValues(values: readonly unknown[]): ResponseValues {
  return {
    *backwards() {
      for (let index = values.length - 1; index >= 0; index -= 1) yield values[index];
    },
    headForwards: () => values,
  };
}

function isEventStream(contentType: string): boolean {
  return contentType.toLowerCase().includes("text/event-stream");
}

/** One response body as its values: the document, or every SSE event. */
export function responseValues(body: ObservedText, contentType: string): ResponseValues {
  if (isEventStream(contentType)) {
    // Both windows are read: an Anthropic stream reports its input tokens at
    // the head and its output tokens at the tail.
    const head = sseEvents(body.head);
    const split = body.truncated ? splitTail(body.tail) : null;
    const tail = split ? sseEvents(split.events) : null;
    let cutDocument: Record<string, unknown> | null | undefined;
    // The event the tail window cut at its start, read from its end when it ended.
    const cutEvent = (): Record<string, unknown> | null => {
      if (cutDocument === undefined) {
        const data = split?.ended ? sseData(split.cut, true) : null;
        cutDocument = data === null ? null : rootFields({ tail: data });
      }
      return cutDocument;
    };
    return {
      *backwards() {
        if (tail) yield* tail.backwards();
        if (split) {
          // The duration a transcription's cut event still shows counts too, as v1.
          const document = cutEvent();
          if (document) yield document;
        }
        yield* head.backwards();
        // Events cut inside a window, tried only after every intact one.
        if (tail) yield* tail.cut();
        yield* head.cut();
      },
      headForwards: () => head.forwards(),
      finalEventUnread() {
        // Only when the cut event is the stream's last with data, and gave no usage.
        if (split === null || tail === null || split.cut.trim() === "") return false;
        for (const _value of tail.forwards()) return false;
        const document = cutEvent();
        const response = document?.response as Record<string, unknown> | undefined;
        return document === null || (document.usage === undefined && document.usageMetadata === undefined && response?.usage === undefined);
      },
    };
  }
  if (body.truncated) {
    // One root, read field by field: each root field is taken from the kept
    // tail, where most answers report, else from the top of the kept head,
    // for an answer that reports it before a large payload.
    // The head starts at the body's start; the tail ends at its end only when it was read to the end.
    const document = rootFields({ head: body.head, ...(readToEnd(body) ? { tail: body.tail } : {}) });
    return documentValues(document === null ? [] : [document]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.head) as unknown;
  } catch {
    // A body whose JSON never closed (a cut answer): its start is known, its end is not.
    const document = rootFields({ head: body.head });
    return documentValues(document === null ? [] : [document]);
  }
  return documentValues(Array.isArray(parsed) ? parsed : [parsed]);
}

/** `counts` merged with the stream's `message_start`, which is the only event naming the input tokens. */
function withMessageStart(counts: UsageObservation, values: ResponseValues): UsageObservation {
  let merged = counts;
  for (const value of values.headForwards()) {
    const earlier = anthropicUsage(value);
    if (earlier) merged = mergeAnthropicUsage(merged, earlier);
    if (carriesMessageUsage(value)) break;
  }
  return merged;
}

function lastReported(values: ResponseValues, read: (value: unknown) => UsageObservation | null): UsageObservation | null {
  for (const value of values.backwards()) {
    const parsed = read(value);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * Anthropic splits a stream in two: `message_start` has the input tokens and
 * every `message_delta` the cumulative output tokens. The last one merged with
 * `message_start` is the whole.
 */
function anthropicReader(values: ResponseValues): UsageObservation | null {
  for (const value of values.backwards()) {
    const counts = anthropicUsage(value);
    if (!counts) continue;
    return carriesMessageUsage(value) ? counts : withMessageStart(counts, values);
  }
  return null;
}

const CHUNK_TIER_FIELDS = ["service_tier", "response_service_tier"] as const;

/**
 * A Chat Completions stream names its served tier on its chunks, not always
 * on the last one with the usage: a content chunk may say `default` and the
 * usage chunk nothing. So the tier is read across every chunk, apart from the
 * counts: the last value reported wins. Two different values say nothing the
 * gateway can price, so they read as one no table knows, which bills at least
 * at standard, as an estimate.
 */
function withStreamTier(usage: UsageObservation, values: ResponseValues): UsageObservation {
  let found: Record<string, string> | undefined;
  let scanned = usage.modesScanned === true;
  for (const name of CHUNK_TIER_FIELDS) {
    let last: string | undefined;
    for (const value of values.backwards()) {
      const root = asRecord(value);
      if (root === null) continue;
      for (const record of [root, asRecord(root.usage)]) {
        const raw = record?.[name];
        if (raw === undefined || raw === null) continue;
        const named = typeof raw === "string" && raw.length > 0 ? raw : "(other)";
        if (record !== null && SCANNED.has(record)) scanned = true;
        if (last === undefined) last = named;
        else if (named !== last) last = "(other)";
      }
    }
    if (last !== undefined) (found ??= {})[name] = last;
  }
  if (found === undefined) return usage;
  return { ...usage, reportedModes: { ...usage.reportedModes, ...found }, ...(scanned ? { modesScanned: true as const } : {}) };
}

/**
 * The usage a response reports, read by its API style's reader, or null when
 * it reports none this gateway can read. `counted` is the input modalities
 * the provider declares it always counts, which only the OpenAI shape reads.
 */
export function readUsage(values: ResponseValues, style: ApiStyle, counted: readonly Modality[] = NOTHING_COUNTED): UsageObservation | null {
  const usage = readStyleUsage(values, style, counted);
  return usage !== null && values.finalEventUnread?.() === true ? { ...usage, finalEventUnread: true } : usage;
}

function readStyleUsage(values: ResponseValues, style: ApiStyle, counted: readonly Modality[]): UsageObservation | null {
  switch (style) {
    case "openai-chat":
    case "openai-completions": {
      const usage = lastReported(values, (value) => openAiUsage(value, counted));
      return usage === null ? null : withStreamTier(usage, values);
    }
    case "openai-responses":
      // The closing event carries the served tier beside the usage.
      return lastReported(values, (value) => openAiUsage(value, counted));
    case "anthropic-messages":
      return anthropicReader(values);
    case "gemini-generate":
    case "gemini-embed":
      return lastReported(values, geminiUsage);
    case "openai-transcription":
      return lastReported(values, (value) => audioUsage(value, counted));
    case "openai-images":
      return lastReported(values, (value) => imagesUsage(value, counted));
    case "openai-embeddings":
    case "openai-speech":
      // A speech answer streamed as events ends with its usage; a plain audio answer has none.
      return lastReported(values, (value) => openAiUsage(value, counted));
  }
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

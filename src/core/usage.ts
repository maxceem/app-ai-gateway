import prices from "./prices.json";
import { markApiKeyUsed } from "./apikeys";
import { readProviderReport, type ProviderReport } from "../shared/cost-report";
import { routeCanonicalModel, type ResolvedRoute } from "./routes";
import { log } from "./log";
import { timeOrderedId } from "./ids";
import { storedAppVersion } from "./app-version";
import { claimDiagnosticSample } from "./endpoint-rate-limit";
import { projectUsageEventSpend } from "./app-usage-accounting";
import { costReport, namespaceModelAuthor, providerModelAuthor, reportsCost } from "./providers";
import { asRecord, lookup } from "../shared/records";
import type { GatewayAuthMethod, ProviderType, UsageCounts } from "./types";
import { database } from "../db";
import {
  appUsageEvent,
  type CostSource,
  type ProviderPricing,
} from "../db/schema";

export type { ProviderReport } from "../shared/cost-report";

interface Price {
  input?: number;
  output?: number;
  cached_input?: number;
  cache_write?: number;
  per_minute?: number;
  per_hour?: number;
  long_context_threshold?: number;
  long_input?: number;
  long_output?: number;
  long_cached_input?: number;
  long_cache_write?: number;
  /**
   * Who made the model, where the catalog knows better than the provider type
   * does — a Llama model served by Groq is Meta's. Curated per entry alongside
   * the prices; absent falls back to the provider type's own author.
   */
  author?: string;
}

interface UsageObservation extends UsageCounts {
  audioSeconds?: number;
}

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
  const catalog = prices as Partial<Record<ProviderType, Record<string, Price>>>;
  return lookup(catalog[provider], model);
}

/**
 * Model pricing is a two-level lookup: the resolved provider row's own
 * overrides win, then the deployment-global catalog. A model priced by neither
 * never proxies unless its route reports cost, so `cost_usd` is never NULL.
 */
function modelPrice(
  provider: ProviderType,
  model: string,
  overrides?: ProviderPricing | null,
): Price | undefined {
  const override = lookup(overrides, model);
  if (override) return { input: override.input, output: override.output };
  return catalogPrice(provider, model);
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
 * Whether a request can be billed at all, which is the only reason it is
 * allowed to proxy. Two ways to know what it costs: a local price for the
 * canonical model, or a route that reports its own cost per request. Neither
 * means the spend would be invisible, and an invisible spend is a limit bypass.
 */
export function isBillable(
  provider: ProviderType,
  model: string,
  overrides?: ProviderPricing | null,
): boolean {
  return reportsCost(provider) || hasModelPrice(provider, model, overrides);
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

interface UsageEventInput {
  env: Env;
  organizationId: string;
  /**
   * What the usage observer read off the response body, settled once the client
   * has the whole body or has walked away from it. Null when there was no body
   * to observe, as on a provider error.
   */
  observed: Promise<ObservedBody> | null;
  contentType: string;
  appId: string;
  /** Null when the application identifies no end users; see {@link GatewayIdentity}. */
  userId: string | null;
  authMethod: GatewayAuthMethod;
  apiKeyId?: string;
  provider: ProviderType;
  /** The provider row that served the traffic. */
  providerId: string;
  /** Caller-visible provider instance slug at the time of the request. */
  providerSlug: string;
  /**
   * How the request was routed: which adapter carried it, the gateway row
   * behind it if any, and that row's own routing configuration. Known with
   * certainty at request time, so the attribution it settles is recorded for
   * every event — unlike the observed fields below, which the upstream has to
   * volunteer. It also carries the namespace an observed model ID is stripped
   * with, so canonicalizing inbound uses exactly the prefix the outbound
   * rewrite used.
   *
   * Named for the row's route, not the request's: `route` below is the
   * `slug/path` string this event records.
   */
  providerRoute: ResolvedRoute;
  /** That row's per-model pricing overrides, which win over the catalog. */
  pricing?: ProviderPricing | null;
  /** Canonical model ID: the provider's own, whatever the route called it. */
  model: string;
  route: string;
  /** Set for named endpoint traffic; null for the passthrough proxy. */
  endpointSlug?: string | null;
  appVersion: string | null;
  status: "ok" | "provider_error";
  latencyMs: number;
}

interface BlockedUsageEventInput {
  env: Env;
  organizationId: string;
  appId: string;
  /** Null when the application identifies no end users; see {@link GatewayIdentity}. */
  userId: string | null;
  authMethod: GatewayAuthMethod;
  apiKeyId?: string;
  provider: string;
  /** Unset when the request was blocked before a provider row was resolved. */
  providerId?: string | null;
  providerSlug?: string | null;
  model: string;
  route: string;
  endpointSlug?: string | null;
  appVersion: string | null;
  /**
   * Which system refused the request: `blocked_app_*` the organization's own app
   * limits, `blocked_billing` the plan allowance, `blocked_user` an operator.
   */
  status: "blocked_app_rate" | "blocked_app_budget" | "blocked_billing" | "blocked_user";
  latencyMs: number;
}

const EMPTY: UsageCounts = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
};

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberAt(record: Record<string, unknown>, key: string): number {
  const value = finiteNumber(record[key]);
  return value === null ? 0 : Math.max(0, Math.trunc(value));
}

/**
 * Whether a `usage` object carries at least one counter this pipeline can
 * price. An object made only of fields we do not know — Cohere's
 * `usage.billed_units`, for instance — reads as all-zero and is otherwise
 * indistinguishable from a genuinely free request, which is exactly the silent
 * $0 the caller must never be handed.
 */
function countsAny(usage: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => finiteNumber(usage[key]) !== null);
}

function openAiUsage(value: unknown): UsageObservation | null {
  const root = asRecord(value);
  if (!root) return null;
  const response = asRecord(root.response) ?? root;
  const usage = asRecord(response.usage);
  if (!usage) return null;
  if (!countsAny(usage, ["input_tokens", "prompt_tokens", "output_tokens", "completion_tokens"])) {
    return null;
  }
  const inputTotal = numberAt(usage, "input_tokens") || numberAt(usage, "prompt_tokens");
  const details = asRecord(usage.input_tokens_details) ?? asRecord(usage.prompt_tokens_details);
  // Cache hits are the same fact under four spellings. OpenAI, Mistral,
  // Fireworks and Cerebras nest it in `*_tokens_details`; Moonshot and
  // Together's non-reasoning models put `cached_tokens` at the usage root;
  // DeepSeek names it `prompt_cache_hit_tokens`. Read positionally, not per
  // provider — the field names are unambiguous, and a provider that reports
  // none simply has no cache hits to price. Missing it is not free: the cached
  // bucket falls back to the full input price, so every one of these providers
  // would over-bill exactly the traffic their cache discount is for.
  const cached = (details ? numberAt(details, "cached_tokens") : 0)
    || numberAt(usage, "cached_tokens")
    || numberAt(usage, "prompt_cache_hit_tokens");
  const cacheWrite = details ? numberAt(details, "cache_write_tokens") : 0;
  return {
    inputTokens: Math.max(0, inputTotal - cached - cacheWrite),
    cachedInputTokens: cached,
    cacheWriteTokens: cacheWrite,
    outputTokens: numberAt(usage, "output_tokens") || numberAt(usage, "completion_tokens"),
  };
}

function anthropicUsage(value: unknown): UsageCounts | null {
  const root = asRecord(value);
  if (!root) return null;
  const message = asRecord(root.message) ?? root;
  const usage = asRecord(message.usage) ?? asRecord(root.usage);
  if (!usage) return null;
  if (
    !countsAny(usage, [
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
    ])
  ) {
    return null;
  }
  return {
    inputTokens: numberAt(usage, "input_tokens"),
    cachedInputTokens: numberAt(usage, "cache_read_input_tokens"),
    cacheWriteTokens: numberAt(usage, "cache_creation_input_tokens"),
    outputTokens: numberAt(usage, "output_tokens"),
  };
}

function geminiUsage(value: unknown): UsageCounts | null {
  const root = asRecord(value);
  if (!root) return null;
  const usage = asRecord(root.usageMetadata);
  if (!usage) return null;
  if (!countsAny(usage, ["promptTokenCount", "cachedContentTokenCount", "candidatesTokenCount"])) {
    return null;
  }
  const promptTotal = numberAt(usage, "promptTokenCount");
  const cached = numberAt(usage, "cachedContentTokenCount");
  return {
    inputTokens: Math.max(0, promptTotal - cached),
    cachedInputTokens: cached,
    cacheWriteTokens: 0,
    outputTokens: numberAt(usage, "candidatesTokenCount"),
  };
}

function audioUsage(value: unknown): UsageObservation | null {
  const root = asRecord(value);
  if (!root) return null;
  const duration = root.duration;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) return null;
  return { ...EMPTY, audioSeconds: duration };
}

/** Marks a block that carries no value: empty, `[DONE]`, or malformed. */
const NO_VALUE = Symbol("no SSE value");

/** One SSE block's `data:` payload, or null when it carries nothing to parse. */
function sseData(block: string): string | null {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  return !data || data === "[DONE]" ? null : data;
}

/**
 * One SSE window as its events, parsed only where a reader reaches one.
 *
 * Splitting the text into blocks is cheap work over the window; parsing them is
 * what costs, and every shape this file reads reports at one end of a stream.
 * Walking from the last block back therefore costs the few events that carry
 * the answer rather than a `JSON.parse` per delta chunk. Each block is parsed
 * at most once however many readers reach it, because usage and a cost report
 * are read off the same window.
 */
function sseEvents(text: string): {
  forwards(): Iterable<unknown>;
  backwards(): Iterable<unknown>;
} {
  const blocks = text.replace(/\r\n/gu, "\n").split("\n\n");
  const parsed = new Array<unknown>(blocks.length);
  function valueAt(index: number): unknown {
    const seen = parsed[index];
    // `JSON.parse` never answers `undefined`, so an untouched slot is the only
    // thing that reads as one.
    if (seen !== undefined) return seen;
    const data = sseData(blocks[index]!);
    let value: unknown = NO_VALUE;
    if (data !== null) {
      try {
        value = JSON.parse(data) as unknown;
      } catch {
        // A malformed event is ignored; another event may still be usable.
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
  };
}

/**
 * The two windows the observer keeps. Usage lives at one end of every shape
 * this file knows — OpenAI puts `usage` last, an SSE stream reports in its
 * final events, and Anthropic's `message_start` opens the stream — so the ends
 * are what a body is kept for. The middle of a batch of embeddings or a long
 * tool result is megabytes of text that says nothing about what was billed.
 */
export const OBSERVER_HEAD_BYTES = 256 * 1024;
export const OBSERVER_TAIL_BYTES = 1024 * 1024;

/** Exactly what `Response.body` is, so the pipe stays assignable to it. */
type ResponseBodyStream = ReadableStream<Uint8Array<ArrayBuffer>>;

/** The text of one response body: the whole of it, or its two ends. */
export interface ObservedText {
  /** The start of the body, and all of it unless `truncated`. */
  head: string;
  /** The end of the body; empty unless `truncated`. */
  tail: string;
  /** True when bytes between the two windows were dropped. */
  truncated: boolean;
}

/** One body as the observer kept it, with what it measured of the whole. */
export interface BodyWindows extends ObservedText {
  /** Every byte the upstream delivered, including the dropped ones. */
  totalBytes: number;
}

/** An untruncated body, for callers that already hold the whole text. */
export function wholeBody(text: string): ObservedText {
  return { head: text, tail: "", truncated: false };
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * Collects the first {@link OBSERVER_HEAD_BYTES} and the last
 * {@link OBSERVER_TAIL_BYTES} of a body, and never more than their sum: a
 * response of any size costs the same bounded memory, where buffering it whole
 * would let one batch embeddings call decide how much an isolate holds.
 *
 * Chunks are copied in rather than referenced, because the same bytes are on
 * their way to the client and are not the observer's to keep.
 */
export function bodyWindows(): {
  push(chunk: Uint8Array): void;
  /** Bytes retained right now: the memory bound this observer promises. */
  retainedBytes(): number;
  read(): BodyWindows;
} {
  const head: Uint8Array[] = [];
  const tail: Uint8Array[] = [];
  let headBytes = 0;
  let tailBytes = 0;
  let totalBytes = 0;
  return {
    push(chunk) {
      totalBytes += chunk.byteLength;
      if (headBytes < OBSERVER_HEAD_BYTES) {
        const take = Math.min(chunk.byteLength, OBSERVER_HEAD_BYTES - headBytes);
        head.push(chunk.slice(0, take));
        headBytes += take;
      }
      tail.push(chunk.slice());
      tailBytes += chunk.byteLength;
      // Drop whole chunks off the front of the ring, then trim the one that
      // straddles the boundary, so the tail is exactly the last window's bytes.
      while (tailBytes > OBSERVER_TAIL_BYTES) {
        const excess = tailBytes - OBSERVER_TAIL_BYTES;
        const first = tail[0]!;
        if (excess >= first.byteLength) {
          tail.shift();
          tailBytes -= first.byteLength;
        } else {
          tail[0] = first.slice(excess);
          tailBytes -= excess;
        }
      }
    },
    retainedBytes: () => headBytes + tailBytes,
    read() {
      const decoder = new TextDecoder();
      const tailBuffer = concatBytes(tail, tailBytes);
      // Short bodies leave the windows overlapping, and the overlap is exactly
      // the bytes the head already holds: dropping it rebuilds the body byte
      // for byte, so everything below a window's worth parses as it always did.
      if (headBytes + tailBytes >= totalBytes) {
        const whole = new Uint8Array(totalBytes);
        whole.set(concatBytes(head, headBytes));
        whole.set(tailBuffer.subarray(headBytes + tailBytes - totalBytes), headBytes);
        return { ...wholeBody(decoder.decode(whole)), totalBytes };
      }
      return {
        head: decoder.decode(concatBytes(head, headBytes)),
        // The tail starts mid-character as easily as mid-event; the decoder
        // marks the broken lead character and the parsers drop the event.
        tail: decoder.decode(tailBuffer),
        truncated: true,
        totalBytes,
      };
    },
  };
}

/** What the usage observer saw of one upstream response body. */
export interface ObservedBody extends BodyWindows {
  /** True only when the client stopped reading before the upstream was done. */
  aborted: boolean;
}

/**
 * Splits one upstream body into the bytes the client reads and the text the
 * usage observer reads, as a single pipe rather than a `tee()`.
 *
 * A tee keeps pulling the source to feed the observer branch after the client
 * branch is cancelled, so a user closing the app mid-generation leaves the
 * provider generating and the operator paying for tokens nobody will see. Here
 * the client's stream *is* the pipe: cancelling it cancels the upstream, and
 * the observer settles with whatever had arrived by then.
 */
export function observeUpstreamBody(body: ResponseBodyStream): {
  stream: ResponseBodyStream;
  observed: Promise<ObservedBody>;
} {
  const windows = bodyWindows();
  // Set both when the client cancels its side and when the pipe tears the
  // transform down after an upstream failure; the two are told apart below by
  // whether the pipe itself finished cleanly.
  let cancelled = false;
  const transform = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) {
      // The client's copy goes out first and unchanged: accounting never
      // rewrites a byte and never holds one back.
      controller.enqueue(chunk);
      windows.push(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const settle = (aborted: boolean): ObservedBody => ({ ...windows.read(), aborted });
  const observed = body.pipeTo(transform.writable).then(
    // A pipe that ran to completion either delivered the whole body or ended
    // because the client cancelled; an upstream that broke mid-body rejects
    // instead, and that is the provider's doing, not the client's.
    () => settle(cancelled),
    () => settle(false),
  );
  return { stream: transform.readable, observed };
}

/**
 * Two Anthropic events as one figure. Field-wise `max`, because each event
 * reports its own half of the request and every counter it omits reads as zero:
 * `message_start` names the input tokens and `message_delta` the cumulative
 * output tokens, and neither may pull the other's counter back down.
 */
function mergeAnthropicUsage(left: UsageCounts, right: UsageCounts): UsageCounts {
  return {
    inputTokens: Math.max(left.inputTokens, right.inputTokens),
    cachedInputTokens: Math.max(left.cachedInputTokens, right.cachedInputTokens),
    cacheWriteTokens: Math.max(left.cacheWriteTokens, right.cacheWriteTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
  };
}

type UsageShape = "openai" | "anthropic" | "gemini" | "audio";

function usageShape(value: unknown): UsageShape | null {
  const root = asRecord(value);
  if (!root) return null;
  if (asRecord(root.usageMetadata)) return "gemini";
  if (typeof root.duration === "number") return "audio";
  if (typeof root.type === "string" && root.type.startsWith("message_")) return "anthropic";
  if (asRecord(root.message)?.usage) return "anthropic";
  const response = asRecord(root.response) ?? root;
  const usage = asRecord(response.usage);
  if (!usage) return null;
  if (
    Object.hasOwn(usage, "cache_read_input_tokens")
    || Object.hasOwn(usage, "cache_creation_input_tokens")
  ) {
    return "anthropic";
  }
  return "openai";
}

/**
 * Whether a value carries usage under `message`, which on an Anthropic stream
 * is `message_start` and nothing else: the deltas report at the root. It is the
 * only event that names the input tokens, and it is the stream's first.
 */
function carriesMessageUsage(value: unknown): boolean {
  return asRecord(asRecord(value)?.message)?.usage !== undefined;
}

/**
 * A tail window opens in the middle of whatever event was in flight, and half
 * an event must never read as a whole one, so everything before the first
 * event boundary is dropped.
 */
function completeTailEvents(tail: string): string {
  const normalized = tail.replace(/\r\n/gu, "\n");
  const boundary = normalized.indexOf("\n\n");
  return boundary === -1 ? "" : normalized.slice(boundary + 2);
}

/**
 * The JSON object starting at `start`, or null when it does not close inside
 * the window. Braces are counted outside of strings; inside one, a quote ends
 * it and a backslash escapes whatever follows. Nothing else about JSON matters
 * for finding where an object ends.
 */
function jsonObjectAt(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (character === "\\") index += 1;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/** The usage objects a truncated document is worth scanning its tail for. */
const TAIL_USAGE_KEYS = ["usage", "usageMetadata"] as const;

/** Audio duration is a number rather than an object, so it is matched as one. */
const TAIL_DURATION = /"duration"\s*:\s*(-?\d+(?:\.\d+)?)/gu;

/**
 * A synthetic document carrying whatever usage the tail of a truncated JSON
 * body still holds. Every shape this file prices reports at the end of the
 * document, so the last such key is the one that counts; `null` means the
 * response said nothing readable, which records as unresolved exactly as an
 * intact response with no usage does.
 *
 * The scan cannot tell a top-level key from a nested one — the head that would
 * say so is long gone — so it takes the last one, which is where every shape
 * here puts the figure that covers the whole request.
 */
function tailUsageDocument(tail: string): Record<string, unknown> | null {
  const document: Record<string, unknown> = {};
  for (const key of TAIL_USAGE_KEYS) {
    const marker = `"${key}"`;
    // The step stops at the first character rather than searching from `-1`,
    // which `lastIndexOf` clamps back to 0 — and so would return 0 forever.
    for (
      let at = tail.lastIndexOf(marker);
      at !== -1;
      at = at > 0 ? tail.lastIndexOf(marker, at - 1) : -1
    ) {
      // A key is only a key when a value follows it; the same text inside a
      // string of content is skipped, and the search continues backwards.
      const separator = /^\s*:\s*\{/u.exec(tail.slice(at + marker.length));
      if (!separator) continue;
      const object = jsonObjectAt(tail, at + marker.length + separator[0].length - 1);
      if (!object) continue;
      try {
        document[key] = JSON.parse(object) as unknown;
        break;
      } catch {
        // Not the object it looked like; an earlier occurrence may still be.
      }
    }
  }
  // A duration is read only where nothing counted tokens: a transcription
  // reports one and no usage object, and a token-priced response that happens
  // to mention a duration somewhere must not be re-read as time-priced.
  if (Object.keys(document).length > 0) return document;
  const duration = [...tail.matchAll(TAIL_DURATION)].at(-1)?.[1];
  return duration === undefined ? null : { duration: Number(duration) };
}

/**
 * The values of one response body, parsed where a reader reaches one and
 * nowhere else. Every reader below walks from the last value backwards, because
 * that is where every shape here reports.
 */
interface ResponseValues {
  /** Every value the body carries, the last one first. */
  backwards(): Iterable<unknown>;
  /**
   * The values of the head window, the first one first. Only Anthropic needs
   * it: its input tokens are in `message_start`, which opens the stream.
   */
  headForwards(): Iterable<unknown>;
}

/** A body already parsed whole; nothing about these values is worth deferring. */
function documentValues(values: unknown[]): ResponseValues {
  return {
    *backwards() {
      for (let index = values.length - 1; index >= 0; index -= 1) yield values[index];
    },
    headForwards: () => values,
  };
}

/** One response body as its values: the document, or every SSE event. */
function responseValues(body: ObservedText, contentType: string): ResponseValues {
  if (contentType.toLowerCase().includes("text/event-stream")) {
    // Both windows are read: an Anthropic stream reports its input tokens in
    // the `message_start` event at the head and its output tokens at the tail.
    const head = sseEvents(body.head);
    const tail = body.truncated ? sseEvents(completeTailEvents(body.tail)) : null;
    return {
      *backwards() {
        if (tail) yield* tail.backwards();
        yield* head.backwards();
      },
      headForwards: () => head.forwards(),
    };
  }
  if (body.truncated) {
    const document = tailUsageDocument(body.tail);
    return documentValues(document ? [document] : []);
  }
  try {
    const parsed = JSON.parse(body.head) as unknown;
    return documentValues(Array.isArray(parsed) ? parsed : [parsed]);
  } catch {
    throw new Error("Provider response was not valid usage JSON or SSE");
  }
}

/**
 * `counts` merged with the `message_start` of the same body. The input tokens
 * of an Anthropic stream are named there and nowhere else, and it is the first
 * event, so the head is walked forwards and stops on it — on a truncated body
 * as on an intact one, and never through the deltas in between.
 */
function withMessageStart(counts: UsageCounts, values: ResponseValues): UsageCounts {
  let merged = counts;
  for (const value of values.headForwards()) {
    const earlier = anthropicUsage(value);
    if (earlier) merged = mergeAnthropicUsage(merged, earlier);
    if (carriesMessageUsage(value)) break;
  }
  return merged;
}

/**
 * Reads the usage a provider reported, or `null` when the response carries none
 * this deployment recognises. That distinction is the whole point: a provider
 * that reports zero tokens and a provider whose usage object we cannot read both
 * cost `$0` to compute, and only the second one is a metering failure.
 *
 * Values are consumed from the last one backwards and the walk stops as soon as
 * the answer is settled, which is what keeps a long stream from being parsed
 * whole. What "settled" means per shape:
 *
 * - OpenAI, Gemini and audio report once, at the end, so the answer is the last
 *   value that parses to an observation.
 * - Anthropic splits it in two: `message_start` carries the input tokens and
 *   every `message_delta` the *cumulative* output tokens. Merging the last
 *   Anthropic usage with `message_start` under field-wise `max` therefore gives
 *   exactly what merging all of them gave — no other event carries usage, and a
 *   cumulative counter is largest in the last one that reports it.
 *
 * An Anthropic-shaped value turns the rest of the walk Anthropic, so no other
 * shape's usage is ever read out of an Anthropic body: the rule the shape
 * filter enforced before any value was read, applied from the end inwards.
 */
function usageFrom(values: ResponseValues): UsageObservation | null {
  let anthropicShaped = false;
  for (const value of values.backwards()) {
    const shape = usageShape(value);
    if (shape === "anthropic") {
      anthropicShaped = true;
      const counts = anthropicUsage(value);
      if (!counts) continue;
      return carriesMessageUsage(value) ? counts : withMessageStart(counts, values);
    }
    if (anthropicShaped) continue;
    const parsed = shape === "gemini"
      ? geminiUsage(value)
      : shape === "openai"
        ? openAiUsage(value)
        : shape === "audio"
          ? audioUsage(value)
        : null;
    if (parsed) return parsed;
  }
  return null;
}

export function extractUsageText(
  text: string,
  contentType: string,
  _provider: ProviderType,
): UsageObservation | null {
  return usageFrom(responseValues(wholeBody(text), contentType));
}

/**
 * Everything one response body says about itself, parsed once. The report half
 * is read only by the integration the provider type declared, and only if it
 * declared one: usage parsing stays shape-sniffed for everyone, and no type ever
 * has another provider's fields read out of its responses.
 */
export function observeResponse(
  body: ObservedText,
  contentType: string,
  provider: ProviderType,
): { usage: UsageObservation | null; report: ProviderReport | null } {
  const values = responseValues(body, contentType);
  const reporting = costReport(provider);
  return {
    usage: usageFrom(values),
    // Handed the same backwards walk: the report of a stream is in its final
    // chunk too, and that reader stops as soon as it has one.
    report: reporting ? readProviderReport(values.backwards(), reporting) : null,
  };
}

export function computeCost(
  provider: ProviderType,
  model: string,
  usage: UsageObservation,
  overrides?: ProviderPricing | null,
): number | null {
  const price = modelPrice(provider, model, overrides);
  if (!price) return null;
  if (price.per_minute !== undefined) {
    return ((usage.audioSeconds ?? 0) / 60) * price.per_minute;
  }
  if (price.per_hour !== undefined) {
    return ((usage.audioSeconds ?? 0) / 3600) * price.per_hour;
  }
  if (price.input === undefined || price.output === undefined) return null;
  const promptTokens = usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens;
  const longContext =
    price.long_context_threshold !== undefined && promptTokens > price.long_context_threshold;
  const inputPrice = longContext ? (price.long_input ?? price.input) : price.input;
  const outputPrice = longContext ? (price.long_output ?? price.output) : price.output;
  const cachedPrice = longContext
    ? (price.long_cached_input ?? price.cached_input ?? inputPrice)
    : (price.cached_input ?? inputPrice);
  const cacheWritePrice = longContext
    ? (price.long_cache_write ?? price.cache_write ?? inputPrice)
    : (price.cache_write ?? inputPrice);
  return (
    usage.inputTokens * inputPrice +
    usage.cachedInputTokens * cachedPrice +
    usage.cacheWriteTokens * cacheWritePrice +
    usage.outputTokens * outputPrice
  ) / 1_000_000;
}

/**
 * A usage event, complete before anything is written. Construction is kept
 * separate from `persistUsageEvent` so the same value could later be handed to
 * a queue without changing how it is settled or stored.
 */
export interface UsageEvent {
  /** Stable across every retry and replay: it is what makes each step a no-op the second time. */
  eventId: string;
  /** The `app_usage_event` row exactly as it will be inserted. */
  row: typeof appUsageEvent.$inferInsert & { createdAt: string };
  /**
   * Billed duration for per-minute and per-hour models, which price on time
   * rather than tokens. Log-only: the row has no column for it, and the logged
   * value is the sole record of what a transcription cost was computed from.
   */
  audioSeconds?: number;
}

const RECORD_ATTEMPTS = 3;
const RECORD_RETRY_DELAY_MS = 25;

/**
 * Retries one recording step within the current `waitUntil`. Retrying is only
 * safe because every step is idempotent: an ambiguous failure that actually
 * landed costs a wasted no-op, never a double charge or a duplicate row.
 */
async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RECORD_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < RECORD_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RECORD_RETRY_DELAY_MS * attempt));
      }
    }
  }
  throw lastError;
}

/**
 * Runs a step to exhaustion and reports whether it landed. A step that never
 * succeeds is logged under one code and abandoned rather than rethrown: the
 * response was served long ago, and partial progress stays valid because a
 * later duplicate attempt is harmless.
 */
async function recordStep(
  step: string,
  event: UsageEvent,
  operation: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await withRetry(operation);
    return true;
  } catch (error) {
    log("error", "usage_record_failed", {
      eventId: event.eventId,
      appId: event.row.appId,
      userId: event.row.userId,
      step,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Conflict on the unique `event_id` means a previous attempt already stored the row. */
function insertUsageEvent(env: Env, event: UsageEvent): Promise<unknown> {
  return database(env.DB)
    .insert(appUsageEvent)
    .values({
      ...event.row,
      eventId: event.eventId,
      appVersion: storedAppVersion(event.row.appVersion),
    })
    .onConflictDoNothing({ target: appUsageEvent.eventId });
}

/**
 * Persists the canonical D1 event first. Its insert trigger updates both
 * aggregate scopes in the same transaction; only after that succeeds may the
 * latest versions be projected to limiters. A failed projection remains
 * pending for scheduled recovery, while a duplicate event insert changes no
 * aggregate and can safely replay the same latest versions.
 */
export async function persistUsageEvent(env: Env, event: UsageEvent): Promise<void> {
  const outcomes: boolean[] = [];
  const stored = await recordStep("usage_insert", event, () => insertUsageEvent(env, event));
  outcomes.push(stored);
  if (stored && Math.round(Number(event.row.costUsd ?? 0) * 1_000_000) !== 0) {
    outcomes.push(await recordStep("limiter_projection", event, () =>
      projectUsageEventSpend(env, {
        appId: event.row.appId,
        userId: event.row.userId ?? null,
        month: event.row.createdAt.slice(0, 7),
      })));
  }
  const apiKeyId = event.row.apiKeyId;
  if (apiKeyId) {
    outcomes.push(await recordStep("api_key_used", event, () => markApiKeyUsed(env, apiKeyId)));
  }
  if (!outcomes.every(Boolean)) return;
  log("info", "usage_recorded", {
    eventId: event.eventId,
    appId: event.row.appId,
    userId: event.row.userId,
    provider: event.row.providerType,
    providerSlug: event.row.providerSlug,
    model: event.row.model,
    status: event.row.status,
    // Undefined on a request the client read to the end, where JSON.stringify
    // drops the field: only an abort is worth saying out loud.
    aborted: event.row.clientAborted === 1 ? true : undefined,
    inputTokens: event.row.inputTokens,
    cachedInputTokens: event.row.cachedInputTokens,
    cacheWriteTokens: event.row.cacheWriteTokens,
    outputTokens: event.row.outputTokens,
    // Undefined for token-priced traffic, where JSON.stringify drops the field.
    audioSeconds: event.audioSeconds,
    costUsd: event.row.costUsd,
    costSource: event.row.costSource,
  });
}

export async function recordUsageEvent(input: UsageEventInput): Promise<void> {
  // Minted before any work, so the observer read, the retries below and any
  // later replay of this same event all settle under one identity.
  const eventId = timeOrderedId();
  const createdAt = new Date().toISOString();
  let observed: UsageObservation | null = null;
  let report: ProviderReport | null = null;
  // Whether the client walked away mid-stream. It does not change the status —
  // the request was served as far as the caller wanted it — but it is why a
  // stream can end without the usage the provider only sends at the end.
  let aborted = false;
  if (input.observed) {
    const body = await input.observed;
    aborted = body.aborted;
    if (body.truncated) {
      // The response was too big to keep whole, so usage was read from its two
      // ends. Nothing is wrong with that, but how often it happens is the only
      // way to tell a rare batch call from a shape that no longer fits.
      log("info", "usage_observer_truncated", {
        eventId,
        appId: input.appId,
        userId: input.userId,
        provider: input.provider,
        contentType: input.contentType,
        totalBytes: body.totalBytes,
      });
    }
    try {
      const seen = observeResponse(body, input.contentType, input.provider);
      observed = seen.usage;
      report = seen.report;
    } catch (error) {
      log("warn", "usage_extraction_failed", {
        eventId,
        appId: input.appId,
        userId: input.userId,
        provider: input.provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const reporting = reportsCost(input.provider);
  const reportedCost = report?.costUsd ?? null;
  const usage: UsageObservation = observed ?? EMPTY;
  const price = computeCost(input.provider, input.model, usage, input.pricing);
  // A provider that answered successfully and reported nothing readable would
  // otherwise bill a legitimate-looking $0 and consume no budget — a silent
  // spend-limit bypass. The event is still recorded and the response has already
  // been served: the traffic is marked, not refused.
  //
  // A cost-reporting route fails the same way one step later: its models are
  // billable *because* it reports a cost, so a response that reports none is
  // unresolved too, unless a local price can still answer for it.
  //
  // Known limitation, deliberately not papered over: a client that aborts a
  // reporting route's stream before the final chunk takes the cost report with
  // it, and this records the request unresolved at $0. The abort now cancels
  // the upstream, so the unmeasured spend stops at the disconnect rather than
  // running to completion, but repeated aborts are still unbudgeted spend.
  // Reconciling it needs OpenRouter's generation lookup (backlog); until then a
  // sustained unresolved count is the operator's signal, which is what
  // `usage_unresolved_cost` below exists to raise, with `client_aborted` naming
  // this cause.
  //
  // The third way to arrive here is a non-reporting route whose model has no
  // local price: the billability gate refused it, but a price deleted inside the
  // configuration cache window lets one request through. Nothing computed a cost
  // for it, so `computed` at $0 would claim a free request; the cost is unknown.
  const unpriced = price === null && !reporting;
  const unresolved = input.status === "ok"
    && reportedCost === null
    && (observed === null || unpriced || (reporting && price === null));
  if (unresolved) {
    log("error", "usage_unresolved_cost", {
      eventId,
      appId: input.appId,
      userId: input.userId,
      provider: input.provider,
      providerSlug: input.providerSlug,
      model: input.model,
      route: input.route,
      contentType: input.contentType,
      // A client that hung up first is the explanation for everything that
      // follows, so it is reported ahead of the shape of what was missing.
      reason: aborted
        ? "client_aborted"
        : observed === null
          ? "no_usage_reported"
          : unpriced
            ? "no_local_price"
            : "no_cost_reported",
    });
  }
  if (unpriced) {
    // Unpriced models are refused before they proxy, so reaching here means the
    // catalog and the gate disagree. Recording the event keeps its tokens; the
    // dedicated code makes the mispricing alertable, where the old throw only
    // vanished inside `waitUntil`.
    //
    // Not an error on a reporting route: those bill on the reported figure and
    // are expected to carry no local price at all.
    log("error", "usage_unpriced_model", {
      eventId,
      appId: input.appId,
      userId: input.userId,
      provider: input.provider,
      providerSlug: input.providerSlug,
      model: input.model,
    });
  }
  // The cost-source hierarchy: what the upstream charged, else what the local
  // catalog computes, else nothing anyone can stand behind.
  //
  // "What the upstream charged" is the whole figure, not one ledger of it. On a
  // BYOK request OpenRouter's own charge and the upstream provider's are
  // reported separately and both come out of the operator's money, so the
  // integration sums them before either column is written — `cost_usd` is what
  // debits budgets and `reported_cost_usd` is the same number, kept so a
  // reported event is distinguishable from a computed one at query time.
  const cost = reportedCost ?? price ?? 0;
  const costSource: CostSource = reportedCost !== null
    ? "reported"
    : unresolved
      ? "unresolved"
      : "computed";
  const gateway = input.providerRoute.gateway;
  // Observed values come solely from the parsed report: nothing else is entitled
  // to claim who served a request, so there is no caller-supplied alternative.
  const servedModel = report?.servedModel ?? null;
  await persistUsageEvent(input.env, {
    eventId,
    row: {
      eventId,
      appId: input.appId,
      organizationId: input.organizationId,
      userId: input.userId,
      apiKeyId: input.apiKeyId ?? null,
      providerType: input.provider,
      providerId: input.providerId,
      providerSlug: input.providerSlug,
      providerGatewayId: gateway?.id ?? null,
      providerGatewayType: gateway?.type ?? null,
      // On a reporting route the configuration settles nothing: the
      // organization's own key always pays *that* service, and the question the
      // column answers is whose key paid for the inference behind it — which
      // only the response can say, per request.
      credentialSource: reporting
        ? (report?.credentialSource ?? null)
        : input.providerRoute.adapter.credentialSource,
      modelAuthor: resolveModelAuthor(input.provider, input.model),
      servedProvider: report?.servedProvider ?? null,
      servedModel: servedModel
        ? routeCanonicalModel(input.providerRoute, input.provider, servedModel)
        : null,
      model: input.model,
      route: input.route,
      endpointSlug: input.endpointSlug ?? null,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
      costUsd: cost,
      costSource,
      reportedCostUsd: reportedCost,
      appVersion: input.appVersion,
      authMethod: input.authMethod,
      status: input.status,
      clientAborted: aborted ? 1 : null,
      latencyMs: input.latencyMs,
      createdAt,
    },
    audioSeconds: usage.audioSeconds,
  });
}

export async function recordBlockedUsageEvent(input: BlockedUsageEventInput): Promise<void> {
  const createdAt = new Date().toISOString();
  // Blocked requests are diagnostics rather than accounting facts. Keep one
  // representative row per authenticated identity per minute: a caller may
  // vary model, route, status or version, but none of those opens another
  // sample. API-key apps without end users use the credential id as the stable
  // identity; the final fallback still groups by app rather than caller input.
  const subject = JSON.stringify([
    input.appId,
    input.userId === null ? "api_key" : "user",
    input.userId ?? input.apiKeyId ?? "app",
  ]);
  try {
    if (!await claimDiagnosticSample(input.env, "blocked-usage", subject, 60_000)) return;
  } catch {
    // Sampling is a cost-control boundary. If its coordinator is unavailable,
    // suppress the optional diagnostic instead of failing open into D1 writes.
    return;
  }
  const eventId = timeOrderedId();
  // A blocked request spent nothing, so there is no ledger settlement: only the
  // row and the key timestamp, both idempotent under the same identity.
  await persistUsageEvent(input.env, {
    eventId,
    row: {
      eventId,
      appId: input.appId,
      organizationId: input.organizationId,
      userId: input.userId,
      apiKeyId: input.apiKeyId ?? null,
      providerType: input.provider,
      providerId: input.providerId ?? null,
      providerSlug: input.providerSlug ?? null,
      model: input.model,
      route: input.route,
      endpointSlug: input.endpointSlug ?? null,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      // A blocked request never reached a provider, so its zero cost has no
      // source to record: nothing was metered and nothing is missing.
      costSource: null,
      appVersion: input.appVersion,
      authMethod: input.authMethod,
      status: input.status,
      latencyMs: input.latencyMs,
      createdAt,
    },
  });
}

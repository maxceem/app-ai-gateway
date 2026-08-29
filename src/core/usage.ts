import prices from "./prices.json";
import { markApiKeyUsed } from "./apikeys";
import { routeCanonicalModel } from "./capabilities";
import { credentialSource } from "./gateways";
import { log } from "./log";
import { providerModelAuthor, reportsCost } from "./providers";
import { lookup } from "./records";
import type { GatewayAuthMethod, ProviderType, UsageCounts } from "./types";
import type { UserLimiter } from "../do/UserLimiter";
import { database } from "../db";
import {
  appUsageEvent,
  type ProviderGatewayType,
  type ProviderPricing,
} from "../db/schema";

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
 * curated per model; the provider type's own author answers for the rest.
 * Aggregator slug namespaces (`google/…` on OpenRouter) join this chain in
 * Stage 4, between the two.
 *
 * Operator price overrides are deliberately not consulted: they carry prices
 * only, and shadowing a catalog entry must not erase who wrote the model.
 */
export function resolveModelAuthor(provider: ProviderType, model: string): string | null {
  return catalogPrice(provider, model)?.author ?? providerModelAuthor(provider);
}

interface UsageEventInput {
  env: Env;
  stream: ReadableStream<Uint8Array> | null;
  contentType: string;
  appId: string;
  userId: string;
  authMethod: GatewayAuthMethod;
  apiKeyId?: string;
  appLevelLimitsEnabled: boolean;
  provider: ProviderType;
  /** The provider row that served the traffic. */
  providerId: string;
  /** Caller-visible provider instance slug at the time of the request. */
  providerSlug: string;
  /**
   * The gateway that carried the request, or null for a direct call. Known with
   * certainty at request time, so it is recorded for every routed event —
   * unlike the observed fields below, which the upstream has to volunteer.
   */
  gateway?: { id: string; type: ProviderGatewayType } | null;
  /** That row's per-model pricing overrides, which win over the catalog. */
  pricing?: ProviderPricing | null;
  /** Canonical model ID: the provider's own, whatever the route called it. */
  model: string;
  /**
   * Serving provider and model the upstream named. No route reports either
   * today — this is where they land when one does, canonicalized by the same
   * adapter that put the request on the wire.
   */
  servedProvider?: string | null;
  servedModel?: string | null;
  route: string;
  /** Set for named endpoint traffic; null for the passthrough proxy. */
  endpointSlug?: string | null;
  appVersion: string | null;
  status: "ok" | "provider_error";
  latencyMs: number;
}

interface BlockedUsageEventInput {
  env: Env;
  appId: string;
  userId: string;
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
  status: "blocked_rate" | "blocked_budget" | "blocked_user";
  latencyMs: number;
}

const EMPTY: UsageCounts = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
};

function numberAt(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Whether a `usage` object carries at least one counter this pipeline can
 * price. An object made only of fields we do not know — Cohere's
 * `usage.billed_units`, for instance — reads as all-zero and is otherwise
 * indistinguishable from a genuinely free request, which is exactly the silent
 * $0 the caller must never be handed.
 */
function countsAny(usage: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => typeof usage[key] === "number" && Number.isFinite(usage[key]));
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

function parseSse(text: string): unknown[] {
  const values: unknown[] = [];
  for (const block of text.replace(/\r\n/gu, "\n").split("\n\n")) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      values.push(JSON.parse(data) as unknown);
    } catch {
      // A malformed event is ignored; a later completion event may still be usable.
    }
  }
  return values;
}

async function readObserver(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const maxObserverBytes = 4 * 1024 * 1024;
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxObserverBytes) {
      await reader.cancel();
      throw new Error("Usage observer exceeded 4 MB");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function mergeAnthropicEvents(values: unknown[]): UsageCounts | null {
  let result: UsageCounts | null = null;
  for (const value of values) {
    const parsed = anthropicUsage(value);
    if (!parsed) continue;
    result = result
      ? {
          inputTokens: Math.max(result.inputTokens, parsed.inputTokens),
          cachedInputTokens: Math.max(result.cachedInputTokens, parsed.cachedInputTokens),
          cacheWriteTokens: Math.max(result.cacheWriteTokens, parsed.cacheWriteTokens),
          outputTokens: Math.max(result.outputTokens, parsed.outputTokens),
        }
      : parsed;
  }
  return result;
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
 * Reads the usage a provider reported, or `null` when the response carries none
 * this deployment recognises. That distinction is the whole point: a provider
 * that reports zero tokens and a provider whose usage object we cannot read both
 * cost `$0` to compute, and only the second one is a metering failure.
 */
export function extractUsageText(
  text: string,
  contentType: string,
  _provider: ProviderType,
): UsageObservation | null {
  let values: unknown[];
  if (contentType.toLowerCase().includes("text/event-stream")) {
    values = parseSse(text);
  } else {
    try {
      const parsed = JSON.parse(text) as unknown;
      values = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      throw new Error("Provider response was not valid usage JSON or SSE");
    }
  }
  const anthropicValues = values.filter((value) => usageShape(value) === "anthropic");
  if (anthropicValues.length > 0) return mergeAnthropicEvents(anthropicValues);
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const shape = usageShape(values[index]);
    const parsed = shape === "gemini"
      ? geminiUsage(values[index])
      : shape === "openai"
        ? openAiUsage(values[index])
        : shape === "audio"
          ? audioUsage(values[index])
        : null;
    if (parsed) return parsed;
  }
  return null;
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
  row: typeof appUsageEvent.$inferInsert;
  /** Cost to settle against the limiters; zero when there is nothing to spend. */
  costMicrousd: number;
  /** Whether the app-wide limiter settles this event alongside the per-user one. */
  appLevelLimitsEnabled: boolean;
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
    .values(event.row)
    .onConflictDoNothing({ target: appUsageEvent.eventId });
}

/**
 * Writes one event everywhere it belongs. Limiter settlement runs first so a
 * monthly budget starts blocking as soon as the spend is known; the D1 row and
 * the API key timestamp are reporting and can lag. Steps are retried
 * independently, and all of them are idempotent, so re-persisting the same
 * event after a partial failure converges instead of double-counting.
 */
export async function persistUsageEvent(env: Env, event: UsageEvent): Promise<void> {
  const outcomes: boolean[] = [];
  if (event.costMicrousd > 0) {
    const now = Date.now();
    const limiter = env.USER_LIMITER.getByName(
      `${event.row.appId}:${event.row.userId}`,
    ) as DurableObjectStub<UserLimiter>;
    const settlements = [
      recordStep("limiter_user", event, () =>
        limiter.addCost(event.eventId, now, event.costMicrousd)),
    ];
    if (event.appLevelLimitsEnabled) {
      const appLimiter = env.USER_LIMITER.getByName(
        event.row.appId,
      ) as DurableObjectStub<UserLimiter>;
      settlements.push(
        recordStep("limiter_app", event, () =>
          appLimiter.addCost(event.eventId, now, event.costMicrousd)),
      );
    }
    outcomes.push(...(await Promise.all(settlements)));
  }
  outcomes.push(await recordStep("usage_insert", event, () => insertUsageEvent(env, event)));
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
  const eventId = crypto.randomUUID();
  let observed: UsageObservation | null = null;
  if (input.stream) {
    try {
      observed = extractUsageText(
        await readObserver(input.stream),
        input.contentType,
        input.provider,
      );
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
  // A provider that answered successfully and reported nothing readable would
  // otherwise bill a legitimate-looking $0 and consume no budget — a silent
  // spend-limit bypass. The event is still recorded and the response has already
  // been served: the traffic is marked, not refused.
  const unresolved = input.status === "ok" && observed === null;
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
    });
  }
  const usage: UsageObservation = observed ?? EMPTY;
  const price = computeCost(input.provider, input.model, usage, input.pricing);
  if (price === null) {
    // Unpriced models are refused before they proxy, so reaching here means the
    // catalog and the gate disagree. Recording at zero keeps the event and its
    // tokens; the dedicated code makes the mispricing alertable, where the old
    // throw only vanished inside `waitUntil`.
    log("error", "usage_unpriced_model", {
      eventId,
      appId: input.appId,
      userId: input.userId,
      provider: input.provider,
      providerSlug: input.providerSlug,
      model: input.model,
    });
  }
  const cost = price ?? 0;
  const gateway = input.gateway ?? null;
  const route = gateway?.type ?? "direct";
  await persistUsageEvent(input.env, {
    eventId,
    row: {
      eventId,
      appId: input.appId,
      userId: input.userId,
      apiKeyId: input.apiKeyId ?? null,
      providerType: input.provider,
      providerId: input.providerId,
      providerSlug: input.providerSlug,
      providerGatewayId: gateway?.id ?? null,
      providerGatewayType: gateway?.type ?? null,
      credentialSource: credentialSource(gateway),
      modelAuthor: resolveModelAuthor(input.provider, input.model),
      servedProvider: input.servedProvider ?? null,
      servedModel: input.servedModel
        ? routeCanonicalModel(route, input.provider, input.servedModel)
        : null,
      model: input.model,
      route: input.route,
      endpointSlug: input.endpointSlug ?? null,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
      costUsd: cost,
      costSource: unresolved ? "unresolved" : "computed",
      appVersion: input.appVersion,
      authMethod: input.authMethod,
      status: input.status,
      latencyMs: input.latencyMs,
    },
    costMicrousd: Math.max(0, Math.round(cost * 1_000_000)),
    appLevelLimitsEnabled: input.appLevelLimitsEnabled,
    audioSeconds: usage.audioSeconds,
  });
}

export async function recordBlockedUsageEvent(input: BlockedUsageEventInput): Promise<void> {
  const eventId = crypto.randomUUID();
  // A blocked request spent nothing, so there is no limiter settlement: only
  // the row and the key timestamp, both idempotent under the same identity.
  await persistUsageEvent(input.env, {
    eventId,
    row: {
      eventId,
      appId: input.appId,
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
    },
    costMicrousd: 0,
    appLevelLimitsEnabled: false,
  });
}

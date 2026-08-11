import prices from "./prices.json";
import { markApiKeyUsed } from "./apikeys";
import { log } from "./log";
import type { GatewayAuthMethod, Provider, UsageCounts } from "./types";
import type { UserLimiter } from "../do/UserLimiter";
import { database } from "../db";
import { usageEvents } from "../db/schema";

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
}

interface UsageObservation extends UsageCounts {
  audioSeconds?: number;
}

export function hasModelPrice(provider: Provider, model: string): boolean {
  const price = (prices as Record<Provider, Record<string, Price>>)[provider]?.[model];
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

export function hasTokenModelPrice(provider: Provider, model: string): boolean {
  const price = (prices as Record<Provider, Record<string, Price>>)[provider]?.[model];
  return price?.input !== undefined
    && Number.isFinite(price.input)
    && price.input >= 0
    && price.output !== undefined
    && Number.isFinite(price.output)
    && price.output >= 0;
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
  provider: Provider;
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
  appId: string;
  userId: string;
  authMethod: GatewayAuthMethod;
  apiKeyId?: string;
  provider: string;
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

function openAiUsage(value: unknown): UsageObservation | null {
  const root = asRecord(value);
  if (!root) return null;
  const response = asRecord(root.response) ?? root;
  const usage = asRecord(response.usage);
  if (!usage) return null;
  const inputTotal = numberAt(usage, "input_tokens") || numberAt(usage, "prompt_tokens");
  const details = asRecord(usage.input_tokens_details) ?? asRecord(usage.prompt_tokens_details);
  const cached = details ? numberAt(details, "cached_tokens") : 0;
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

export function extractUsageText(text: string, contentType: string, _provider: Provider): UsageObservation {
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
  if (anthropicValues.length > 0) return mergeAnthropicEvents(anthropicValues) ?? EMPTY;
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
  return EMPTY;
}

export function computeCost(
  provider: Provider,
  model: string,
  usage: UsageObservation,
): number | null {
  const providerPrices = (prices as Record<Provider, Record<string, Price>>)[provider];
  const price = providerPrices?.[model];
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

export async function recordUsageEvent(input: UsageEventInput): Promise<void> {
  let usage: UsageObservation = EMPTY;
  if (input.stream) {
    try {
      usage = extractUsageText(await readObserver(input.stream), input.contentType, input.provider);
    } catch (error) {
      log("warn", "usage_extraction_failed", {
        appId: input.appId,
        userId: input.userId,
        provider: input.provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const cost = computeCost(input.provider, input.model, usage);
  if (cost === null) {
    throw new Error(`Refusing to persist usage for unpriced model ${input.provider}/${input.model}`);
  }
  await database(input.env.DB).insert(usageEvents).values({
    appId: input.appId,
    userId: input.userId,
    provider: input.provider,
    model: input.model,
    route: input.route,
    endpointSlug: input.endpointSlug ?? null,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    outputTokens: usage.outputTokens,
    costUsd: cost,
    appVersion: input.appVersion,
    authMethod: input.authMethod,
    status: input.status,
    latencyMs: input.latencyMs,
  });
  const costMicrousd = Math.max(0, Math.round(cost * 1_000_000));
  const now = Date.now();
  const limiter = input.env.USER_LIMITER.getByName(`${input.appId}:${input.userId}`) as DurableObjectStub<UserLimiter>;
  const writes: Promise<unknown>[] = [limiter.addCost(now, costMicrousd)];
  if (input.appLevelLimitsEnabled) {
    const appLimiter = input.env.USER_LIMITER.getByName(input.appId) as DurableObjectStub<UserLimiter>;
    writes.push(appLimiter.addCost(now, costMicrousd));
  }
  if (input.apiKeyId) writes.push(markApiKeyUsed(input.env, input.apiKeyId));
  await Promise.all(writes);
  log("info", "usage_recorded", {
    appId: input.appId,
    userId: input.userId,
    provider: input.provider,
    model: input.model,
    status: input.status,
    ...usage,
    costUsd: cost,
  });
}

export async function recordBlockedUsageEvent(input: BlockedUsageEventInput): Promise<void> {
  await database(input.env.DB).insert(usageEvents).values({
    appId: input.appId,
    userId: input.userId,
    provider: input.provider,
    model: input.model,
    route: input.route,
    endpointSlug: input.endpointSlug ?? null,
    costUsd: 0,
    appVersion: input.appVersion,
    authMethod: input.authMethod,
    status: input.status,
    latencyMs: input.latencyMs,
  });
  if (input.apiKeyId) await markApiKeyUsed(input.env, input.apiKeyId);
  log("info", "usage_recorded", {
    appId: input.appId,
    userId: input.userId,
    provider: input.provider,
    model: input.model,
    status: input.status,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  });
}

/**
 * The usage reader for the OpenAI chat style (`openai-chat`), ported from
 * v1's reader for chat completions.
 *
 * It reads the `usage` object a JSON response ends with, or the final usage
 * chunk of a stream (sent when the request has
 * `stream_options.include_usage`). It walks from the end backwards, because
 * that is where usage is, and parses only the events it reaches.
 */
import type { TokenUsage } from "../pricing/tokens.ts";
import type { ObservedText } from "./observe.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A non-negative whole count at `key`, or 0 when it is absent or not a count. */
function count(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * The usage in one value, or null when it has none. Cached tokens come under
 * several spellings across OpenAI-style providers; all are read, because a
 * missed cache hit would bill at the full input rate.
 */
export function openAiChatUsage(value: unknown): TokenUsage | null {
  const root = asRecord(value);
  const usage = root === null ? null : asRecord(root.usage);
  if (usage === null) return null;
  const counted = ["prompt_tokens", "completion_tokens", "input_tokens", "output_tokens"].some(
    (key) => typeof usage[key] === "number",
  );
  if (!counted) return null;
  const prompt = count(usage, "prompt_tokens") || count(usage, "input_tokens");
  const details = asRecord(usage.prompt_tokens_details) ?? asRecord(usage.input_tokens_details);
  const cached =
    (details === null ? 0 : count(details, "cached_tokens")) ||
    count(usage, "cached_tokens") ||
    count(usage, "prompt_cache_hit_tokens");
  const cacheWrite = details === null ? 0 : count(details, "cache_write_tokens");
  return {
    inputTokens: Math.max(0, prompt - cached - cacheWrite),
    cachedInputTokens: Math.min(cached, prompt),
    cacheWriteTokens: Math.min(cacheWrite, Math.max(0, prompt - cached)),
    outputTokens: count(usage, "completion_tokens") || count(usage, "output_tokens"),
  };
}

/** One SSE block's `data:` payload, or null for a block with none, or `[DONE]`. */
function sseData(block: string): string | null {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  return data === "" || data === "[DONE]" ? null : data;
}

function* sseValuesBackwards(text: string): Iterable<unknown> {
  const blocks = text.replace(/\r\n/gu, "\n").split("\n\n");
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const data = sseData(blocks[index]!);
    if (data === null) continue;
    try {
      yield JSON.parse(data) as unknown;
    } catch {
      // A malformed or cut event is skipped; an earlier one may still be usable.
    }
  }
}

/** The JSON object starting at `start`, or null when it does not close in the text. */
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

/** The last `"usage": {...}` in a cut document's tail, as `{ usage }`, or null. */
function tailUsage(tail: string): unknown {
  const marker = '"usage"';
  for (let at = tail.lastIndexOf(marker); at !== -1; at = at > 0 ? tail.lastIndexOf(marker, at - 1) : -1) {
    const separator = /^\s*:\s*\{/u.exec(tail.slice(at + marker.length));
    if (!separator) continue;
    const object = jsonObjectAt(tail, at + marker.length + separator[0].length - 1);
    if (!object) continue;
    try {
      return { usage: JSON.parse(object) as unknown };
    } catch {
      // Not the object it looked like; an earlier one may be.
    }
  }
  return null;
}

/** Reads the usage of an observed chat response, or null when it carries none. */
export function readChatUsage(body: ObservedText, contentType: string): TokenUsage | null {
  if (contentType.toLowerCase().includes("text/event-stream")) {
    const texts = body.truncated ? [body.tail, body.head] : [body.head];
    for (const text of texts) {
      for (const value of sseValuesBackwards(text)) {
        const usage = openAiChatUsage(value);
        if (usage !== null) return usage;
      }
    }
    return null;
  }
  if (body.truncated) return openAiChatUsage(tailUsage(body.tail));
  try {
    return openAiChatUsage(JSON.parse(body.head) as unknown);
  } catch {
    return openAiChatUsage(tailUsage(body.head));
  }
}

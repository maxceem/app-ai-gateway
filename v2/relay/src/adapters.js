// @ts-check
/**
 * The relay's protocol adapters: how a session reads usage from the
 * provider's frames (plan 5.2). `open` names the session's adapter.
 *
 * Each adapter has a cheap check that picks the few frames worth parsing;
 * every other frame is forwarded untouched, never parsed. It declares its
 * usage shape: per turn, or a running total.
 *
 * Only the mock adapter exists in step 9a, against the smoke mock provider.
 * The provider adapters come with 9b (xAI) to 9e (OpenAI over WebSocket).
 * A frame no adapter reads costs nothing but the connection time.
 */

/** The token counts an adapter may report: the same list the main Worker accepts (`SLICE_MEASURES`). */
export const USAGE_MEASURES = ["input_tokens", "output_tokens", "cached_input_tokens", "cache_write_tokens"];

/**
 * @typedef {import("./journal.js").UsageEvent} UsageEvent
 * @typedef {{ shape: "per_turn" | "running_total", read(data: string | ArrayBuffer): UsageEvent | null }} Adapter
 */

/**
 * A usage event's id and counts from a parsed frame, or null when it is not
 * one: an id is a short string, and a count a whole number in the list.
 * @param {unknown} parsed
 * @returns {UsageEvent | null}
 */
function usageEvent(parsed) {
  if (typeof parsed !== "object" || parsed === null) return null;
  const fields = /** @type {{ event_id?: unknown, usage?: unknown }} */ (parsed);
  if (typeof fields.event_id !== "string" || fields.event_id === "" || fields.event_id.length > 128) return null;
  if (typeof fields.usage !== "object" || fields.usage === null) return null;
  /** @type {Record<string, number>} */
  const measures = {};
  for (const [name, value] of Object.entries(fields.usage)) {
    if (USAGE_MEASURES.includes(name) && typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000) {
      measures[name] = value;
    }
  }
  return { id: fields.event_id, measures };
}

/**
 * A text frame starting with `prefix`, parsed: anything else is not looked at.
 * @param {string} prefix
 * @param {"per_turn" | "running_total"} shape
 * @returns {Adapter}
 */
function jsonAdapter(prefix, shape) {
  return {
    shape,
    read(data) {
      if (typeof data !== "string" || !data.startsWith(prefix)) return null;
      try {
        return usageEvent(JSON.parse(data));
      } catch {
        return null;
      }
    },
  };
}

/** @type {Record<string, Adapter>} */
const ADAPTERS = {
  // The smoke mock's per-turn usage: `{"type":"mock.usage","event_id":…,"usage":{…}}`.
  mock: jsonAdapter('{"type":"mock.usage"', "per_turn"),
  // A running total, as xAI reports (9b), for the journal's tests: `{"type":"mock.total",…}`.
  mock_total: jsonAdapter('{"type":"mock.total"', "running_total"),
};

/** An adapter that reads nothing: the session is metered by connection time only. @type {Adapter} */
const NONE = { shape: "per_turn", read: () => null };

/** The adapter `open` named, or one that reads nothing. @param {string | undefined} name */
export function adapterFor(name) {
  return (name !== undefined && Object.hasOwn(ADAPTERS, name) ? ADAPTERS[name] : undefined) ?? NONE;
}

// @ts-check
/**
 * The relay's protocol adapters: how a session reads usage from the
 * provider's frames (plan 5.2). `open` names the session's adapter.
 *
 * Each adapter has a cheap check that picks the few frames worth parsing;
 * every other frame is forwarded untouched, never parsed. It declares its
 * usage shape: per turn, or a running total.
 *
 * The mock adapters read the smoke mock provider's frames. xAI (9b) is the
 * first provider adapter; the rest come with 9d (Gemini) and 9e (OpenAI over
 * WebSocket). A frame no adapter reads costs nothing but the connection time.
 */

/** The token counts an adapter may report: the same list the main Worker accepts (`SLICE_MEASURES`). */
export const USAGE_MEASURES = ["input_tokens", "output_tokens", "cached_input_tokens", "cache_write_tokens"];

/**
 * @typedef {import("./journal.js").UsageEvent} UsageEvent
 * @typedef {{
 *   shape: "per_turn" | "running_total",
 *   read(data: string | ArrayBuffer): UsageEvent | null,
 *   turn(data: string | ArrayBuffer): "open" | "done" | null,
 *   detached: "hold" | "end",
 *   clock?: "first_activity",
 *   client?(data: string | ArrayBuffer): "activity" | "text" | null,
 *   keepalive?(data: string | ArrayBuffer): boolean,
 * }} Adapter
 * `turn` tells when the provider starts an answer and when it is done (OpenAI's
 * `response.created` and `response.done`), so a closing session can wait for
 * the last answer's usage (plan 5.1: up to 10 s). A cheap prefix check, like `read`.
 *
 * `detached`: what the session does with the provider's frames while our SDK's
 * link is down and it may come back (plan 5.2, "Heartbeats and reconnects").
 * `"hold"` keeps them, bounded, and hands them to the client that reconnects;
 * `"end"` ends the session at once, for a protocol where a reconnect is a new
 * conversation anyway (ElevenLabs agents, 9e).
 *
 * The rest are optional, for a provider that bills by its own clock (xAI):
 * - `clock: "first_activity"`: the session's time is free until its first
 *   activity, then billed to the close (`../journal.js`, `markActive`);
 * - `client`: reads a client frame after it went to the provider. `"activity"`
 *   starts the clock; `"text"` is one text message, billed on its own;
 * - `keepalive`: a provider frame that says nothing but "still here" (xAI's
 *   `ping` every 10 s). It does not count as the provider sending, so the 90 s
 *   rule still ends a session whose client is gone (plan 5.2).
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
 * An answer opens on a frame starting with `opens` and is done on one starting
 * with `closes`.
 * @param {string} prefix
 * @param {"per_turn" | "running_total"} shape
 * @param {{ opens: string, closes: string }} turns
 * @returns {Adapter}
 */
function jsonAdapter(prefix, shape, turns) {
  return {
    shape,
    detached: "hold",
    turn(data) {
      if (typeof data !== "string") return null;
      if (data.startsWith(turns.opens)) return "open";
      if (data.startsWith(turns.closes)) return "done";
      return null;
    },
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

/** The start of a JSON frame whose first field is its `type`: the common layout, read without parsing. */
const TYPE_FIRST = '{"type":"';

/**
 * A JSON frame's top-level `type`, or null when it has none. A frame that
 * starts with its `type` is read from that prefix alone, never parsed. Any
 * other layout is parsed, so a nested `type` (an item's) is never taken for
 * the frame's: that layout is rare, and the frame is small or read once.
 * @param {string} data
 * @returns {string | null}
 */
export function typeOf(data) {
  if (data.startsWith(TYPE_FIRST)) {
    const end = data.indexOf('"', TYPE_FIRST.length);
    return end > TYPE_FIRST.length && end - TYPE_FIRST.length <= 64 ? data.slice(TYPE_FIRST.length, end) : null;
  }
  return parsedType(parsed(data));
}

/** A frame parsed, or null when it is not JSON. @param {string} data @returns {unknown} */
function parsed(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** A parsed frame's top-level `type`. @param {unknown} frame */
function parsedType(frame) {
  const type = typeof frame === "object" && frame !== null ? /** @type {{ type?: unknown }} */ (frame).type : undefined;
  return typeof type === "string" ? type : null;
}

/**
 * What one client `conversation.item.create` is billed as (xAI's speech-to-speech guide):
 * - an item with audio content (`input_audio`, `audio`) goes to the audio meter: activity;
 * - a tool result (`function_call_output`) is not billed;
 * - every other item is one text input, $0.004.
 * @param {string} data
 * @returns {"activity" | "text" | null}
 */
function itemKind(data) {
  const item = /** @type {{ item?: { type?: unknown, content?: unknown } } | null} */ (parsed(data))?.item;
  if (typeof item !== "object" || item === null) return "text";
  if (item.type === "function_call_output") return null;
  const content = Array.isArray(item.content) ? item.content : [];
  const audio = content.some((part) => typeof part === "object" && part !== null && (part.type === "input_audio" || part.type === "audio"));
  return audio ? "activity" : "text";
}

/**
 * xAI's voice API (Grok Voice, `wss://api.x.ai/v1/realtime`; T5 and T20).
 *
 * - Billed by time: the larger of the relay's clock, from the first activity
 *   to the close, and xAI's own `billable_audio_seconds` (plan 5.2 rule 3).
 *   With a microphone streamed in real time the two agree (T5, T20); with
 *   long answers asked by text, xAI bills the generated audio, far more than
 *   the clock (9c). The first activity is the first audio frame (even
 *   silence) or the first answer. The clock starts when the client's first
 *   audio frame has gone to xAI, or at xAI's first `response.created`,
 *   whichever comes first. A client's
 *   `response.create` is not the start: xAI may reject it, and its answer
 *   starts the clock when it comes (Sol, #266 round 3).
 * - Each client `conversation.item.create` is one text message, billed on
 *   top, except a tool result (`function_call_output`), which is not billed,
 *   and an item with audio content, which the clock bills (`itemKind`).
 * - `response.done` carries `billable_audio_seconds`, xAI's running total in
 *   whole seconds, kept in the journal (`markAudio`).
 * - xAI keeps the conversation while our SDK's link is down, so its frames
 *   are held for a reconnect.
 * @type {Adapter}
 */
const XAI = {
  shape: "running_total",
  detached: "hold",
  clock: "first_activity",
  turn(data) {
    if (typeof data !== "string") return null;
    const type = typeOf(data);
    if (type === "response.created") return "open";
    if (type === "response.done") return "done";
    return null;
  },
  read(data) {
    if (typeof data !== "string" || typeOf(data) !== "response.done") return null;
    try {
      const parsed = /** @type {{ event_id?: unknown, usage?: { billable_audio_seconds?: unknown } }} */ (JSON.parse(data));
      const seconds = parsed.usage?.billable_audio_seconds;
      if (typeof parsed.event_id !== "string" || parsed.event_id === "" || parsed.event_id.length > 128) return null;
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
      return { id: parsed.event_id, measures: {}, audioSeconds: seconds };
    } catch {
      return null;
    }
  },
  client(data) {
    // Binary frames are audio (xAI's `"transport": "binary"`).
    if (typeof data !== "string") return "activity";
    const type = typeOf(data);
    if (type === "input_audio_buffer.append") return "activity";
    if (type === "conversation.item.create") return itemKind(data);
    return null;
  },
  keepalive(data) {
    return typeof data === "string" && data.length < 256 && typeOf(data) === "ping";
  },
};

/** The smoke mock's answers, shaped like OpenAI's: `response.created`, then `response.done`. */
const MOCK_TURNS = { opens: '{"type":"response.created"', closes: '{"type":"response.done"' };

/** @type {Record<string, Adapter>} */
const ADAPTERS = {
  // The smoke mock's per-turn usage: `{"type":"mock.usage","event_id":…,"usage":{…}}`.
  mock: jsonAdapter('{"type":"mock.usage"', "per_turn", MOCK_TURNS),
  // A running total, as xAI reports (9b), for the journal's tests: `{"type":"mock.total",…}`.
  mock_total: jsonAdapter('{"type":"mock.total"', "running_total", MOCK_TURNS),
  // Usage inside the frame that ends the answer, as OpenAI's `response.done` carries it (9e), for the tests.
  mock_done: jsonAdapter('{"type":"response.done"', "per_turn", MOCK_TURNS),
  xai: XAI,
};

/**
 * An adapter that reads nothing: the session is metered by connection time
 * only (the wall clock meter), and never waits for an answer when it closes.
 * @type {Adapter}
 */
const NONE = { shape: "per_turn", detached: "hold", read: () => null, turn: () => null };

/** The adapter `open` named, or one that reads nothing. @param {string | undefined} name */
export function adapterFor(name) {
  return (name !== undefined && Object.hasOwn(ADAPTERS, name) ? ADAPTERS[name] : undefined) ?? NONE;
}

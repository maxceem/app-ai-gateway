// @ts-check
/**
 * The relay's protocol adapters: how a session reads usage from the
 * provider's frames (plan 5.2). `open` names the session's adapter.
 *
 * Each adapter has a cheap check that picks the few frames worth parsing;
 * every other frame is forwarded untouched, never parsed. It declares its
 * usage shape: per turn, or a running total.
 *
 * The mock adapters read the smoke mock provider's frames. xAI (9b), Gemini
 * Live (9d) and OpenAI Realtime over WebSocket (9e) are the provider adapters.
 * A frame no adapter reads costs nothing but the connection time.
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
 *   perCall?(model: string | null): CallMeter,
 * }} Adapter
 * @typedef {{
 *   see(data: string | ArrayBuffer, forwarded: boolean): string | null,
 *   settled(key: string): void,
 *   pending(): boolean,
 *   unfinished(): boolean,
 *   label(event: UsageEvent): UsageEvent,
 *   estimate(): UsageEvent | null,
 *   lock(data: string | ArrayBuffer): string | ArrayBuffer,
 * }} CallMeter
 * `perCall`, for a provider that needs to remember something about one call
 * (OpenAI Realtime, 9e): what the session says (`see`, each provider frame
 * after it was forwarded; it names an answer or a transcription the frame
 * finished, whose usage is being written), that usage written (`settled`),
 * whether anything is still to come that a closing session waits for
 * (`pending`: an answer or a transcription not finished, or one whose usage is
 * still being written), whether OpenAI left an answer or transcription without
 * its completion event (`unfinished`: cut by the end), the model of a usage event that is not the
 * session's own (`label`: input transcription), a cut answer's estimate
 * (`estimate`, the session core's hook) and the model lock on the client's
 * frames (`lock`, before each goes to the provider).
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

/** The highest audio total xAI can report that is real: a day (the gateway's bound on one slice's billed time). */
const AUDIO_SECONDS_MAX = 86_400;

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
    const type = end > TYPE_FIRST.length && end - TYPE_FIRST.length <= 64 ? data.slice(TYPE_FIRST.length, end) : null;
    // An escape in the type (`\u002e`) reads differently parsed: such a frame is parsed (Gemini Neon, #270).
    if (type === null || !type.includes("\\")) return type;
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
      const parsed = /** @type {{ usage?: { billable_audio_seconds?: unknown } }} */ (JSON.parse(data));
      const seconds = parsed.usage?.billable_audio_seconds;
      // A figure past a day is nonsense: ignored, so the session bills its clock and its slices stay
      // within what the gateway accepts. No event id is needed: only a higher total counts (`markAudio`).
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 || seconds > AUDIO_SECONDS_MAX) return null;
      return { id: "", measures: {}, audioSeconds: seconds };
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

/** A Gemini frame this size or smaller is parsed whole: control messages and usage are small. */
const GEMINI_SMALL = 4096;
/** How much of a larger frame's start and end is read to tell an answer's audio chunk apart. */
const GEMINI_HEAD = 128;
const GEMINI_TAIL = 384;
/** What an answer's audio chunk reads as: never parsed, only counted (T19: about 30 KB each, many a second). */
const GEMINI_AUDIO_CHUNK = Object.freeze({ serverContent: Object.freeze({ modelTurn: true }) });
/** A field that, near a large frame's end, means it carries more than audio, so it is parsed. */
const GEMINI_TAIL_FIELDS = /"(turnComplete|usageMetadata|interrupted|generationComplete|toolCall|goAway|sessionResumptionUpdate)"/u;
const utf8 = new TextDecoder();

/** Part of a frame as text. @param {string | ArrayBuffer} data @param {number} start @param {number} [end] */
function textOf(data, start, end) {
  if (typeof data === "string") return data.slice(start, end);
  const to = end ?? data.byteLength;
  return utf8.decode(new Uint8Array(data, start, Math.max(0, to - start)));
}

/** The last frame read and what it read as: the session object reads each frame up to three times in a row. */
let lastGemini = /** @type {{ data: string | ArrayBuffer | null, value: Record<string, any> | null }} */ ({ data: null, value: null });

/**
 * A Gemini Live message (JSON, sent in binary frames; T4, T19), or null when
 * it is not JSON. A large frame that starts as an answer's audio and has no
 * other field near its end is never parsed: it reads as `GEMINI_AUDIO_CHUNK`.
 * Every other frame is small and parsed whole.
 * @param {string | ArrayBuffer} data
 * @returns {Record<string, any> | null}
 */
export function geminiMessage(data) {
  if (lastGemini.data === data) return lastGemini.value;
  /** @type {Record<string, any> | null} */
  let value = null;
  const size = typeof data === "string" ? data.length : data.byteLength;
  if (size > GEMINI_SMALL && /"modelTurn"/u.test(textOf(data, 0, GEMINI_HEAD)) && !GEMINI_TAIL_FIELDS.test(textOf(data, size - GEMINI_TAIL))) {
    value = GEMINI_AUDIO_CHUNK;
  } else {
    try {
      const parsed = JSON.parse(textOf(data, 0));
      value = typeof parsed === "object" && parsed !== null ? parsed : null;
    } catch {
      value = null;
    }
  }
  lastGemini = { data, value };
  return value;
}

/** A token count Gemini reported, or 0. @param {unknown} value */
const tokenCount = (value) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : 0);

/**
 * One side's tokens by modality, from Gemini's `*TokensDetails`. Returns null
 * when the side has no breakdown: then all its tokens are "unknown", billed
 * at the model's highest rate. Text is what the breakdown leaves (T19 priced
 * it so), at the side's base rate.
 * @param {unknown} details
 */
function byModality(details) {
  if (!Array.isArray(details) || details.length === 0) return null;
  /** @type {Record<string, number>} */
  const counts = { AUDIO: 0, IMAGE: 0, VIDEO: 0 };
  for (const part of details) {
    const modality = typeof part === "object" && part !== null ? part.modality : undefined;
    if (typeof modality === "string" && Object.hasOwn(counts, modality)) counts[modality] = (counts[modality] ?? 0) + tokenCount(part.tokenCount);
  }
  return counts;
}

/**
 * Gemini's `usageMetadata`, one turn's usage (T4: per turn, with `turnComplete`),
 * as the slice's measures. The prompt (with any tool-use prompt) is input, its
 * cached part cached input; the answer and the thinking are output. Each side
 * is split by modality, in the names a charge keeps them under
 * (`src/usage/measures.ts`): `<side>_split` says the side was broken down,
 * `<side>_<modality>_tokens` its audio, image and video shares, and
 * `<side>_unknown_tokens` what no breakdown covered.
 * @param {Record<string, unknown>} usage
 * @returns {Record<string, number>}
 */
export function geminiMeasures(usage) {
  const prompt = tokenCount(usage.promptTokenCount) + tokenCount(usage.toolUsePromptTokenCount);
  const cached = Math.min(prompt, tokenCount(usage.cachedContentTokenCount));
  const answer = tokenCount(usage.responseTokenCount ?? usage.candidatesTokenCount);
  const output = answer + tokenCount(usage.thoughtsTokenCount);
  /** @type {Record<string, number>} */
  const measures = { input_tokens: prompt - cached, output_tokens: output, input_split: 1, output_split: 1 };
  if (cached > 0) measures.cached_input_tokens = cached;
  const input = byModality(usage.promptTokensDetails);
  if (input === null) measures.input_unknown_tokens = prompt;
  else {
    measures.input_audio_tokens = input.AUDIO ?? 0;
    measures.input_image_tokens = input.IMAGE ?? 0;
    measures.input_video_tokens = input.VIDEO ?? 0;
  }
  // The thinking is text; only the answer itself is broken down.
  const out = byModality(usage.responseTokensDetails ?? usage.candidatesTokensDetails);
  if (out === null) measures.output_unknown_tokens = answer;
  else measures.output_audio_tokens = out.AUDIO ?? 0;
  for (const [name, value] of Object.entries(measures)) if (value === 0) delete measures[name];
  return measures;
}

/**
 * Gemini Live (T4, T19): its JSON comes in binary frames, decoded in order
 * (`binaryType = "arraybuffer"` makes each frame's bytes arrive at once).
 * Usage is per turn, in `usageMetadata` beside `turnComplete`. An answer
 * opens with its first `modelTurn` (or a tool call) and is done at
 * `turnComplete`. The upstream connection, its resumption and its swaps are
 * the relay's (`./gemini.js`). Gemini keeps the conversation while our SDK's
 * link is down, so its frames are held for a reconnect.
 * @type {Adapter}
 */
const GEMINI = {
  shape: "per_turn",
  detached: "hold",
  turn(data) {
    const message = geminiMessage(data);
    if (message?.serverContent?.turnComplete === true) return "done";
    if (message?.serverContent?.modelTurn !== undefined || message?.toolCall !== undefined) return "open";
    return null;
  },
  read(data) {
    const usage = geminiMessage(data)?.usageMetadata;
    if (typeof usage !== "object" || usage === null) return null;
    // Gemini's usage has no id, and a turn's usage comes once: every event is new.
    return { id: crypto.randomUUID(), measures: geminiMeasures(usage) };
  },
};

/** A count OpenAI reported at `path` under `record`, or 0. @param {unknown} record @param {string[]} path */
function countAt(record, ...path) {
  let value = record;
  for (const key of path) value = typeof value === "object" && value !== null ? /** @type {Record<string, unknown>} */ (value)[key] : undefined;
  return tokenCount(value);
}

/**
 * One answer's usage, from `response.done`'s `response.usage` (T8, T9, T21),
 * as the slice's measures. `input_tokens` holds the cached ones;
 * `input_token_details` splits the whole prompt by modality, and its
 * `cached_tokens_details` the cached part.
 * - Input: the cached tokens bill at the cached rate, cached audio at its own
 *   (`cached_input_audio`); audio is counted whole, with its cached share as
 *   that variant. A cached image token bills as an uncached one: the price list
 *   has no cached image rate, and a guess must bill high, never low.
 * - Output: audio at its own rate, the rest (text, reasoning) at the text rate.
 * - Tokens no breakdown covers, a side with none or the rest of one, are
 *   `unknown`: billed at the model's highest rate, never as text (Sol, #270).
 *   So are cached tokens OpenAI doesn't split by modality: the cache discount
 *   applies only where the cached modality is known, and the price is marked
 *   an estimate.
 * @param {Record<string, unknown>} usage
 * @returns {Record<string, number>}
 */
export function openAiMeasures(usage) {
  const input = tokenCount(usage.input_tokens);
  const output = tokenCount(usage.output_tokens);
  const details = usage.input_token_details;
  // The cache discount applies only where the cached modality is known: text and audio. Cached images
  // bill as uncached; cached tokens with no modality bill as unknown, at the dearest rate, as an estimate.
  const cachedText = countAt(details, "cached_tokens_details", "text_tokens");
  const cachedAudio = countAt(details, "cached_tokens_details", "audio_tokens");
  const cachedImage = countAt(details, "cached_tokens_details", "image_tokens");
  const cachedAll = Math.min(input, countAt(details, "cached_tokens"));
  const cached = Math.min(cachedAll, cachedText + cachedAudio);
  const unexplained = Math.max(0, cachedAll - cachedText - cachedAudio - cachedImage);
  /** @type {Record<string, number>} */
  const measures = { input_tokens: input - cached, output_tokens: output, cached_input_tokens: cached, input_split: 1, output_split: 1 };
  const audio = countAt(details, "audio_tokens");
  const image = countAt(details, "image_tokens");
  measures.input_audio_tokens = audio;
  measures.input_image_tokens = image;
  measures.cached_input_audio_tokens = Math.min(cached, cachedAudio);
  // What the split doesn't account for, of the uncached input: billed at the highest rate.
  const accounted = countAt(details, "text_tokens") + audio + image;
  measures.input_unknown_tokens = Math.min(input - cached, Math.max(0, input - accounted) + unexplained);
  // Cached tokens whose modality is unknown are a guess: the price is marked an estimate.
  if (unexplained > 0) measures.estimated_tokens = unexplained;
  const out = usage.output_token_details;
  const outAudio = countAt(out, "audio_tokens");
  measures.output_audio_tokens = outAudio;
  measures.output_unknown_tokens = Math.max(0, output - countAt(out, "text_tokens") - outAudio);
  for (const [name, value] of Object.entries(measures)) if (value === 0 && !name.endsWith("_split")) delete measures[name];
  return measures;
}

/**
 * One input transcription's usage (`conversation.item.input_audio_transcription.completed`),
 * as measures of its own: its model is not the session's, so it is booked apart
 * (plan, the provider table). Token models report tokens; time-priced ones
 * `{"type": "duration", "seconds"}`.
 * @param {Record<string, unknown>} usage
 * @returns {Record<string, number>}
 */
export function transcriptionMeasures(usage) {
  /** @type {Record<string, number>} */
  const measures = {};
  const seconds = usage.seconds;
  if (usage.type === "duration" && typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 && seconds <= 86_400) {
    measures.transcription_audio_ms = Math.ceil(seconds * 1000);
  }
  const input = tokenCount(usage.input_tokens);
  const output = tokenCount(usage.output_tokens);
  if (input > 0) measures.transcription_input_tokens = input;
  if (output > 0) measures.transcription_output_tokens = output;
  const audio = Math.min(input, countAt(usage.input_token_details, "audio_tokens"));
  if (audio > 0) measures.transcription_input_audio_tokens = audio;
  return measures;
}

/** Frames whose usage the OpenAI adapter reads: few and small, never an audio delta. */
const OPENAI_USAGE_TYPES = new Set(["response.done", "conversation.item.input_audio_transcription.completed"]);

/**
 * OpenAI Realtime over WebSocket (9e). Usage is per answer, in `response.done`
 * (answers cancelled or cut short report theirs too), and per input
 * transcription, in its own event. Its answers and transcriptions in progress
 * are the call's meter's (`perCall`). OpenAI keeps the conversation while our
 * SDK's link is down, so its frames are held for a reconnect.
 * @type {Adapter}
 */
const OPENAI = {
  shape: "per_turn",
  detached: "hold",
  // The call's meter tells a closing session what is still open (`perCall`): its answers and transcriptions.
  turn: () => null,
  read(data) {
    if (typeof data !== "string" || !OPENAI_USAGE_TYPES.has(typeOf(data) ?? "")) return null;
    const frame = /** @type {{ type?: unknown, event_id?: unknown, response?: { id?: unknown, usage?: unknown }, usage?: unknown } | null} */ (parsed(data));
    if (frame === null) return null;
    if (frame.type === "response.done") {
      const usage = frame.response?.usage;
      if (typeof usage !== "object" || usage === null) return null;
      // The response's id: each answer has one `response.done`, so a repeat is skipped.
      const id = typeof frame.response?.id === "string" && frame.response.id !== "" ? frame.response.id : crypto.randomUUID();
      return { id: id.slice(0, 128), measures: openAiMeasures(/** @type {Record<string, unknown>} */ (usage)) };
    }
    const usage = frame.usage;
    if (typeof usage !== "object" || usage === null) return null;
    const measures = transcriptionMeasures(/** @type {Record<string, unknown>} */ (usage));
    if (Object.keys(measures).length === 0) return null;
    const id = typeof frame.event_id === "string" && frame.event_id !== "" ? frame.event_id : crypto.randomUUID();
    return { id: id.slice(0, 128), measures };
  },
  perCall: (model) => openAiCall(model),
};

/**
 * Characters of a forwarded audio delta per estimated output token: OpenAI's
 * audio is 20 tokens a second (T21: 19.98–20.01 in every call). PCM at 24 kHz
 * is 48,000 bytes a second, 64,000 in base64; G.711 is 8,000, 10,667 in base64.
 * Each delta's JSON around the audio is counted too, so the guess bills high.
 */
const OPENAI_CHARS_PER_TOKEN = { pcm: 3_200, g711: 533 };
const OPENAI_AUDIO_DELTAS = new Set(["response.output_audio.delta", "response.audio.delta"]);

/**
 * The session's output audio format, as OpenAI states it in `session.created`
 * and `session.updated`: G.711 (`audio/pcmu`, `audio/pcma`, or the older
 * `g711_ulaw` and `g711_alaw`), else PCM.
 * @param {Record<string, any>} session
 * @returns {"pcm" | "g711" | null}
 */
function outputFormat(session) {
  const format = session.audio?.output?.format?.type ?? session.output_audio_format;
  if (typeof format !== "string") return null;
  return /pcmu|pcma|g711/u.test(format) ? "g711" : "pcm";
}

/**
 * The session's input transcription model, as OpenAI states it; null when
 * transcription is off, undefined when the session doesn't say.
 * @param {Record<string, any>} session
 * @returns {string | null | undefined}
 */
function transcriptionModel(session) {
  const transcription = session.audio?.input !== undefined ? session.audio.input.transcription : session.input_audio_transcription;
  if (transcription === undefined) return undefined;
  const model = transcription?.model;
  if (model === undefined || model === null) return transcription === null ? null : "unknown";
  // Only a name the gateway takes as a model: anything else is booked as `unknown`, never sent as it is.
  return typeof model === "string" && MODEL_NAME.test(model) ? model : "unknown";
}

/** A model name the gateway takes on a slice (`src/relay/checkpoint.ts`): short, with no spaces or controls. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/u;

/** How many transcriptions or finished events a call remembers at once: far above what one session has open. */
const OPENAI_OPEN_MAX = 64;

/**
 * One OpenAI call's memory (`CallMeter`), from OpenAI's own events:
 * - its output audio format and its input transcription model
 *   (`session.created`, `session.updated`);
 * - how many answers are open, and the audio forwarded while any is, for an
 *   estimate if the session's own end cuts them. An out-of-band answer's audio
 *   counts too, and the estimate uses the session's format: a guess that may
 *   bill high, never low, marked an estimate;
 * - the committed audio items whose transcription is still to come, and each
 *   finished answer or transcription until its usage is written, which a
 *   closing session waits for.
 * @param {string | null} model the session's locked model
 * @returns {CallMeter}
 */
function openAiCall(model) {
  /** @type {"pcm" | "g711"} */
  let format = "pcm";
  /** @type {string | null} */
  let transcribedBy = null;
  let open = 0;
  let chars = 0;
  let finishedCount = 0;
  /** @type {Set<string>} Committed audio items whose transcription is still to come. */
  const pending = new Set();
  /** @type {Set<string>} Answers and transcriptions that finished, whose usage is still being written. */
  const writing = new Set();
  /** A finished answer or transcription: waited for until its usage is written (`settled`). @param {string} key */
  const finished = (key) => {
    if (writing.size >= OPENAI_OPEN_MAX) writing.delete(writing.values().next().value ?? "");
    writing.add(key);
    return key;
  };
  /** The item a small frame names. @param {string} data */
  const itemOf = (data) => {
    const item = /** @type {{ item_id?: unknown } | null} */ (parsed(data))?.item_id;
    return typeof item === "string" ? item : "";
  };
  return {
    see(data, forwarded) {
      if (typeof data !== "string") return null;
      const type = typeOf(data);
      if (type === null) return null;
      if (OPENAI_AUDIO_DELTAS.has(type)) {
        // Only audio that reached the client, or waits for it, is estimated if an answer is cut.
        if (forwarded && open > 0) chars += data.length;
      } else if (type === "response.created") {
        open += 1;
      } else if (type === "response.done") {
        open = Math.max(0, open - 1);
        if (open === 0) chars = 0;
        finishedCount += 1;
        return finished(`answer:${finishedCount}`);
      } else if (type === "session.created" || type === "session.updated") {
        const session = /** @type {{ session?: Record<string, any> } | null} */ (parsed(data))?.session;
        if (typeof session !== "object" || session === null) return null;
        format = outputFormat(session) ?? format;
        const named = transcriptionModel(session);
        if (named !== undefined) transcribedBy = named;
      } else if (type === "input_audio_buffer.committed") {
        const item = itemOf(data);
        if (transcribedBy !== null && item !== "" && pending.size < OPENAI_OPEN_MAX) pending.add(item);
      } else if (OPENAI_TRANSCRIPTION_ENDS.has(type)) {
        // A transcription completed or failed, or its item was deleted: it is no longer waited for.
        const item = itemOf(data);
        if (pending.delete(item)) return finished(`item:${item}`);
      }
      return null;
    },
    settled(key) {
      writing.delete(key);
    },
    pending() {
      return open > 0 || pending.size > 0 || writing.size > 0;
    },
    unfinished() {
      return open > 0 || pending.size > 0;
    },
    label(event) {
      const transcription = Object.keys(event.measures).some((name) => name.startsWith("transcription_"));
      return transcription ? { ...event, model: transcribedBy ?? "unknown" } : event;
    },
    estimate() {
      if (open === 0) return null;
      const tokens = Math.ceil(chars / OPENAI_CHARS_PER_TOKEN[format]);
      open = 0;
      chars = 0;
      if (tokens === 0) return null;
      return { id: crypto.randomUUID(), measures: { output_tokens: tokens, output_split: 1, output_audio_tokens: tokens, estimated_tokens: tokens } };
    },
    lock(data) {
      // A client's `session.update` may not move the session to another model: the session's
      // stays (plan: relayed mode locks the model). Anything else goes as it is.
      if (model === null || typeof data !== "string" || plainNotUpdate(data)) return data;
      // Read whole, as OpenAI reads it (plan: settings messages are always fully parsed).
      const frame = /** @type {{ type?: unknown, session?: unknown } | null} */ (parsed(data));
      if (typeof frame !== "object" || frame === null || !Object.hasOwn(frame, "session")) return data;
      const session = frame.session;
      if (frame.type === "session.update" && typeof session === "object" && session !== null && Object.hasOwn(session, "model")) {
        return JSON.stringify({ ...frame, session: { ...session, model } });
      }
      // Any frame with a session is written again as it was read: a repeated key in the text, which
      // OpenAI might read differently, is gone (Gemini Neon, #270 round 2).
      return JSON.stringify(frame);
    },
  };
}

/**
 * Whether a client frame is surely not a `session.update`, without parsing it: it starts with
 * its `type`, which is another, and has no escape and no second `"type"` key that a parse could
 * read differently. An audio append, the frame sent most, is never parsed (Gemini Neon, #270).
 * @param {string} data
 */
function plainNotUpdate(data) {
  if (!data.startsWith(TYPE_FIRST) || data.includes("\\")) return false;
  const end = data.indexOf('"', TYPE_FIRST.length);
  if (end === -1 || data.slice(TYPE_FIRST.length, end) === "session.update") return false;
  return data.indexOf('"type"', end) === -1;
}

/** The events that end the wait for an item's transcription. */
const OPENAI_TRANSCRIPTION_ENDS = new Set([
  "conversation.item.input_audio_transcription.completed",
  "conversation.item.input_audio_transcription.failed",
  "conversation.item.deleted",
]);

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
  gemini: GEMINI,
  openai: OPENAI,
};

/**
 * An adapter that reads nothing: the session is metered by connection time
 * only (the wall clock meter), and never waits for an answer when it closes.
 * @type {Adapter}
 */
const NONE = { shape: "per_turn", detached: "hold", read: () => null, turn: () => null };

/**
 * Whether this relay knows the adapter `open` named. A newer gateway can name one an older relay
 * lacks (the gateway is deployed first): the relay then refuses the session (`./start.js`).
 * @param {string} name
 */
export function knownAdapter(name) {
  return Object.hasOwn(ADAPTERS, name);
}

/** The adapter `open` named, or one that reads nothing. @param {string | undefined} name */
export function adapterFor(name) {
  return (name !== undefined && Object.hasOwn(ADAPTERS, name) ? ADAPTERS[name] : undefined) ?? NONE;
}

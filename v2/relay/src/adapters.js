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
 * Live (9d), OpenAI Realtime over WebSocket (9e), GPT-Live (9g), and
 * ElevenLabs' and Deepgram's streaming voice (10a) and ElevenLabs agents (11a) are the provider adapters.
 * `generic` (10b) is for a provider the gateway does not know: it reads no
 * frame. A frame no adapter reads costs nothing but the connection time.
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
 *   client?(data: string | ArrayBuffer, state?: Record<string, unknown>): "activity" | "text" | { counts: Record<string, number> } | null,
 *   keepalive?(data: string | ArrayBuffer): boolean,
 *   perCall?(model: string | null, settings?: { backend?: Backend }): CallMeter,
 *   callIdHeader?: string,
 *   lock?(data: string | ArrayBuffer, session?: { userId: string | null }): string | ArrayBuffer | null | { refused: string },
 * }} Adapter
 * @typedef {{ models: readonly string[], tools: readonly string[] }} Backend
 * What a session's backend may use (GPT-Live, 9g), as `open` says: the models and the tool kinds.
 * @typedef {{
 *   see(data: string | ArrayBuffer, forwarded: boolean): string | null,
 *   settled(key: string): void,
 *   pending(): boolean,
 *   unfinished(): boolean,
 *   label(event: UsageEvent): UsageEvent,
 *   estimate(): UsageEvent | null,
 *   lock(data: string | ArrayBuffer): string | ArrayBuffer | { refused: string },
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
 * frames (`lock`, before each goes to the provider). `lock` may refuse a frame
 * (`{ refused: code }`): the session then ends, and the client gets `1008` with the code (GPT-Live's
 * backend rules, 9g).
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
 *   `{ counts }` adds counts the provider bills from the client's frames
 *   (ElevenLabs' characters, 10a). `state` is the session's own, in memory, for
 *   what one frame says about the later ones;
 * - `keepalive`: a provider frame that says nothing but "still here" (xAI's
 *   `ping` every 10 s). It does not count as the provider sending, so the 90 s
 *   rule still ends a session whose client is gone (plan 5.2).
 * - `callIdHeader`: the provider's answer header that names the call (Deepgram's
 *   `dg-request-id`), stored as the session's provider call id, for a lookup after it ends.
 * - `lock`: a client frame as it goes to the provider, for a provider that needs nothing about the call
 *   remembered (ElevenLabs): the frame, changed or not, null to drop it, or `{ refused: code }` to end the
 *   session, as a call's meter may (ElevenLabs agents' overrides, 11a). `session.userId` is the end user's id
 *   as the provider gets it, from the ticket (`providerUserId`), or null: the gateway decided it.
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

/**
 * A provider's running total of the audio it bills (xAI's `billable_audio_seconds`, GPT-Live's voice
 * seconds) as a usage event, or null when it is no real figure. A figure past a day is nonsense: ignored,
 * so the session bills its clock and its slices stay within what the gateway accepts. No event id is
 * needed: only a higher total counts (`markAudio`).
 * @param {unknown} seconds
 * @returns {UsageEvent | null}
 */
function audioTotal(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 || seconds > AUDIO_SECONDS_MAX) return null;
  return { id: "", measures: {}, audioSeconds: seconds };
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
      return audioTotal(parsed.usage?.billable_audio_seconds);
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
      if (model === null || typeof data !== "string") return data;
      // Read whole, as OpenAI reads it (plan: settings messages are always fully parsed).
      const read = settingsFrame(data, OPENAI_SETTINGS);
      if (read.kind !== "frame" || !Object.hasOwn(read.frame, "session")) return data;
      const { frame } = read;
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

/** OpenAI Realtime's client event that carries settings. */
const OPENAI_SETTINGS = new Set(["session.update"]);

/**
 * Whether a client frame is surely none of `types`, without parsing it: it starts with its `type`,
 * which is another, and has no escape and no second `"type"` key that a parse could read differently.
 * @param {string} data
 * @param {ReadonlySet<string>} types
 */
function plainNotOneOf(data, types) {
  if (!data.startsWith(TYPE_FIRST) || data.includes("\\")) return false;
  const end = data.indexOf('"', TYPE_FIRST.length);
  if (end === -1 || types.has(data.slice(TYPE_FIRST.length, end))) return false;
  return data.indexOf('"type"', end) === -1;
}

/**
 * GPT-Live (9g; T21), over WebSocket at `wss://api.openai.com/v1/live/sessions`.
 *
 * - Billed by the minute at the larger of the relay's clock and OpenAI's own voice seconds, as xAI is
 *   (plan 5.2 rule 3). The clock starts at `session.started`, where OpenAI's does. OpenAI's seconds come
 *   every 15 s in `session.usage.updated`, a running total ("do not add them"), and once more in
 *   `session.closed`. A session the relay ends itself never gets `session.closed`: its clock bills the
 *   last seconds, never less than OpenAI.
 * - Each backend model call (a Responses call GPT-Live makes) is billed at its own model's price:
 *   the usage in the nested `response.completed` (or `failed`, `incomplete`) of a `response.event`, by
 *   the model it names, once per response id (`backendMeasures`).
 * - GPT-Live sends audio all the time, silence too, and puts `event_id` before `type` in its own
 *   events, so a frame is picked by its head only (`GPT_LIVE_HEAD`); every other frame is never parsed.
 * - The client's frames are locked by the call's meter (`gptLiveCall`): the model, and what the
 *   backend may use.
 * - A restart ends the session: OpenAI drops it when its WebSocket goes, and it can't be rejoined. The
 *   time since the journal's last durable write is an "unknown cost" gap (plan 9g): about 15 s at most
 *   while OpenAI's seconds grow, longer when nothing new came.
 * @type {Adapter}
 */
const GPT_LIVE = {
  shape: "per_turn",
  detached: "hold",
  clock: "first_activity",
  // `session.started` starts the clock (`../index.js`, an "open" is activity). The closing wait is the
  // call's meter's: it follows the backend calls in progress (`gptLiveCall`).
  turn(data) {
    return typeof data === "string" && GPT_LIVE_STARTED.test(data.slice(0, GPT_LIVE_HEAD)) ? "open" : null;
  },
  read(data) {
    if (typeof data !== "string") return null;
    const head = data.slice(0, GPT_LIVE_HEAD);
    if (GPT_LIVE_USAGE.test(head)) return audioTotal(/** @type {{ usage?: { seconds?: unknown } } | null} */ (parsed(data))?.usage?.seconds);
    if (!GPT_LIVE_BACKEND.test(head) || !GPT_LIVE_BACKEND_STEP.test(data)) return null;
    const event = /** @type {{ event?: { type?: unknown, response?: { id?: unknown, model?: unknown, usage?: unknown } } } | null} */ (parsed(data))?.event;
    if (typeof event?.type !== "string" || !BACKEND_ENDS.has(event.type)) return null;
    const usage = event.response?.usage;
    if (typeof usage !== "object" || usage === null) return null;
    const measures = backendMeasures(/** @type {Record<string, unknown>} */ (usage));
    if (Object.keys(measures).length === 0) return null;
    const named = event.response?.model;
    // Only a name the gateway takes as a model: anything else is booked as `unknown`, for the sweep.
    const model = typeof named === "string" && MODEL_NAME.test(named) ? named : "unknown";
    // The response's id: each backend call ends once, so a repeat is skipped.
    const id = typeof event.response?.id === "string" && event.response.id !== "" ? event.response.id : crypto.randomUUID();
    return { id: id.slice(0, 128), model, measures };
  },
  perCall: (model, settings) => gptLiveCall(model, settings?.backend),
};

/** How much of a GPT-Live frame is looked at to pick it: its `event_id` and `type` (T21: 120 characters caught every event). */
const GPT_LIVE_HEAD = 192;
const GPT_LIVE_STARTED = /"type"\s*:\s*"session\.started"/u;
const GPT_LIVE_USAGE = /"type"\s*:\s*"session\.(usage\.updated|closed)"/u;
const GPT_LIVE_BACKEND = /"type"\s*:\s*"response\.event"/u;
/** A backend call that started or ended: only then is a `response.event` read (its usage, or the call's progress). */
const GPT_LIVE_BACKEND_STEP = /"type"\s*:\s*"response\.(created|completed|failed|incomplete)"/u;
const BACKEND_ENDS = new Set(["response.completed", "response.failed", "response.incomplete"]);

/**
 * One backend call's usage, as Responses reports it (T21), as the slice's backend measures
 * (`src/relay/checkpoint.ts`, `SLICE_BACKEND`): the whole input, with its cached and cache-written
 * shares, a 12-hour write apart, and the output with its reasoning inside.
 * @param {Record<string, unknown>} usage
 * @returns {Record<string, number>}
 */
export function backendMeasures(usage) {
  const input = tokenCount(usage.input_tokens);
  const details = usage.input_tokens_details;
  /** @type {Record<string, number>} */
  const measures = {
    backend_input_tokens: input,
    backend_cached_tokens: Math.min(input, countAt(details, "cached_tokens")),
    backend_cache_write_tokens: Math.min(input, countAt(details, "cache_write_tokens")),
    backend_cache_write_12h_tokens: Math.min(input, countAt(details, "cache_write_tokens_details", "ttl_12h_tokens")),
    backend_output_tokens: tokenCount(usage.output_tokens),
  };
  for (const [name, value] of Object.entries(measures)) if (value === 0) delete measures[name];
  return measures;
}

/** A plain object: not null, not a list. @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Why a client's settings may not reach GPT-Live, or null when they may (plan, "GPT-Live backend rules";
 * owner, 2026-11-18). OpenAI bills what the backend does, so:
 * - the delegation: none, the app's own (`client`), or `responses`, whose model must be one the app may
 *   call, priced (`open`'s list), named in every frame that sets `responses`, the start's or an update's
 *   alike (Gemini Neon, #272 round 2: an update may turn the backend on), with tools only of the kinds
 *   allowed (function tools: a hosted tool's fees are not in the usage, T21) and no `service_tier` but the
 *   standard one (the relay books backend calls at the standard rate). Anything else, `decisions` above
 *   all, whose billing was never checked, is refused. A frame that sets no delegation is not checked;
 * - transcript `triggers`, which run Decisions, unlocked and unbilled (Sol, Fable, #272): none.
 * @param {Record<string, unknown>} session
 * @param {Set<string>} models
 * @param {Set<string>} tools
 * @returns {string | null}
 */
function settingsProblem(session, models, tools) {
  const triggers = session.triggers;
  if (triggers !== undefined && triggers !== null && !(Array.isArray(triggers) && triggers.length === 0)) return "triggers_not_allowed";
  const delegation = session.delegation;
  if (delegation === undefined || delegation === null) return null;
  if (!isObject(delegation) || (delegation.type !== "client" && delegation.type !== "responses")) return "delegation_not_allowed";
  if (delegation.type === "client") return null;
  const responses = delegation.responses;
  if (!isObject(responses) || typeof responses.model !== "string" || !models.has(responses.model)) return "backend_model_not_allowed";
  const tier = responses.service_tier;
  if (tier !== undefined && tier !== null && tier !== "auto" && tier !== "default") return "backend_tier_not_allowed";
  const kindAllowed = (/** @type {unknown} */ tool) => isObject(tool) && typeof tool.type === "string" && tools.has(tool.type);
  if (Object.hasOwn(responses, "tools") && responses.tools !== null && (!Array.isArray(responses.tools) || !responses.tools.every(kindAllowed))) {
    return "backend_tool_not_allowed";
  }
  return null;
}

/**
 * GPT-Live's settings as sent on: the session's model at the start, and the backend's tier pinned to the
 * standard one in every frame that sets `responses`, since `auto` or none may run at Fast, which OpenAI
 * bills at twice the rate (Sol, #272 round 2; Gemini Neon, round 2).
 * @param {Record<string, unknown>} session
 * @param {boolean} start
 * @param {string | null} model
 */
function lockedSettings(session, start, model) {
  /** @type {Record<string, unknown>} */
  const locked = { ...session };
  if (model !== null && (start || Object.hasOwn(session, "model"))) locked.model = model;
  const delegation = session.delegation;
  if (isObject(delegation) && delegation.type === "responses" && isObject(delegation.responses)) {
    locked.delegation = { ...delegation, responses: { ...delegation.responses, service_tier: "default" } };
  }
  return locked;
}

/**
 * A client frame as a settings lock reads it: `plain` when it is surely none of `types` and goes as it is
 * (never parsed: an audio append, the frame sent most); else read whole, as the provider reads it, or
 * `invalid` when it is not a JSON object.
 * @param {string} data
 * @param {ReadonlySet<string>} types
 * @returns {{ kind: "plain" } | { kind: "invalid" } | { kind: "frame", frame: Record<string, unknown> }}
 */
function settingsFrame(data, types) {
  if (plainNotOneOf(data, types)) return { kind: "plain" };
  const frame = parsed(data);
  return isObject(frame) ? { kind: "frame", frame } : { kind: "invalid" };
}

/**
 * One GPT-Live call's meter (`CallMeter`):
 * - The lock on the client's frames. Every frame that can carry settings (`session.start`,
 *   `session.update`, or any with a top-level `session`) is read whole, its settings checked
 *   (`settingsProblem`) and locked (`lockedSettings`), and sent written again as it was read, so a
 *   repeated key can't be read another way by OpenAI. Other frames, an audio append above all, go as they
 *   are, never parsed. A frame that had to be read whole and isn't a JSON object is refused, and so is a
 *   binary frame: GPT-Live's events are JSON text, and either would pass unread. OpenAI itself refuses any
 *   first frame but `session.start`.
 * - The backend calls in progress, from their nested `response.created` to their end, and each ended
 *   one until its usage is written: a closing session waits for them, and one its end cuts marks the
 *   final slice partial (Sol, #272 round 1). No estimate: a backend call's cost is unknown until it ends.
 * @param {string | null} model the session's locked model
 * @param {Backend | undefined} backend what the backend may use
 * @returns {CallMeter}
 */
function gptLiveCall(model, backend) {
  const models = new Set(backend?.models ?? []);
  const tools = new Set(backend?.tools ?? []);
  /** @type {Set<string>} Backend calls in progress, by response id. */
  const open = new Set();
  /** @type {Set<string>} Backend calls that ended, whose usage is still being written. */
  const writing = new Set();
  return {
    see(data) {
      if (typeof data !== "string" || !GPT_LIVE_BACKEND.test(data.slice(0, GPT_LIVE_HEAD)) || !GPT_LIVE_BACKEND_STEP.test(data)) return null;
      const event = /** @type {{ event?: { type?: unknown, response?: { id?: unknown } } } | null} */ (parsed(data))?.event;
      const id = event?.response?.id;
      if (typeof id !== "string" || id === "") return null;
      if (event?.type === "response.created") {
        if (open.size < OPENAI_OPEN_MAX) open.add(id);
        return null;
      }
      if (typeof event?.type !== "string" || !BACKEND_ENDS.has(event.type)) return null;
      open.delete(id);
      if (writing.size >= OPENAI_OPEN_MAX) writing.delete(writing.values().next().value ?? "");
      writing.add(id);
      return id;
    },
    settled(key) {
      writing.delete(key);
    },
    pending: () => open.size > 0 || writing.size > 0,
    unfinished: () => open.size > 0,
    // OpenAI reports the dated snapshot it ran (`gpt-4.1-2025-04-14`), where the app named, and the price
    // list holds, the alias: a backend call is booked under the alias it was allowed as (Gemini Neon, #272).
    label(event) {
      const named = event.model;
      if (named === undefined || models.has(named)) return event;
      const alias = named.replace(SNAPSHOT_DATE, "");
      return alias !== named && models.has(alias) ? { ...event, model: alias } : event;
    },
    estimate: () => null,
    lock(data) {
      if (typeof data !== "string") return { refused: "binary_not_supported" };
      const read = settingsFrame(data, GPT_LIVE_SETTINGS);
      if (read.kind === "plain") return data;
      if (read.kind === "invalid") return { refused: "invalid_frame" };
      const { frame } = read;
      if (!Object.hasOwn(frame, "session")) return data;
      const session = frame.session;
      if (!isObject(session)) return JSON.stringify(frame);
      const start = frame.type === "session.start";
      const problem = settingsProblem(session, models, tools);
      if (problem !== null) return { refused: problem };
      return JSON.stringify({ ...frame, session: lockedSettings(session, start, model) });
    },
  };
}

/** A dated snapshot's date at the end of a model's name: `-2025-04-14`. */
const SNAPSHOT_DATE = /-\d{4}-\d{2}-\d{2}$/u;

/** The GPT-Live client events that carry settings: read whole, always. */
const GPT_LIVE_SETTINGS = new Set(["session.start", "session.update"]);

/** The events that end the wait for an item's transcription. */
const OPENAI_TRANSCRIPTION_ENDS = new Set([
  "conversation.item.input_audio_transcription.completed",
  "conversation.item.input_audio_transcription.failed",
  "conversation.item.deleted",
]);

/**
 * ElevenLabs streaming text to speech (10a), over WebSocket at
 * `v1/text-to-speech/{voice_id}/stream-input`.
 *
 * - ElevenLabs bills the text it is sent, per character, so the session is billed on the client's text
 *   (plan 5.1): each client frame's `text`, after it went to ElevenLabs, in code points, as a call's text
 *   is counted. Text that is only white space counts nothing: the opening `" "` and the closing `""`.
 * - The model and the voice are in the address the session was sealed for (`model_id`, the path), so no
 *   frame can change them. Everything else goes as it is.
 * - Pronunciation dictionaries may change the billed characters (as on a call, `inDoubtWhen`): once a
 *   frame names one, every later character is an estimate too, and the slice is priced as one.
 * - Its answers (audio, `isFinal`) are never read: nothing in them is billed.
 * - A client's own credentials in a message (the first message may carry `xi-api-key` or `authorization`)
 *   are removed before it goes on: the session's key is the only one. Its messages are JSON text, so a
 *   binary frame, which would go unchecked and unbilled, is dropped (`withoutCredentials`).
 * @type {Adapter}
 */
const ELEVENLABS_TTS = {
  shape: "per_turn",
  detached: "hold",
  read: () => null,
  turn: () => null,
  lock: (data) => withoutCredentials(data),
  client(data, state = {}) {
    if (typeof data !== "string") return null;
    const frame = parsed(data);
    if (!isObject(frame)) return null;
    const dictionaries = frame.pronunciation_dictionary_locators;
    if (Array.isArray(dictionaries) && dictionaries.length > 0) state.inDoubt = true;
    const text = frame.text;
    if (typeof text !== "string" || text.trim() === "") return null;
    const characters = [...text].length;
    /** @type {Record<string, number>} */
    const counts = { characters };
    if (state.inDoubt === true) counts.estimated_characters = characters;
    return { counts };
  },
};

/**
 * The credential fields ElevenLabs reads in a client's first message: its `stream-input` reference names
 * `xi-api-key` and `authorization`, and its first-message example spells the key `xi_api_key` (Sol, #273 round 3).
 */
const ELEVENLABS_CREDENTIALS = ["xi-api-key", "xi_api_key", "authorization"];

/**
 * An ElevenLabs client message as it goes on: a binary frame dropped (null), since its messages are JSON
 * text; a JSON one without its credential fields (`ELEVENLABS_CREDENTIALS`), written again whole so a
 * repeated key can't be read another way; any other text as it is. Its text is parsed, as ElevenLabs reads
 * it, so an escaped name is caught too.
 * @param {string | ArrayBuffer} data
 * @returns {string | null}
 */
export function withoutCredentials(data) {
  if (typeof data !== "string") return null;
  const frame = parsed(data);
  if (!isObject(frame) || !ELEVENLABS_CREDENTIALS.some((name) => Object.hasOwn(frame, name))) return data;
  for (const name of ELEVENLABS_CREDENTIALS) delete frame[name];
  return JSON.stringify(frame);
}

/** How an agent's audio chunk starts, the frame the client sends most (ten a second, T17a): `{"user_audio_chunk":"<base64>"}`. */
const AGENT_AUDIO = '{"user_audio_chunk":"';

/**
 * The only fields the client's first message may carry (`conversation_initiation_client_data`, ElevenLabs'
 * WebSocket reference): its `type`; the greeting override (`onlyFirstMessage`); `dynamic_variables`, which
 * fill the placeholders the agent's owner wrote and have no override switch; and `user_id` and
 * `source_info`, which only name who and what started the call (ElevenLabs' own SDKs send `source_info`).
 * Everything else changes what the agent does or what it bills, and is refused: the overrides outside
 * `conversation_config_override` (`starting_workflow_node_id`, `procedure_ids`, `start_procedure_ids`),
 * `custom_llm_extra_body`, another `branch_id` or `environment` than the signed URL's, and any field
 * ElevenLabs may add later (Sol, #275 round 1).
 */
const AGENT_START_FIELDS = new Set(["type", "conversation_config_override", "dynamic_variables", "user_id", "source_info"]);

/** The first message's fields refused in any later frame too, so none hides in another message. */
const AGENT_START_ONLY = ["conversation_config_override", "custom_llm_extra_body", "starting_workflow_node_id", "procedure_ids", "start_procedure_ids", "branch_id", "environment", "user_id"];

/**
 * Fields ElevenLabs' own SDKs send empty (`{}`), which say nothing: the Python SDK's `custom_llm_extra_body`
 * at the top level, the JavaScript SDK's `tts` and `conversation` beside the greeting override. Removed when
 * exactly empty, before the frame is judged; a field with anything in it is judged as any other (Sol, #275
 * round 2).
 */
const AGENT_EMPTY_TOP = ["custom_llm_extra_body"];
const AGENT_EMPTY_OVERRIDE = ["tts", "conversation"];

/** Whether a value is `{}`: an object with no field at all. @param {unknown} value */
const emptyObject = (value) => isObject(value) && Object.keys(value).length === 0;

/** Removes `names` from `record` where they are exactly `{}`. @param {Record<string, unknown>} record @param {readonly string[]} names */
function dropEmpty(record, names) {
  for (const name of names) if (emptyObject(record[name])) delete record[name];
}

/**
 * Whether the client's overrides are only the one it may make (plan step 11): the agent's `first_message`,
 * so a reconnect, a new conversation, doesn't repeat the whole greeting (T17a). Nothing else: above all
 * not the duration (`conversation.max_duration_seconds`), the agent's own second cap behind ours.
 * @param {unknown} override
 */
function onlyFirstMessage(override) {
  if (override === undefined || override === null) return true;
  if (!isObject(override) || Object.keys(override).some((name) => name !== "agent")) return false;
  const agent = override.agent;
  if (agent === undefined || agent === null) return true;
  return isObject(agent) && Object.keys(agent).every((name) => name === "first_message") && (agent.first_message === undefined || agent.first_message === null || typeof agent.first_message === "string");
}

/**
 * An agent's client frame as it goes to ElevenLabs (plan 5.1: settings messages are always fully parsed).
 * - An audio chunk and nothing else goes as it is, never parsed: no quote in it but the last one.
 * - Any other frame is read whole, as ElevenLabs reads it. The first message may carry only
 *   `AGENT_START_FIELDS`, and its override only the greeting. Any other frame may carry none of the first
 *   message's fields but the greeting override (`AGENT_START_ONLY`). A frame that breaks either is refused,
 *   and so is one that is not a JSON object, or binary: ElevenLabs' messages are JSON text, and either would
 *   go unread. The rest go written again as they were read, so a repeated key can't be read another way by
 *   ElevenLabs.
 * - Fields ElevenLabs' own SDKs send empty are removed first (`AGENT_EMPTY_TOP`, `AGENT_EMPTY_OVERRIDE`).
 * - The first message's `user_id` is the one the ticket carries, whatever the client sent: ElevenLabs may load
 *   that user's memory of past conversations, so a client can never name another user (Sol, #275 rounds 2
 *   and 3). The gateway gives one only for a verified end user, scoped to the app; with none, it is removed.
 * @param {string | ArrayBuffer} data
 * @param {{ userId: string | null }} [session]
 * @returns {string | { refused: string }}
 */
export function agentLock(data, session = { userId: null }) {
  if (typeof data !== "string") return { refused: "binary_not_supported" };
  if (data.startsWith(AGENT_AUDIO) && data.endsWith('"}') && data.indexOf('"', AGENT_AUDIO.length) === data.length - 2) return data;
  const frame = parsed(data);
  if (!isObject(frame)) return { refused: "invalid_frame" };
  dropEmpty(frame, AGENT_EMPTY_TOP);
  if (isObject(frame.conversation_config_override)) dropEmpty(frame.conversation_config_override, AGENT_EMPTY_OVERRIDE);
  const start = frame.type === "conversation_initiation_client_data";
  const allowed = start
    ? Object.keys(frame).every((name) => AGENT_START_FIELDS.has(name))
    : AGENT_START_ONLY.every((name) => name === "conversation_config_override" || !Object.hasOwn(frame, name));
  if (!allowed || !onlyFirstMessage(frame.conversation_config_override)) return { refused: "override_not_allowed" };
  if (start) {
    delete frame.user_id;
    if (session.userId !== null) frame.user_id = session.userId;
  }
  return JSON.stringify(frame);
}

/** ElevenLabs' `ping` to an agent's client, every 2 s or so (T17a): `{"ping_event":{…},"type":"ping"}`, its first key first. */
const AGENT_PING = '{"ping_event"';

/**
 * An ElevenLabs agent (11a), over WebSocket at `v1/convai/conversation`, through the single-use signed URL
 * `open` asked for (`../index.js`).
 *
 * - Billed by the relay's clock from the start, at the agent's base rate a minute: an estimate, never a
 *   ceiling (burst minutes cost twice as much, long silences 5%, the LLM is extra; T16). ElevenLabs' own
 *   record of the conversation corrects the session after the end (the gateway's lookup). So no frame of
 *   ElevenLabs' is read for usage: they are forwarded as they are.
 * - The client's frames are locked (`agentLock`): only the first message's greeting may be overridden.
 * - A reconnect is a new conversation (T17a): when the client drops, the session ends at once, and the
 *   provider side with it, so ElevenLabs stops billing (plan 5.1).
 * - ElevenLabs' `ping` says nothing but "still here": the 90 s rule still ends a session whose client is gone.
 * @type {Adapter}
 */
const ELEVENLABS_AGENT = {
  shape: "per_turn",
  detached: "end",
  read: () => null,
  turn: () => null,
  lock: (data, session) => agentLock(data, session),
  keepalive: (data) => typeof data === "string" && data.length < 256 && data.startsWith(AGENT_PING),
};

/**
 * The audio Deepgram has heard, from one of its frames, in seconds, or null: a `Results` frame's end
 * (`start` + `duration`), and the closing `Metadata` frame's `duration`, each for every channel billed
 * (`channel_index[1]`, `channels`). Deepgram bills each channel with `multichannel`, and mixes them to one
 * without it, which its frames then say.
 * @param {string} data
 * @returns {number | null}
 */
function deepgramHeard(data) {
  const type = typeOf(data);
  if (type !== "Results" && type !== "Metadata") return null;
  const frame = parsed(data);
  if (!isObject(frame)) return null;
  const number = (/** @type {unknown} */ value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
  const duration = number(frame.duration);
  if (duration === null) return null;
  if (type === "Metadata") return duration * Math.max(1, Math.min(32, number(frame.channels) ?? 1));
  const start = number(frame.start);
  const channels = Array.isArray(frame.channel_index) ? number(frame.channel_index[1]) : null;
  return start === null ? null : (start + duration) * Math.max(1, Math.min(32, channels ?? 1));
}

/**
 * Deepgram streaming speech to text (10a), over WebSocket at `v1/listen`.
 *
 * - Billed, as xAI is, at the larger of the relay's clock, from the client's first audio frame to the close,
 *   and the audio Deepgram reports it heard, a running total (`deepgramHeard`). An end that cuts Deepgram's
 *   last report short still bills the clock, never less than Deepgram.
 * - Deepgram's own dollar figure for the stream corrects it after the end (the request lookup in the gateway's
 *   sweep), by the request id in its answer's `dg-request-id` header.
 * - The client's binary frames are audio; its text frames (`KeepAlive`, `Finalize`, `CloseStream`) are not.
 * - Keyterms a `Configure` message turns on, once Deepgram confirms them (`ConfigureSuccess`), mark every
 *   later slice for the keyterm add-on (`keyterms` in the journal), which the gateway prices.
 * @type {Adapter}
 */
const DEEPGRAM = {
  shape: "running_total",
  detached: "hold",
  clock: "first_activity",
  callIdHeader: "dg-request-id",
  turn: () => null,
  read(data) {
    if (typeof data !== "string") return null;
    // Keyterms turned on mid-stream (`Configure`), as Deepgram confirms them: billed on top from then on.
    if (typeOf(data) === "ConfigureSuccess") {
      const keyterms = /** @type {{ keyterms?: unknown } | null} */ (parsed(data))?.keyterms;
      return Array.isArray(keyterms) && keyterms.length > 0 ? { id: "", measures: {}, keyterms: true } : null;
    }
    const seconds = deepgramHeard(data);
    return seconds === null ? null : audioTotal(seconds);
  },
  client: (data) => (typeof data === "string" ? null : "activity"),
};

/** The smoke mock's answers, shaped like OpenAI's: `response.created`, then `response.done`. */
const MOCK_TURNS = { opens: '{"type":"response.created"', closes: '{"type":"response.done"' };

/**
 * An adapter that reads nothing: the session is metered by connection time
 * only (the wall clock meter), and never waits for an answer when it closes.
 * @type {Adapter}
 */
const NONE = { shape: "per_turn", detached: "hold", read: () => null, turn: () => null };

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
  gptlive: GPT_LIVE,
  elevenlabs_tts: ELEVENLABS_TTS,
  deepgram: DEEPGRAM,
  elevenlabs_agent: ELEVENLABS_AGENT,
  // A provider the gateway does not know (10b, plan D4): its frames, both ways, are forwarded as they are
  // and never read, so the session bills its connection time at the customer's per-minute rate. Its
  // frames are held for our SDK's reconnect, as for any provider that keeps the conversation.
  generic: NONE,
};

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

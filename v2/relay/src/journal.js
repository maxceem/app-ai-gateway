// @ts-check
/**
 * A session's journal: the usage the relay saw, kept in the session object's
 * storage until the main Worker confirms it is booked (plan 5.2 rule 3; crash
 * table rows 14–18 and 25–28). Pure functions over one small object; the
 * session's core (`./start.js`) loads it, changes it and writes it back.
 *
 * - Each usage event is added after its frame was forwarded, in one small
 *   write, with the provider's event id, so a repeated event is skipped.
 * - At a checkpoint the open usage is frozen into a slice with the next
 *   number. The slice is stored before the checkpoint is sent, so a retry
 *   sends exactly the same slice, and usage after it goes to the next one.
 * - Only one slice is unconfirmed at a time while the session runs (S6). The
 *   session's end freezes the rest into the final slice, which may make two.
 * - A slice holds measures only, never dollars or keys: token counts, the
 *   connection time, and any gap a crash left (shown as "unknown cost").
 * - The journal carries a format version. There is no compaction: the session
 *   cap and the client's message rate bound it, and its size is checked.
 */

/** The journal's format version. A newer relay reads every version still deployed (`test/relay-journal.test.ts`). */
export const JOURNAL_VERSION = 1;
/** The storage key it lives under. */
export const JOURNAL_KEY = "journal";
/**
 * How many recent events are kept to skip a repeat. A provider repeats an
 * event soon, if at all. Each is kept as a short fixed-size digest of its id
 * (`digestOf`), so however long the ids are, they take a known, small room.
 */
export const SEEN_IDS = 64;
/**
 * The journal's hard size, in bytes of JSON. The digests take about 1 KB and
 * the measures and at most two unconfirmed slices about 1 KB more, so this is
 * never reached in practice. An event that would pass it is not counted: the
 * slice gets an "unknown cost" gap instead.
 */
export const JOURNAL_MAX_BYTES = 16 * 1024;
/**
 * Whether the journal's per-event write lets frames go out before the write
 * is confirmed (Cloudflare's `allowUnconfirmed`; plan 5.2 rule 3). T12's
 * second run measured no difference either way, so frames never wait: a write
 * lost in a crash is counted as a gap from the last saved write, never
 * silently (`research/2026-11-18-v2-architecture/tests/t35-relay-journal/`).
 */
export const JOURNAL_ALLOW_UNCONFIRMED = true;

/**
 * @typedef {{ seq: number, measures: Record<string, number>, sessionMs: number, gapMs: number, gaps: number, from: number, to: number, billedMs?: number, transcriptionModel?: string }} Slice
 * One frozen slice: the usage between two checkpoints, and its connection time.
 * `billedMs`, for a provider billed by time (xAI): the time it bills in this
 * slice, which may differ from the connection time (`freeze`).
 * `transcriptionModel`: the model of the slice's input transcription
 * (`transcription_*` measures, OpenAI, 9e), which is booked apart from the
 * session's own model.
 *
 * @typedef {{
 *   v: number,
 *   nextSeq: number,
 *   from: number,
 *   measures: Record<string, number>,
 *   seen: string[],
 *   baselines: Record<string, number>,
 *   unsent: Slice[],
 *   savedAt: number,
 *   lastCheckpointAt: number,
 *   connected: boolean,
 *   droppedFrom?: number,
 *   detachedFrom?: number,
 *   detachedMs?: number,
 *   idle?: true,
 *   idleMs?: number,
 *   activeAt?: number,
 *   clockMs?: number,
 *   audioMs?: number,
 *   billedMs?: number,
 *   transcriptionModel?: string,
 * }} Journal
 * `from` starts the open usage's connection time. `seen` holds the digests of
 * the last `SEEN_IDS` event ids, oldest first. `baselines` is a running
 * total's last figure. `unsent` are frozen slices not yet confirmed, in order.
 * `savedAt` is the last time the journal was written: after a crash, the time
 * since is a gap. `connected` is the sticky proof that the session is real
 * (crash table row 20). `droppedFrom` is when the open usage first lost an
 * event to the hard size: the time from it to the slice's end is a gap.
 * `detachedFrom` and `detachedMs` are an observed session's time without its
 * side channel (plan step 12: no plan minutes and no clock charges then): since
 * when it is down now, and how long it was down earlier in the open usage. Both
 * are optional, so a journal written before them reads the same.
 *
 * `idle`, `idleMs` and `activeAt` are for a provider whose clock starts at the
 * session's first activity (xAI, plan 5.2 rule 3): until then the session's
 * time is free, neither connection time nor a gap. `idle` says the clock has
 * not started; `idleMs` is the free time in the open usage before it did;
 * `activeAt` is when it started, kept so a restart does not lose it. Optional
 * too, for the same reason.
 *
 * `clockMs`, `audioMs` and `billedMs` are that provider's running totals: the
 * connection time from the first activity, the provider's own billed audio
 * (xAI's `billable_audio_seconds`), and what the slices billed so far. Each
 * slice bills the growth of the larger of the first two (plan 5.2 rule 3).
 *
 * `transcriptionModel` is the latest input transcription model (OpenAI, 9e),
 * kept for the slices after it.
 *
 * @typedef {{ id: string, measures: Record<string, number>, audioSeconds?: number, model?: string }} UsageEvent
 * One usage event, as an adapter read it (`./adapters.js`). `audioSeconds` is a
 * provider's own running total of the audio it bills (xAI's `billable_audio_seconds`).
 * `model`: an event that is not the session's own model's, OpenAI's input transcription.
 */

/**
 * A new journal. `idle`: the provider's clock starts at the first activity
 * (`markActive`), so the time until then is free.
 * @param {number} now
 * @param {{ idle?: boolean }} [options]
 * @returns {Journal}
 */
export function newJournal(now, options = {}) {
  /** @type {Journal} */
  const journal = { v: JOURNAL_VERSION, nextSeq: 1, from: now, measures: {}, seen: [], baselines: {}, unsent: [], savedAt: now, lastCheckpointAt: 0, connected: false };
  if (options.idle === true) Object.assign(journal, { idle: true, clockMs: 0, audioMs: 0, billedMs: 0 });
  return journal;
}

/**
 * The session's first activity, at `at`: the provider's clock starts, and the
 * time before it stays free. Returns whether the journal changed: only the
 * first call does.
 * @param {Journal} journal
 * @param {number} at
 */
export function markActive(journal, at) {
  if (journal.idle !== true) return false;
  const start = Math.max(journal.from, at);
  journal.idleMs = start - journal.from;
  journal.activeAt = start;
  delete journal.idle;
  return true;
}

/**
 * The provider's own running total of the audio it bills, in milliseconds
 * (xAI's `billable_audio_seconds`). Only a higher figure counts: a repeat or a
 * figure out of order changes nothing. Returns whether the journal changed.
 * @param {Journal} journal
 * @param {number} ms
 */
export function markAudio(journal, ms) {
  if (journal.audioMs === undefined || ms <= journal.audioMs) return false;
  journal.audioMs = ms;
  return true;
}

/**
 * What this instance knew that a failed write may have kept out of the stored
 * journal (`stored`), carried into it before the final slice: the provider's
 * audio total, only ever up, and the clock's start. The stored slices and the
 * billed total stay as stored (Sol, #268 round 1).
 * @param {Journal} stored
 * @param {Journal} memory
 */
export function carryTotals(stored, memory) {
  if (stored.audioMs !== undefined && memory.audioMs !== undefined) stored.audioMs = Math.max(stored.audioMs, memory.audioMs);
  if (stored.idle === true && memory.idle !== true && memory.activeAt !== undefined) markActive(stored, memory.activeAt);
}

/**
 * Adds `count` to a measure the relay counts itself, with no provider event
 * behind it (xAI's text messages, from the client's frames).
 * @param {Journal} journal
 * @param {string} name
 * @param {number} count
 */
export function countMeasure(journal, name, count) {
  journal.measures = { ...journal.measures, [name]: (journal.measures[name] ?? 0) + count };
}

/**
 * A stored journal, or null when there is none. One in a format this relay
 * does not know is never guessed at: it is treated as lost, which the caller
 * counts as a gap.
 * @param {unknown} value
 * @returns {Journal | null}
 */
export function readJournal(value) {
  if (typeof value !== "object" || value === null) return null;
  const journal = /** @type {Journal} */ (value);
  return journal.v === JOURNAL_VERSION ? journal : null;
}

/**
 * An event id's digest: 14 hex characters (53 bits, cyrb53), whatever the
 * id's length. Two different ids share one only by a chance of about one in
 * 10^13 within the 64 kept, and then the second event would be skipped.
 * @param {string} id
 */
export function digestOf(id) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < id.length; i += 1) {
    const ch = id.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** The journal's size in bytes of JSON, as it is stored. @param {Journal} journal */
function sizeOf(journal) {
  return new TextEncoder().encode(JSON.stringify(journal)).length;
}

/**
 * Adds one usage event. Returns whether the journal changed. A repeated id
 * changes nothing.
 * - `per_turn`: each event is one turn's usage, added as it is.
 * - `running_total`: each event is the total so far; only the difference
 *   from the last total is added.
 *
 * An event that would take the journal past its hard size is not counted,
 * and the ids already seen are kept, so a repeat is still skipped. The open
 * usage gets an "unknown cost" gap from that moment to its slice's end, so
 * the slice is never booked as complete.
 * @param {Journal} journal
 * @param {UsageEvent} event
 * @param {"per_turn" | "running_total"} shape
 * @param {number} now
 * @returns {boolean}
 */
export function addUsage(journal, event, shape, now) {
  const digest = digestOf(event.id);
  if (journal.seen.includes(digest)) return false;
  const seen = [...journal.seen, digest].slice(-SEEN_IDS);
  const measures = { ...journal.measures };
  const baselines = { ...journal.baselines };
  for (const [name, value] of Object.entries(event.measures)) {
    let add = value;
    if (shape === "running_total") {
      add = Math.max(0, value - (baselines[name] ?? 0));
      baselines[name] = Math.max(value, baselines[name] ?? 0);
    }
    if (add > 0) measures[name] = (measures[name] ?? 0) + add;
  }
  if (sizeOf({ ...journal, seen, measures, baselines }) > JOURNAL_MAX_BYTES) {
    if (journal.droppedFrom !== undefined) return false;
    journal.droppedFrom = now;
    return true;
  }
  journal.seen = seen;
  journal.measures = measures;
  journal.baselines = baselines;
  if (event.model !== undefined) journal.transcriptionModel = event.model;
  return true;
}

/**
 * An observed session's side channel went down at `at` (`markAttached` ends it).
 * A second call while it is down keeps the first time. @param {Journal} journal @param {number} at
 */
export function markDetached(journal, at) {
  journal.detachedFrom ??= Math.max(journal.from, at);
}

/** The side channel is back at `at`: the time it was down is kept for the slice. @param {Journal} journal @param {number} at */
export function markAttached(journal, at) {
  if (journal.detachedFrom === undefined) return;
  journal.detachedMs = (journal.detachedMs ?? 0) + Math.max(0, at - Math.max(journal.from, journal.detachedFrom));
  delete journal.detachedFrom;
}

/**
 * Freezes the open usage into the next slice, ending at `at`, and returns
 * it; it is kept in `unsent` until confirmed. Null when there is nothing to
 * freeze: no usage, no connection time, no gap (an empty checkpoint).
 * - `gapFrom`: after a crash, the time from it to `at` is an "unknown cost"
 *   gap, not connection time (plan 5.2 rule 3).
 * - An observed session's time without its side channel (`markDetached`) is a
 *   gap too, and a side channel still down goes on into the next slice.
 *
 * Both kinds of gap, a crash's and usage dropped at the hard size, run to
 * `at`, so they are merged: time they share counts once, and the gap is never
 * longer than the slice.
 * @param {Journal} journal
 * @param {number} at
 * @param {{ gapFrom?: number }} [options]
 * @returns {Slice | null}
 */
export function freeze(journal, at, options = {}) {
  // Never before the open usage's start (a clock that crossed the deadline, or stepped back): a
  // slice that ended before it began would be refused, and block the ones after it.
  at = Math.max(journal.from, at);
  const connectedUntil = options.gapFrom === undefined ? at : Math.min(at, Math.max(journal.from, options.gapFrom));
  const downNow = journal.detachedFrom === undefined ? 0 : Math.max(0, at - Math.max(journal.from, journal.detachedFrom));
  const detachedMs = Math.min(Math.max(0, connectedUntil - journal.from), (journal.detachedMs ?? 0) + downNow);
  // Before a clock that starts at the first activity has started, the time is free: no
  // connection time, and no gap either.
  const idleMs = journal.idle === true ? at - journal.from : Math.min(at - journal.from, journal.idleMs ?? 0);
  const sessionMs = Math.max(0, connectedUntil - journal.from - detachedMs - idleMs);
  /** Where each gap starts; each runs to `at`. */
  const starts = [];
  if (options.gapFrom !== undefined && at > connectedUntil) starts.push(connectedUntil);
  // Usage was dropped at the hard size: unknown from then on.
  if (journal.droppedFrom !== undefined) starts.push(Math.min(at, Math.max(journal.from, journal.droppedFrom)));
  const gaps = starts.length + (detachedMs > 0 ? 1 : 0);
  // Detached time may overlap a dropped-usage gap: the sum is capped at the slice's length.
  const gapMs = Math.min(at - journal.from, (starts.length === 0 ? 0 : at - Math.min(...starts)) + detachedMs);
  // A provider billed at the larger of its clock and its own audio total (xAI): the slice bills the
  // growth of that larger total, so neither is counted twice across slices.
  const clockMs = (journal.clockMs ?? 0) + sessionMs;
  /** @type {number | undefined} */
  let billedTotal;
  /** @type {number | undefined} */
  let billedMs;
  if (journal.billedMs !== undefined) {
    billedTotal = Math.max(journal.billedMs, clockMs, journal.audioMs ?? 0);
    billedMs = billedTotal - journal.billedMs;
  }
  const empty = sessionMs === 0 && gapMs === 0 && gaps === 0 && Object.keys(journal.measures).length === 0 && !(billedMs !== undefined && billedMs > 0);
  if (empty) return null;
  /** @type {Slice} */
  const slice = { seq: journal.nextSeq, measures: journal.measures, sessionMs, gapMs, gaps, from: journal.from, to: at, ...(billedMs === undefined ? {} : { billedMs }) };
  // Its input transcription is booked at the transcription model's price, so the slice names it.
  if (journal.transcriptionModel !== undefined && Object.keys(journal.measures).some((name) => name.startsWith("transcription_"))) {
    slice.transcriptionModel = journal.transcriptionModel;
  }
  if (billedTotal !== undefined) {
    journal.clockMs = clockMs;
    journal.billedMs = billedTotal;
  }
  journal.unsent.push(slice);
  journal.nextSeq += 1;
  journal.from = at;
  journal.measures = {};
  delete journal.droppedFrom;
  delete journal.detachedMs;
  delete journal.idleMs;
  if (journal.detachedFrom !== undefined) journal.detachedFrom = at;
  return slice;
}

/** The slice `seq` is booked: it leaves the journal. @param {Journal} journal @param {number} seq */
export function confirm(journal, seq) {
  journal.unsent = journal.unsent.filter((slice) => slice.seq !== seq);
}

/** The last slice's number, for `close` and the settlement barrier (S6): 0 when there was none. @param {Journal | null} journal */
export function finalSliceOf(journal) {
  return journal === null ? 0 : journal.nextSeq - 1;
}

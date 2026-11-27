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
 * @typedef {{ seq: number, measures: Record<string, number>, sessionMs: number, gapMs: number, gaps: number, from: number, to: number }} Slice
 * One frozen slice: the usage between two checkpoints, and its connection time.
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
 * @typedef {{ id: string, measures: Record<string, number> }} UsageEvent
 * One usage event, as an adapter read it (`./adapters.js`).
 */

/** @param {number} now @returns {Journal} */
export function newJournal(now) {
  return { v: JOURNAL_VERSION, nextSeq: 1, from: now, measures: {}, seen: [], baselines: {}, unsent: [], savedAt: now, lastCheckpointAt: 0, connected: false };
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
  const connectedUntil = options.gapFrom === undefined ? at : Math.min(at, Math.max(journal.from, options.gapFrom));
  const downNow = journal.detachedFrom === undefined ? 0 : Math.max(0, at - Math.max(journal.from, journal.detachedFrom));
  const detachedMs = Math.min(Math.max(0, connectedUntil - journal.from), (journal.detachedMs ?? 0) + downNow);
  const sessionMs = Math.max(0, connectedUntil - journal.from - detachedMs);
  /** Where each gap starts; each runs to `at`. */
  const starts = [];
  if (options.gapFrom !== undefined && at > connectedUntil) starts.push(connectedUntil);
  // Usage was dropped at the hard size: unknown from then on.
  if (journal.droppedFrom !== undefined) starts.push(Math.min(at, Math.max(journal.from, journal.droppedFrom)));
  const gaps = starts.length + (detachedMs > 0 ? 1 : 0);
  // Detached time may overlap a dropped-usage gap: the sum is capped at the slice's length.
  const gapMs = Math.min(at - journal.from, (starts.length === 0 ? 0 : at - Math.min(...starts)) + detachedMs);
  const empty = sessionMs === 0 && gapMs === 0 && gaps === 0 && Object.keys(journal.measures).length === 0;
  if (empty) return null;
  /** @type {Slice} */
  const slice = { seq: journal.nextSeq, measures: journal.measures, sessionMs, gapMs, gaps, from: journal.from, to: at };
  journal.unsent.push(slice);
  journal.nextSeq += 1;
  journal.from = at;
  journal.measures = {};
  delete journal.droppedFrom;
  delete journal.detachedMs;
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

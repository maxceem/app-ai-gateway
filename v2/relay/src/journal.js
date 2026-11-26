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
/** How many recent event ids are kept to skip a repeat. A provider repeats an event soon, if at all. */
export const SEEN_IDS = 64;
/** The journal's hard size, in bytes of JSON. An event that would pass it is not counted: the slice gets an "unknown cost" gap instead. */
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
 *   gapMs: number,
 *   gaps: number,
 *   seen: string[],
 *   baselines: Record<string, number>,
 *   unsent: Slice[],
 *   savedAt: number,
 *   lastCheckpointAt: number,
 *   connected: boolean,
 *   droppedFrom?: number,
 * }} Journal
 * `from` starts the open usage's connection time. `baselines` is a running
 * total's last figure. `unsent` are frozen slices not yet confirmed, in order.
 * `savedAt` is the last time the journal was written: after a crash, the time
 * since is a gap. `connected` is the sticky proof that the session is real
 * (crash table row 20). `droppedFrom` is when the open usage first lost an
 * event to the hard size: the time from it to the slice's end is a gap.
 *
 * @typedef {{ id: string, measures: Record<string, number> }} UsageEvent
 * One usage event, as an adapter read it (`./adapters.js`).
 */

/** @param {number} now @returns {Journal} */
export function newJournal(now) {
  return { v: JOURNAL_VERSION, nextSeq: 1, from: now, measures: {}, gapMs: 0, gaps: 0, seen: [], baselines: {}, unsent: [], savedAt: now, lastCheckpointAt: 0, connected: false };
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
  if (journal.seen.includes(event.id)) return false;
  const seen = [...journal.seen, event.id].slice(-SEEN_IDS);
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
 * Freezes the open usage into the next slice, ending at `at`, and returns
 * it; it is kept in `unsent` until confirmed. Null when there is nothing to
 * freeze: no usage, no connection time, no gap (an empty checkpoint).
 * - `gapFrom`: after a crash, the time from it to `at` is an "unknown cost"
 *   gap, not connection time (plan 5.2 rule 3).
 * @param {Journal} journal
 * @param {number} at
 * @param {{ gapFrom?: number }} [options]
 * @returns {Slice | null}
 */
export function freeze(journal, at, options = {}) {
  const connectedUntil = options.gapFrom === undefined ? at : Math.min(at, Math.max(journal.from, options.gapFrom));
  const sessionMs = Math.max(0, connectedUntil - journal.from);
  let gapMs = journal.gapMs;
  let gaps = journal.gaps;
  if (options.gapFrom !== undefined && at > connectedUntil) {
    gapMs += at - connectedUntil;
    gaps += 1;
  }
  if (journal.droppedFrom !== undefined) {
    // Usage was dropped at the hard size: unknown from then on, and never less than 1 ms.
    gapMs += Math.max(1, at - journal.droppedFrom);
    gaps += 1;
  }
  const empty = sessionMs === 0 && gapMs === 0 && gaps === 0 && Object.keys(journal.measures).length === 0;
  if (empty) return null;
  /** @type {Slice} */
  const slice = { seq: journal.nextSeq, measures: journal.measures, sessionMs, gapMs, gaps, from: journal.from, to: at };
  journal.unsent.push(slice);
  journal.nextSeq += 1;
  journal.from = at;
  journal.measures = {};
  journal.gapMs = 0;
  journal.gaps = 0;
  delete journal.droppedFrom;
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

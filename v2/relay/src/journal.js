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
/** The journal's hard size, in characters of JSON. Past it, usage is counted as a gap. */
export const JOURNAL_MAX_CHARS = 16 * 1024;
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
 * }} Journal
 * `from` starts the open usage's connection time. `baselines` is a running
 * total's last figure. `unsent` are frozen slices not yet confirmed, in order.
 * `savedAt` is the last time the journal was written: after a crash, the time
 * since is a gap. `connected` is the sticky proof that the session is real
 * (crash table row 20).
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

/**
 * Adds one usage event. Returns whether the journal changed: a repeated id,
 * or an event past the hard size (counted as a gap instead), changes the
 * measures not at all.
 * - `per_turn`: each event is one turn's usage, added as it is.
 * - `running_total`: each event is the total so far; only the difference
 *   from the last total is added.
 * @param {Journal} journal
 * @param {UsageEvent} event
 * @param {"per_turn" | "running_total"} shape
 * @returns {boolean}
 */
export function addUsage(journal, event, shape) {
  if (journal.seen.includes(event.id)) return false;
  journal.seen.push(event.id);
  if (journal.seen.length > SEEN_IDS) journal.seen.splice(0, journal.seen.length - SEEN_IDS);
  for (const [name, value] of Object.entries(event.measures)) {
    let add = value;
    if (shape === "running_total") {
      add = Math.max(0, value - (journal.baselines[name] ?? 0));
      journal.baselines[name] = Math.max(value, journal.baselines[name] ?? 0);
    }
    if (add > 0) journal.measures[name] = (journal.measures[name] ?? 0) + add;
  }
  if (JSON.stringify(journal).length > JOURNAL_MAX_CHARS) {
    // Never reached with the fixed measures and the bounded id list; kept as the plan's hard limit.
    journal.seen = journal.seen.slice(-1);
    journal.gaps += 1;
  }
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

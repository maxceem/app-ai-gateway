import { log } from "./log";
import { platformFailure } from "./platform-errors";

/**
 * Riding out a D1 stall on the request path with records this isolate
 * already knows.
 *
 * An application's request reads a handful of rows before it reaches its
 * provider — the app, its account, its key, its providers — each through a
 * short isolate cache. When D1 slows down, every one of those reads waits, and
 * on 2026-11-12 that held apps' requests for over a minute. A record this
 * isolate read a few minutes ago is a far better answer than that wait.
 *
 * So a read whose cached entry has expired, but is no older than
 * {@link STALE_READ_MAX_MS}, waits at most {@link STALE_READ_BUDGET_MS}. If D1
 * is slower than that, or fails with a platform error, the known record is
 * served; the read keeps running and refreshes the cache when it lands. For
 * {@link STALL_HOLD_MS} after a stall, reads with a known record skip D1
 * altogether rather than each paying the budget again.
 *
 * What never changes: a read with no usable record waits for D1 as it always
 * has, because waiting may still succeed and refusing cannot; and a read that
 * answers — even "not found" — is the answer. Only a stalled or failing read is
 * replaced, and only by a record that was once true.
 */

/** How long a read with a known record waits for D1. Healthy, D1 answers in milliseconds. */
export const STALE_READ_BUDGET_MS = 1_000;

/**
 * The oldest record served in place of a stalled read. Long enough to ride out
 * a regional slowdown, short enough that a revoked key or a disabled app is not
 * served for long by an isolate that has not heard of it.
 */
export const STALE_READ_MAX_MS = 15 * 60_000;

/** How long after a stall reads with a known record go straight to it. */
export const STALL_HOLD_MS = 10_000;

let stalledUntil = 0;

/** Forgets a recent stall; for tests. */
export function resetStallHold(): void {
  stalledUntil = 0;
}

/** A record as it was last read, and when that read started. */
export interface KnownRecord<V> {
  value: V;
  storedAt: number;
}

const LATE = Symbol("late");

/**
 * Answers `read()`, or `known` when D1 stalls or fails underneath it. `label`
 * names the record in the log line that says a known record was served.
 *
 * Without a usable record it hands back `read()`'s own promise, unwrapped, so a
 * cache that shares one pending read between concurrent callers still does.
 */
export function readOrKnown<V>(
  label: string,
  known: KnownRecord<V> | undefined,
  read: () => Promise<V>,
  budgetMs: number = STALE_READ_BUDGET_MS,
): Promise<V> {
  const now = Date.now();
  if (known === undefined || now - known.storedAt > STALE_READ_MAX_MS) return read();
  if (now < stalledUntil) return Promise.resolve(served(label, known, "stall_hold"));
  return readWithin(label, known, read(), budgetMs);
}

async function readWithin<V>(
  label: string,
  known: KnownRecord<V>,
  pending: Promise<V>,
  budgetMs: number,
): Promise<V> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(() => resolve(LATE), budgetMs);
  });
  try {
    const answer = await Promise.race([pending, late]);
    if (answer !== LATE) return answer;
    stalledUntil = Date.now() + STALL_HOLD_MS;
    // The read keeps running to refresh the cache; its outcome is not awaited.
    pending.catch(() => undefined);
    return served(label, known, "timeout");
  } catch (error) {
    if (platformFailure(error) === null) throw error;
    return served(label, known, "platform_failure");
  } finally {
    clearTimeout(timer);
  }
}

function served<V>(label: string, known: KnownRecord<V>, reason: string): V {
  log("warn", "known_record_served", { record: label, reason, ageMs: Date.now() - known.storedAt });
  return known.value;
}

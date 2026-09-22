/**
 * The authentication event summary as the failures table reads it.
 *
 * The API answers with buckets — per day, per event, per outcome and reason —
 * which is the right shape to aggregate and the wrong shape to show. Folding
 * them into one row per distinct failure is arithmetic with several rules in
 * it, so it is kept away from the table that renders the result.
 */

import type { AuthEventSummary } from "@/lib/types";

export interface OutcomeRow {
  outcome: string;
  reason: string | null;
  total: number;
  /** One entry per distinct day the failure occurred on, ascending. */
  days: { date: string; count: number }[];
}

/**
 * Collapses the per-day, per-reason buckets into one row per distinct failure.
 *
 * `ok` is dropped: the success rate above already says how much of the window
 * succeeded, and leaving the healthy majority in the table buries the handful
 * of rows the operator opened this view to find.
 *
 * Days are merged, not appended. The API groups by event as well as by outcome
 * and reason, so a day on which both a token exchange and a registration failed
 * the same way arrives as two buckets — appending them would let "Days
 * affected" exceed the number of days in the window, and would split one day's
 * count across two entries.
 */
export function foldOutcomes(summary: AuthEventSummary | undefined): OutcomeRow[] {
  const rows = new Map<
    string,
    { outcome: string; reason: string | null; days: Map<string, number> }
  >();
  const add = (
    key: string,
    outcome: string,
    reason: string | null,
    date: string,
    count: number,
  ): void => {
    const row = rows.get(key) ?? { outcome, reason, days: new Map<string, number>() };
    row.days.set(date, (row.days.get(date) ?? 0) + count);
    rows.set(key, row);
  };

  for (const bucket of summary?.daily ?? []) {
    if (bucket.outcome === "ok") continue;
    add(
      `auth:${bucket.outcome}:${bucket.reason ?? ""}`,
      bucket.outcome,
      bucket.reason,
      bucket.date,
      bucket.count,
    );
  }
  for (const bucket of summary?.usage_failures ?? []) {
    add(`proxy:${bucket.status}`, bucket.status, "proxied request", bucket.date, bucket.count);
  }

  return [...rows.values()]
    .map((row): OutcomeRow => ({
      outcome: row.outcome,
      reason: row.reason,
      total: [...row.days.values()].reduce((sum, count) => sum + count, 0),
      days: [...row.days.entries()]
        .map(([date, count]) => ({ date, count }))
        .sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0)),
    }))
    .sort(
      (left, right) =>
        right.total - left.total
        || (left.outcome < right.outcome ? -1 : left.outcome > right.outcome ? 1 : 0),
    );
}

/**
 * The ledger's one rule for late bookings.
 *
 * The ledger takes no charge row dated (`usage_day`) more than
 * {@link LEDGER_LATE_BOOKING_DAYS} days before now. Retention
 * (`./retention.ts`) deletes nothing younger than 90 days. So a row the ledger
 * still takes can never be counted against rows retention has deleted: a
 * correction worked out after its charge's earlier correction was deleted, or
 * a charge replayed after its first copy was deleted, would otherwise add to
 * the day rollup (`usage_day`) a second time.
 *
 * Every late booking carries its old date, so the date alone decides:
 *
 * - a correction is dated on the day of the charge it corrects;
 * - a session's total is dated on the day the session ended;
 * - a charge or a slice replayed from the failed-write store keeps its own day.
 *
 * The rule sits in the two statements that insert a charge (`./write.ts`), so
 * every way a charge is written has it, and a new one cannot forget it. It is
 * judged at the time the row is written (`now`), never at the row's own
 * `written_at`: a replayed row carries an old one.
 *
 * 30 days is about three times the longest wait any booking has on purpose
 * (a test checks these):
 *
 * - the failed-write store keeps an entry 7 days (`../do/ChargeStore.ts`);
 * - the sweep retries a job's saved figure for about 8 days, and other work
 *   for less (`./sweep.ts`, `../jobs/jobs.ts`);
 * - a session lasts its time cap. Nothing serves sessions yet; the session
 *   relay must cap a session far below this window before it is wired.
 *
 * A row refused here is not an error, and never fails or holds up an app's
 * request: the request was served long before. Nothing is written, and
 * `ledger_booking_too_late` is logged as a warning, so the monitor shows it.
 */
import { log } from "../core/log.ts";
import type { ChargeRow } from "./write.ts";

/** Days after which the ledger takes no more charge rows dated then. Retention deletes at 90. */
export const LEDGER_LATE_BOOKING_DAYS = 30;

const DAY_MS = 86_400_000;

/** The rule as SQL: the row's day (first parameter) on or after the cutoff day (second). */
export const ON_TIME_SQL = "? >= ?";

/** The first UTC day, `YYYY-MM-DD`, a charge row may be dated on to be written at `now`. */
export function lateBookingCutoffDay(now: number): string {
  return new Date(now - LEDGER_LATE_BOOKING_DAYS * DAY_MS).toISOString().slice(0, 10);
}

/** Whether a row dated `usageDay` is too late to write at `now`. */
export function bookingTooLate(usageDay: string, now: number): boolean {
  return usageDay < lateBookingCutoffDay(now);
}

/**
 * Whether a session that started at `startedAt` may still have its row
 * written at `now`, by the same cutoff. A missing session row older than that
 * was deleted by retention with its slices: writing it again would let a
 * replayed slice count a second time.
 */
export function sessionStartTakesBookings(startedAt: number, now: number): boolean {
  return !bookingTooLate(new Date(startedAt).toISOString().slice(0, 10), now);
}

/**
 * The condition a charge insert runs under, with its parameters: the row's
 * day on or after the cutoff at `now`. Logs the refusal when the row is too
 * late, once per statement built.
 */
export function onTimeCondition(charge: ChargeRow, now: number): { readonly sql: string; readonly params: readonly [string, string] } {
  const cutoff = lateBookingCutoffDay(now);
  if (charge.usageDay < cutoff) logTooLate(charge);
  return { sql: ON_TIME_SQL, params: [charge.usageDay, cutoff] };
}

/** The warning for a charge row the ledger did not take: what it was, never a request value. */
export function logTooLate(charge: ChargeRow): void {
  log("warn", "ledger_booking_too_late", {
    app: charge.appId,
    ownerType: charge.ownerType,
    owner: charge.ownerId,
    kind: charge.kind,
    usageDay: charge.usageDay,
    costNano: charge.costNano,
  });
}

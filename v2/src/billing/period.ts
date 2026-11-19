/**
 * Which plan period an instant falls in: date arithmetic only, no clock, no
 * I/O. Ported from v1's `allowance-period.ts`, with one change (plan D18):
 *
 * A plan period starts at 00:00 UTC on the renewal day. The schedule's anchor
 * is rounded down to the start of its UTC day, never later, so the allowance
 * can reset up to a day before the payment renews, never after. Daily
 * rollups then add up to exactly one period.
 */

export interface PlanPeriod {
  /** The schedule and the period's start: all the allowance counter is keyed by. */
  periodId: string;
  periodStart: string;
  periodEnd: string;
  resetAt: string;
}

/** Where a plan's months are counted from. */
export interface PlanSchedule {
  /** The account's default plan, or a subscription. */
  kind: "free" | "paid";
  /** Stable for the schedule's life. A new subscription is a new origin, so a new counter. */
  origin: string;
  /** 00:00 UTC on the first renewal day. */
  anchorAt: number;
  /** The day of the month the schedule renews on, kept when a short month clamps it. */
  anchorDay: number;
}

/** The start of `at`'s UTC day. */
export function startOfUtcDay(at: number): number {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** The default plan's schedule: the account's own, from the day it was created. */
export function freeSchedule(accountCreatedAt: number): PlanSchedule {
  return {
    kind: "free",
    origin: `free:${new Date(accountCreatedAt).toISOString()}`,
    anchorAt: startOfUtcDay(accountCreatedAt),
    anchorDay: new Date(accountCreatedAt).getUTCDate(),
  };
}

/** A subscription's schedule, named by its generation so a new subscription starts a new counter. */
export function paidSchedule(anchorAt: number, anchorDay: number, subscriptionCreatedAt: number): PlanSchedule {
  return {
    kind: "paid",
    origin: `paid:${new Date(subscriptionCreatedAt).toISOString()}`,
    anchorAt: startOfUtcDay(anchorAt),
    anchorDay,
  };
}

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * The renewal `offset` months on, always from the original anchor, so one on
 * the 31st renews on the 28th in February and on the 31st again in March.
 */
export function monthlyRenewal(schedule: PlanSchedule, offset: number): number {
  const anchor = new Date(schedule.anchorAt);
  const absoluteMonth = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + offset;
  const year = Math.floor(absoluteMonth / 12);
  const month = absoluteMonth - year * 12;
  return Date.UTC(year, month, Math.min(schedule.anchorDay, daysInUtcMonth(year, month)));
}

/** The period `now` falls in. */
export function planPeriod(schedule: PlanSchedule, now: number): PlanPeriod {
  const anchor = new Date(schedule.anchorAt);
  const at = new Date(now);
  let offset = (at.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + at.getUTCMonth() - anchor.getUTCMonth();
  // The month difference overshoots when `now` is earlier in its month than
  // the renewal day; step back until the period starts by `now`.
  while (monthlyRenewal(schedule, offset) > now) offset -= 1;
  const start = Math.max(monthlyRenewal(schedule, offset), schedule.anchorAt);
  const end = monthlyRenewal(schedule, offset + 1);
  const periodStart = new Date(start).toISOString();
  const periodEnd = new Date(end).toISOString();
  return { periodId: `${schedule.origin}:${periodStart}`, periodStart, periodEnd, resetAt: periodEnd };
}

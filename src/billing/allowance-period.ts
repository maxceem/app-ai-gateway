/**
 * Which allowance period an instant falls in: pure date arithmetic over a
 * plan's schedule, with no imports, no clock and no I/O. `quota.ts` resolves
 * the schedule from billing and the account, and the period this returns is
 * what the organization's quota object counts under.
 */

/**
 * One allowance period: a month measured from the plan's own anchor.
 *
 * A paid plan renews on its subscription's billing anchor, and the default
 * free plan on the day the account was created, so every account's allowance
 * resets on the date its plan does. `periodId` names the schedule and the
 * period's start, which is all the counter is keyed by.
 */
export interface AllowancePeriod {
  periodId: string;
  periodStart: string;
  periodEnd: string;
  resetAt: string;
}

/** Where a plan's months are counted from. */
export interface AllowanceSchedule {
  /** Which plan the months belong to: the account's free one, or a subscription. */
  kind: "free" | "paid";
  /** Public and stable for the schedule's life; provider ids never enter it. */
  origin: string;
  anchorAt: number;
  /** The day of the month the schedule renews on, kept when a short month clamps it. */
  anchorDay: number;
}

/** The default plan's schedule: the account's own, anchored where it was created. */
export function freeAllowanceSchedule(accountCreatedAt: number): AllowanceSchedule {
  return {
    kind: "free",
    origin: `free:${new Date(accountCreatedAt).toISOString()}`,
    anchorAt: accountCreatedAt,
    anchorDay: new Date(accountCreatedAt).getUTCDate(),
  };
}

/**
 * A subscription's schedule, named by the generation it belongs to so that a
 * new subscription starts a new counter while a limit change does not.
 */
export function paidAllowanceSchedule(
  anchorAt: number,
  anchorDay: number,
  subscriptionCreatedAt: number,
): AllowanceSchedule {
  return {
    kind: "paid",
    origin: `paid:${new Date(subscriptionCreatedAt).toISOString()}`,
    anchorAt,
    anchorDay,
  };
}

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * The anchor moved `offset` months on, always from the original anchor, so a
 * schedule that starts on the 31st renews on the 28th in February and on the
 * 31st again in March rather than drifting to the 28th for good.
 */
export function monthlyAnniversary(schedule: AllowanceSchedule, offset: number): number {
  const anchor = new Date(schedule.anchorAt);
  const absoluteMonth = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + offset;
  const year = Math.floor(absoluteMonth / 12);
  const month = absoluteMonth - year * 12;
  return Date.UTC(
    year,
    month,
    Math.min(schedule.anchorDay, daysInUtcMonth(year, month)),
    anchor.getUTCHours(),
    anchor.getUTCMinutes(),
    anchor.getUTCSeconds(),
    anchor.getUTCMilliseconds(),
  );
}

/**
 * The period `now` falls in. An account nobody has claimed holds its first
 * period until its free window closes, however far past the first renewal that
 * runs, so it cannot draw a second allowance without a human owner. Claiming
 * it within that period keeps the same key, and so the same count.
 */
export function allowancePeriod(
  schedule: AllowanceSchedule,
  now: number,
  unclaimedDeadline: number | null = null,
): AllowancePeriod {
  let start: number;
  let end: number;
  if (unclaimedDeadline !== null) {
    start = schedule.anchorAt;
    end = unclaimedDeadline;
  } else {
    const anchor = new Date(schedule.anchorAt);
    const at = new Date(now);
    let offset = (at.getUTCFullYear() - anchor.getUTCFullYear()) * 12
      + at.getUTCMonth() - anchor.getUTCMonth();
    // The month difference overshoots when `now` is earlier in its month than
    // the anchor day — including in the anchor's own month, when the renewal
    // day falls after the anchor instant, as a trial that bills on a later day
    // does. Step back until the period starts by `now`; the clamp below then
    // opens the first period on the anchor itself.
    while (monthlyAnniversary(schedule, offset) > now) offset -= 1;
    start = Math.max(monthlyAnniversary(schedule, offset), schedule.anchorAt);
    end = monthlyAnniversary(schedule, offset + 1);
  }
  const periodStart = new Date(start).toISOString();
  const periodEnd = new Date(end).toISOString();
  return { periodId: `${schedule.origin}:${periodStart}`, periodStart, periodEnd, resetAt: periodEnd };
}

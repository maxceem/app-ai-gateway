/**
 * When an owner's ledger is frozen: the one rule that every booking against
 * an existing owner and every retention delete share.
 *
 * An owner is a call, a job or a session. It is live while any of these holds:
 *
 * - it has open work the sweep has not finished or given up on;
 * - it is a session still open;
 * - it has a charge dated on or after a cutoff day.
 *
 * Bookings (`./corrections.ts`, and open work saved for an owner that already
 * has charges in `./write.ts`) need the owner live at
 * {@link LEDGER_FREEZE_DAYS}. Retention (`./retention.ts`) deletes only owners
 * no longer live at 90 days. So an owner stops taking bookings 30 days before
 * retention may touch it, and a booking can never race a delete: a correction
 * worked out against a ledger retention has already cut, or a figure replayed
 * after its settlement was deleted, would add to the day rollup a second time.
 *
 * Every way a booking reaches an old owner is far shorter than those 30 days:
 *
 * - the failed-write store replays an entry for at most 7 days
 *   (`../do/ChargeStore.ts`);
 * - the sweep gives up on open work within days, and work it gave up on no
 *   longer keeps its owner live;
 * - a job is polled while its provider still has its result, which is days.
 *
 * Plain charge inserts are not checked: a new charge is dated when it is
 * written, and replayed within 7 days, so its owner is live through the charge
 * itself. A booking refused here serves the app as usual: nothing is written,
 * and the caller logs it.
 */

/** Days after which an owner with no open work takes no more bookings. Retention deletes at 90. */
export const LEDGER_FREEZE_DAYS = 60;

const DAY_MS = 86_400_000;

/** The first UTC day, `YYYY-MM-DD`, a charge must be dated on for its owner to take bookings at `now`. */
export function freezeCutoffDay(now: number): string {
  return new Date(now - LEDGER_FREEZE_DAYS * DAY_MS).toISOString().slice(0, 10);
}

/**
 * SQL true while the owner `ownerType`, `ownerId` (SQL expressions) is live,
 * with `day` (a SQL placeholder such as `?` or `?3`) as the cutoff day. Served
 * by `open_work_owner`, the session's key and `charge_owner`.
 */
export function ownerLiveSql(ownerType: string, ownerId: string, day: string): string {
  return `(EXISTS (SELECT 1 FROM open_work AS lw
                   WHERE lw.owner_type = ${ownerType} AND lw.owner_id = ${ownerId} AND lw.gave_up_at IS NULL)
           OR (${ownerType} = 'session'
               AND EXISTS (SELECT 1 FROM session AS ls WHERE ls.id = ${ownerId} AND ls.settlement = 'open'))
           OR EXISTS (SELECT 1 FROM charge AS lc
                      WHERE lc.owner_type = ${ownerType} AND lc.owner_id = ${ownerId} AND lc.usage_day >= ${day}))`;
}

/**
 * SQL true while the owner may take a new booking: it has no charge yet (a
 * new owner, whose first charge is written in the same batch), or it is live.
 */
export function ownerTakesBookingsSql(ownerType: string, ownerId: string, day: string): string {
  return `(NOT EXISTS (SELECT 1 FROM charge AS nc WHERE nc.owner_type = ${ownerType} AND nc.owner_id = ${ownerId})
           OR ${ownerLiveSql(ownerType, ownerId, day)})`;
}

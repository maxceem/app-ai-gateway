/**
 * The one cron trigger this Worker declares, in `wrangler.jsonc`: hourly, at
 * minute 17.
 *
 * One trigger rather than one per job, because a Workers Free account has only
 * a handful of cron triggers to share between all its Workers, and a self-host
 * should not spend two of them here. Every run settles expired App Attest
 * challenges; the run in {@link NIGHTLY_MAINTENANCE_HOUR_UTC} also runs the
 * nightly maintenance.
 *
 * Kept out of `src/index.ts` on purpose: workerd reads every named export of
 * the entry module as a handler or a class, and refuses to start the Worker
 * over a string.
 */
export const MAINTENANCE_CRON = "17 * * * *";

/** The UTC hour whose run of {@link MAINTENANCE_CRON} also runs the nightly maintenance: 03:17. */
export const NIGHTLY_MAINTENANCE_HOUR_UTC = 3;

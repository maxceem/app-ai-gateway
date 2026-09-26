/**
 * The one cron trigger this Worker declares, in `wrangler.jsonc`, and the one
 * the scheduled handler runs nightly maintenance for.
 *
 * Kept out of `src/index.ts` on purpose: workerd reads every named export of
 * the entry module as a handler or a class, and refuses to start the Worker
 * over a string.
 */
export const MAINTENANCE_CRON = "17 3 * * *";

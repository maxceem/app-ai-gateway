/**
 * The client of an app's failed-write store (`../do/ChargeStore.ts`), each
 * call under a deadline (plan, step 8f: every call that crosses to another
 * store has one). A call that runs out rejects, so the caller's last resort,
 * the logs, still runs in time. Kept apart from the store's class, so the
 * ledger's write path and the store never import each other.
 */
import { withDeadline } from "../core/background.ts";
import type { LedgerEntry, OpenWorkRow } from "./write.ts";

/** How long one call to an app's failed-write store may take before it counts as failed. */
export const CHARGE_STORE_DEADLINE_MS = 5_000;

/** An app's failed-write store, each call under `deadlineMs`. */
export function chargeStore(env: Env, appId: string, deadlineMs = CHARGE_STORE_DEADLINE_MS) {
  const store = env.CHARGE_STORE.getByName(appId);
  return {
    keep: (entries: readonly LedgerEntry[]) => withDeadline(store.keep(entries), deadlineMs, "keeping the charge"),
    keepWork: (rows: readonly OpenWorkRow[]) => withDeadline(store.keepWork(rows), deadlineMs, "keeping the open work"),
  };
}

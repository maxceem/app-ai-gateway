/**
 * A live session's price, fixed when it opens (plan 4.2): the resolved price
 * (its rates in nano-dollars, and whether they are the connection's own or
 * ours) is saved on the session's ledger row at `open`, and every slice is
 * priced with it. A connection edit or a new price list mid-session never
 * reprices the session.
 *
 * Saved as JSON in the session row's `rates_json`, or '' when the model had
 * no price then: its slices are booked `unresolved` and priced later by the
 * sweep, never as free. NULL means nothing is saved yet: the first checkpoint
 * saves today's price instead (`./checkpoint.ts`).
 */
import { boundedJob } from "../core/background.ts";
import { ledgerDb } from "../ledger/database.ts";
import { saveSessionPrice } from "../ledger/sessions.ts";
import { billingForCharge, priceSources, type ResolvedPrice } from "../pricing/billability.ts";
import type { Ticket } from "./tickets.ts";

/** How long `open` waits to save the price: past it, the session starts and its first checkpoint saves it. */
const SAVE_DEADLINE_MS = 1_000;

/** Today's price for the session's model on its connection, or null when it has none (or the rates can't be read). */
export function resolveSessionPrice(ticket: Ticket, ratesJson: string | null): ResolvedPrice | null {
  if (ticket.model === null) return null;
  try {
    return billingForCharge(priceSources({ type: ticket.providerType, rates_json: ratesJson }), ticket.model);
  } catch {
    // The connection's rates can't be read: no price, so the slices are priced by the sweep.
    return null;
  }
}

/** The saved form. */
export function encodeSessionPrice(price: ResolvedPrice | null): string {
  return price === null ? "" : JSON.stringify(price);
}

/** The saved form, read back. Throws when it is not one. */
export function decodeSessionPrice(text: string): ResolvedPrice | null {
  if (text === "") return null;
  const parsed = JSON.parse(text) as Partial<ResolvedPrice>;
  if (typeof parsed !== "object" || parsed === null || typeof parsed.price?.rates !== "object" || (parsed.source !== "customer_rate" && parsed.source !== "list_rate")) {
    throw new Error("not a saved session price");
  }
  return parsed as ResolvedPrice;
}

/**
 * `open`: saves the session's price on its ledger row, unless one is saved
 * already (a repeated `open` changes nothing). Never fails `open`: past the
 * deadline or on a failure it logs a warning, and the first checkpoint saves
 * the price instead.
 */
export async function savePriceAtOpen(env: Env, ticket: Ticket): Promise<void> {
  const work = (async () => {
    const ratesJson =
      ticket.connection === null
        ? null
        : ((await env.DB.prepare("SELECT rates_json FROM provider_connection WHERE id = ?").bind(ticket.connection).first<{ rates_json: string | null }>())
            ?.rates_json ?? null);
    const price = encodeSessionPrice(resolveSessionPrice(ticket, ratesJson));
    await saveSessionPrice(ledgerDb(env, ticket.account, { deadlineMs: SAVE_DEADLINE_MS }), ticket.sid, price);
  })();
  await boundedJob(work, "saving the session's price", "relay_price_unsaved", { app: ticket.app, session: ticket.sid }, SAVE_DEADLINE_MS);
}

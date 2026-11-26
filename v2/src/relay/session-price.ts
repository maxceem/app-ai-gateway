/**
 * A live session's price (plan 4.2): the resolved price, its rates in
 * nano-dollars and whether they are the connection's own or ours. Each
 * checkpoint sends today's price with its slice. Inside the ledger object, in
 * one transaction, the first checkpoint saves it on the session's row, and
 * every slice is priced with the saved one (`../ledger/sessions.ts`,
 * `writeCheckpoint`). A connection edit or a new price list mid-session never
 * reprices the session.
 *
 * The first checkpoint goes out right after the session is `active`, so a
 * price change in the few seconds between `open` and it applies to that
 * session. That is accepted: saving at `open` cost more than it saved.
 *
 * Saved as JSON in the session row's `rates_json`, or '' when the model had
 * no price then: its slices are booked `unresolved` and priced later by the
 * sweep, never as free. A price that couldn't be read today (D1 failed, the
 * connection's rates are malformed) is not "no price": nothing is saved.
 */
import { billingForCharge, priceSources, type ResolvedPrice } from "../pricing/billability.ts";
import type { Ticket } from "./tickets.ts";

/**
 * Today's price for the session's model, saved form: '' when it has none.
 * Null when it couldn't be read: the connection's settings (`ratesJson`
 * undefined: D1 didn't answer) or its rates are unreadable.
 */
export function todaySessionPrice(ticket: Ticket, ratesJson: string | null | undefined): string | null {
  if (ticket.model === null) return encodeSessionPrice(null);
  if (ratesJson === undefined) return null;
  try {
    return encodeSessionPrice(billingForCharge(priceSources({ type: ticket.providerType, rates_json: ratesJson }), ticket.model));
  } catch {
    return null;
  }
}

/** The saved form. */
export function encodeSessionPrice(price: ResolvedPrice | null): string {
  return price === null ? "" : JSON.stringify(price);
}

/**
 * The saved form, read back. Throws when it is not one. The ledger books a
 * slice whose saved price can't be read, or can't price it, as `unresolved`,
 * so the sweep prices it: a light check is enough here.
 */
export function decodeSessionPrice(text: string): ResolvedPrice | null {
  if (text === "") return null;
  const parsed = JSON.parse(text) as Partial<ResolvedPrice> | null;
  if (parsed?.source !== "customer_rate" && parsed?.source !== "list_rate") throw new Error("not a saved session price");
  return parsed as ResolvedPrice;
}

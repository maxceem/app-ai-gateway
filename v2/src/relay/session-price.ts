/**
 * A live session's price (plan 4.2): the resolved price, its rates in
 * nano-dollars and whether they are the connection's own or ours. The first
 * checkpoint saves it on the session's ledger row, in the same transaction as
 * its slice, and every later slice is booked only at that price
 * (`../ledger/sessions.ts`, `writeCheckpoint`). A connection edit or a new
 * price list mid-session never reprices the session.
 *
 * The first checkpoint goes out right after the session is `active`, so a
 * price change in the few seconds between `open` and it applies to that
 * session. That is accepted: saving at `open` cost more than it saved.
 *
 * Saved as JSON in the session row's `rates_json`, or '' when the model had
 * no price then: its slices are booked `unresolved` and priced later by the
 * sweep, never as free.
 */
import { billingForCharge, priceSources, type ResolvedPrice } from "../pricing/billability.ts";
import type { Ticket } from "./tickets.ts";

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

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A set of rates: each a whole, non-negative number of nano-dollars. */
const isRateSet = (value: unknown): boolean =>
  isObject(value) && Object.values(value).every((rate) => typeof rate === "number" && Number.isSafeInteger(rate) && rate >= 0);

/** Rates by price key value: key, then value, then a rate set. */
const isKeyedRates = (value: unknown): boolean => isObject(value) && Object.values(value).every((byValue) => isObject(byValue) && Object.values(byValue).every(isRateSet));

/** The saved form, read back. Throws when it is not one, so the caller falls back to today's price. */
export function decodeSessionPrice(text: string): ResolvedPrice | null {
  if (text === "") return null;
  const parsed: unknown = JSON.parse(text);
  const price = isObject(parsed) ? parsed.price : undefined;
  const valid =
    isObject(parsed) &&
    (parsed.source === "customer_rate" || parsed.source === "list_rate") &&
    isObject(price) &&
    isRateSet(price.rates) &&
    (price.keyed === undefined || isKeyedRates(price.keyed)) &&
    (price.keyedAdditions === undefined || isKeyedRates(price.keyedAdditions)) &&
    (price.longContextThreshold === undefined || (typeof price.longContextThreshold === "number" && price.longContextThreshold >= 0)) &&
    (price.modes === undefined || (isObject(price.modes) && Object.values(price.modes).every(isObject))) &&
    isObject(price.raw);
  if (!valid) throw new Error("not a saved session price");
  return parsed as unknown as ResolvedPrice;
}

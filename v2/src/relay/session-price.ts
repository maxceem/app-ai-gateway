/**
 * A live session's price (plan 4.2): the resolved price, its rates in
 * nano-dollars and whether they are the connection's own or ours. Each
 * checkpoint sends today's price with its slice. Inside the ledger object, in
 * one transaction, the first checkpoint saves it on the session's row, and
 * every slice is priced with the saved one (`../ledger/sessions.ts`,
 * `writeCheckpointIn`). A connection edit or a new price list mid-session never
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
import type { ModelPrice } from "../pricing/prices.ts";
import type { UsageObservation } from "../usage/observation.ts";
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

/** The rates a price may bill connection time with (`../pricing/units.ts`): the wall clock meter. */
const TIME_RATES = ["per_second", "per_minute", "per_hour"] as const;

/** Whether a price bills connection time: a provider metered by the wall clock (plan 3, meter kinds). */
export function billsTime(price: ModelPrice): boolean {
  const rates = price.rates as Readonly<Record<string, unknown>>;
  return TIME_RATES.some((field) => rates[field] !== undefined);
}

/**
 * A session slice's usage as `price` bills it. Its connection time
 * (`units.session_seconds`, at the milli scale: a millisecond count) is billed
 * only when the price has a time rate; otherwise it is dropped. Time alone
 * bills with no tokens. Other units (xAI's text messages) are kept as they are. The checkpoint and the pricing sweep both price a
 * slice this way.
 */
export function sliceUsage(usage: UsageObservation, price: ModelPrice): UsageObservation {
  const seconds = usage.units?.session_seconds;
  // Text messages alone (xAI's, before its clock started): no tokens to price, so a price with token
  // rates too bills them by their own rate, and a gap keeps that known charge (Sol, #266 round 5).
  if (seconds === undefined) {
    const counted = Object.values(usage.units ?? {}).some((count) => count !== undefined && count > 0);
    return counted && usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens + usage.outputTokens === 0 ? { ...usage, noTokens: true } : usage;
  }
  const { units, noTokens: _noTokens, ...rest } = usage;
  if (seconds > 0 && billsTime(price)) {
    const tokens = rest.inputTokens + rest.cachedInputTokens + rest.cacheWriteTokens + rest.outputTokens > 0;
    return { ...rest, units: { ...units, session_seconds: seconds }, ...(tokens ? {} : { noTokens: true as const }) };
  }
  const { session_seconds: _seconds, ...others } = units ?? {};
  return Object.keys(others).length > 0 ? { ...rest, units: others } : rest;
}

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
import { billingForCharge, priceSources, websocketPrice, type ResolvedPrice } from "../pricing/billability.ts";
import { WEBSOCKET } from "../providers/passthrough.ts";
import { keyCandidates, type ModelPrice } from "../pricing/prices.ts";
import { declaredOperation } from "../providers/presets.ts";
import type { UsageObservation } from "../usage/observation.ts";
import type { Ticket } from "./tickets.ts";

/**
 * Today's price for the session's model, saved form: '' when it has none.
 * Null when it couldn't be read: the connection's settings (`ratesJson`
 * undefined: D1 didn't answer) or its rates are unreadable. A session on a
 * listed WebSocket path is priced at the rate its ticket carries, the
 * listing's as the session started, whatever the settings say now.
 */
export function todaySessionPrice(ticket: Ticket, ratesJson: string | null | undefined): string | null {
  if (ticket.operation === WEBSOCKET) return ticket.perMinuteNano === undefined ? null : encodeSessionPrice(websocketPrice(ticket.perMinuteNano));
  if (ticket.model === null) return encodeSessionPrice(null);
  if (ratesJson === undefined) return null;
  try {
    // On the session's own operation: its section of our list, if it has one (Deepgram's streaming rates).
    return encodeSessionPrice(billingForCharge(priceSources({ type: ticket.providerType, rates_json: ratesJson }), ticket.model, ticket.operation));
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

/** Whether a session's priced slices are estimates, whatever their price (`SessionSpec.estimate`: ElevenLabs agents). */
export function sessionPricedAsEstimate(operation: string): boolean {
  return declaredOperation(operation)?.session?.estimate === true;
}

/** The rates a price may bill connection time with (`../pricing/units.ts`): the wall clock meter. */
const TIME_RATES = ["per_second", "per_minute", "per_hour"] as const;

/**
 * Whether a session's operation may bill its connection time: not one billed by tokens alone (OpenAI
 * Realtime), nor one billed by the units its adapter counts alone (ElevenLabs' characters, 10a).
 */
export function sessionBillsTime(operation: string): boolean {
  const meter = declaredOperation(operation)?.meter;
  return !(meter?.kind === "provider_event" && (meter.tokensOnly === true || meter.units !== undefined));
}

/**
 * Whether a price bills connection time: a provider metered by the wall clock (plan 3, meter kinds). Every
 * price it can bill at counts, its rates by key value too (Deepgram's by language): the candidates the
 * save check judges (`keyCandidates`), so a time it saved as billable is never dropped (Sol, #273 round 1).
 */
export function billsTime(price: ModelPrice): boolean {
  return keyCandidates(price).candidates.some(({ price: candidate }) => {
    const rates = candidate.rates as Readonly<Record<string, unknown>>;
    return TIME_RATES.some((field) => rates[field] !== undefined);
  });
}

/**
 * A session slice's usage as `price` bills it. Its connection time
 * (`units.session_seconds`, at the milli scale: a millisecond count) is billed
 * only when the price has a time rate; otherwise it is dropped. Time alone
 * bills with no tokens. Other units (xAI's text messages) are kept as they are. The checkpoint and the pricing sweep both price a
 * slice this way.
 */
export function sliceUsage(usage: UsageObservation, price: ModelPrice, timeBilled = true): UsageObservation {
  // A session billed by tokens alone (OpenAI Realtime) never bills its connection time, whatever rates
  // a custom price has: that time counts for plan minutes only (Sol, #270 round 4).
  if (!timeBilled && usage.units?.session_seconds !== undefined) {
    const { session_seconds: _time, ...rest } = usage.units;
    const { units: _units, ...others } = usage;
    return sliceUsage(Object.keys(rest).length > 0 ? { ...others, units: rest } : others, price);
  }
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

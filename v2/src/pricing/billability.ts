/**
 * Whether, and how, the gateway can bill a model on an operation for an
 * account. This module is the only place that decides it. Saving an app
 * (routing, rewrites, presets) and serving a request both ask it, so the two
 * can never disagree about what is billable.
 *
 * A model is billable on an operation when one of these holds:
 * - the one charge function (`priceInServedMode`, `./tokens.ts`) prices, at
 *   its price (the connection's own rate, else ours), the usages the
 *   operation's meter can produce (`meterCases`, `./units.ts`). Nothing here
 *   restates what bills what: the checks run the charge function itself
 *   (`BillingCheck`), so saving, serving and charging cannot disagree;
 * - the operation's answers carry the provider's own cost (OpenRouter's,
 *   xAI's), which needs no price of ours (v1).
 *
 * In a service mode other than standard, a price of ours must also have that
 * mode, unless the provider reports the cost. Only saving asks about a mode:
 * serving bills an unpriced mode at the closest price, never under standard,
 * as an estimate (`AGENTS.md`).
 *
 * The mode a request was served in is priced on the serve side by
 * `priceInServedMode` (`./tokens.ts`), the other half of this rule.
 *
 * What each caller does with a "no" is its own rule, written where it is used:
 * saving refuses; serving refuses only what was never served; the sweep leaves
 * a charge unpriced.
 *
 * A new price source changes `billingAt` and `priceSources` only. No other
 * file reads the price list or a connection's rates to decide this (a test
 * guards it).
 */
import { listedAs, type ListedModel } from "../providers/listing.ts";
import type { OperationDescription } from "../providers/operation.ts";
import type { UsageObservation } from "../usage/observation.ts";
import { isStandardMode, serviceModeName, type ServiceMode } from "../usage/service-modes.ts";
import { MoneyError } from "../money.ts";
import {
  effectivePrices,
  keyCandidates,
  listPrice,
  priceInMode,
  reportsCost,
  resolvePrice,
  servedModes,
  type CustomerRates,
  type ModelPrice,
  type PriceSourceKind,
} from "./prices.ts";
import { priceInServedMode } from "./tokens.ts";
import { meterCases } from "./units.ts";

/** Why a model cannot be billed on an operation. */
export type BillingProblem =
  /** No price at all: neither the connection's rate nor ours. */
  | "no_price"
  /** A price, but in a unit the operation does not measure (a per-minute price on chat). */
  | "wrong_unit"
  /** A price, but none in the service mode asked for. */
  | "no_mode_price";

export type ResolvedPrice = { readonly price: ModelPrice; readonly source: PriceSourceKind };

export interface Billing {
  /** The price the operation bills the model at, or null when it has none it can use. */
  readonly price: ResolvedPrice | null;
  /** The operation's answers carry the provider's own cost. */
  readonly reportsCost: boolean;
  /** Null when billable; otherwise why not. */
  readonly problem: BillingProblem | null;
}

/**
 * One provider connection's price sources: its type, its own rates, read only
 * when a decision needs them, and where a model of it is in our price list.
 * Built by `priceSources` alone.
 */
export interface PriceSources {
  readonly type: string;
  readonly rates: () => CustomerRates | null;
  /** The provider type and id a model is priced under in our list (a gateway's `openai/gpt-4o` is OpenAI's `gpt-4o`). */
  readonly listedAs: (model: string) => ListedModel;
}

/**
 * A connection's price sources, from a stored row (`rates_json`, text) or a
 * loaded record (`rates`, parsed). The rates are read once, and only when
 * asked for, so unreadable rates fail only a decision that needs them.
 */
export function priceSources(
  connection: { readonly type: string } & ({ readonly rates_json: string | null } | { readonly rates: CustomerRates | null }),
): PriceSources {
  let read: { readonly value: CustomerRates | null } | undefined;
  const type = connection.type;
  return {
    type,
    listedAs: (model) => listedAs(type, model),
    rates: () => {
      if (read === undefined) {
        const text = "rates_json" in connection ? connection.rates_json : undefined;
        const value =
          text === undefined ? (connection as { readonly rates: CustomerRates | null }).rates : text === null ? null : (JSON.parse(text) as CustomerRates);
        read = { value };
      }
      return read.value;
    },
  };
}

/** A model's price on a connection: its own rate, else ours. The one place a price is looked up. */
function resolve(connection: PriceSources, model: string): ResolvedPrice | null {
  return resolvePrice(connection.type, model, connection.rates(), connection.listedAs(model));
}

/**
 * Which check a caller asks for. Both are worked out by running the one charge
 * function (`priceInServedMode`) over the usages the operation's meter can
 * produce (`meterCases`), so neither can disagree with what a charge does.
 *
 * - `serve`: some usage the meter can produce gets a price in some mode
 *   serving can select. A request is refused only when none can.
 * - `save`: for every price-key value and every mode serving can select, some
 *   way gets a price for every usage in it. A setting is saved only when every
 *   answer it allows can be charged.
 */
export type BillingCheck = "serve" | "save";

/** How many times the checks have run the charge function: tests read it to count work, never time. */
export const CHECK_PROBES = { count: 0 };

/** Whether the charge function prices one usage; a rate too large once a mode scales it prices nothing. */
function pricesUsage(price: ModelPrice, usage: UsageObservation, mode: ServiceMode): boolean {
  CHECK_PROBES.count += 1;
  try {
    return priceInServedMode(price, usage, mode) !== null;
  } catch (error) {
    if (error instanceof MoneyError) return false;
    throw error;
  }
}

/**
 * The key values a request to `operation` can carry, out of `values`: only the
 * keys the operation reads (its `priceKeys`), as serving reads them. The
 * others stay unknown, as they would on a real request.
 */
function keysRead(operation: OperationDescription, values: Readonly<Record<string, string>>): Readonly<Record<string, string>> | undefined {
  const names = (operation.priceKeys ?? []).map((key) => key.name);
  if (names.length === 0) return undefined;
  return Object.fromEntries(Object.entries(values).filter(([name]) => names.includes(name)));
}

/** Whether one of an operation's ways prices every usage in it, at the key values it reads (`keysRead`), if any. */
function someWayPrices(operation: OperationDescription, price: ModelPrice, mode: ServiceMode, keys?: Readonly<Record<string, string>>): boolean {
  return meterCases(operation).some((way) => way.every((usage) => pricesUsage(price, keys === undefined ? usage : { ...usage, priceKeys: keys }, mode)));
}

/**
 * The first price-key values and mode at which none of `operations` can price
 * a way fully, or null when every one can: the `save` check.
 */
function firstGap(operations: readonly OperationDescription[], price: ModelPrice): { readonly values: Readonly<Record<string, string>>; readonly mode: string } | null {
  const modes = servedModes(price);
  // An operation sees only the keys it reads, so many combinations are the same check: each is run once.
  const known = new Map<string, boolean>();
  const prices = (operation: OperationDescription, mode: ServiceMode, values: Readonly<Record<string, string>>): boolean => {
    const keys = keysRead(operation, values);
    const id = `${operation.name}\u0000${serviceModeName(mode)}\u0000${keys === undefined ? "" : JSON.stringify(Object.entries(keys).sort())}`;
    let answer = known.get(id);
    if (answer === undefined) known.set(id, (answer = someWayPrices(operation, price, mode, keys)));
    return answer;
  };
  for (const candidate of keyCandidates(price).candidates) {
    for (const mode of modes) {
      if (!operations.some((operation) => prices(operation, mode, candidate.values))) {
        return { values: candidate.values, mode: serviceModeName(mode) };
      }
    }
  }
  return null;
}

/** The `serve` answer for each price and operation, kept once worked out: a list price is one object for the Worker's life. */
const SERVABLE = new WeakMap<ModelPrice, WeakMap<OperationDescription, boolean>>();

/**
 * The `serve` check: some usage the meter can produce is charged in some mode.
 * Unknown key values try every candidate and the standard fallback, as the
 * charge does.
 */
function servable(operation: OperationDescription, price: ModelPrice): boolean {
  let byOperation = SERVABLE.get(price);
  if (byOperation === undefined) SERVABLE.set(price, (byOperation = new WeakMap()));
  const known = byOperation.get(operation);
  if (known !== undefined) return known;
  const cases = meterCases(operation).flat();
  const answer = servedModes(price).some((mode) => cases.some((usage) => pricesUsage(price, usage, mode)));
  byOperation.set(operation, answer);
  return answer;
}

/** Whether `operation` can bill `price`, by the check asked for. */
function operationBillable(operation: OperationDescription, price: ModelPrice, check: BillingCheck): boolean {
  return check === "serve" ? servable(operation, price) : firstGap([operation], price) === null;
}

/** How `operation` bills `model` on a connection, in `mode` if one is asked about, by the check asked for. */
export function billing(operation: OperationDescription, connection: PriceSources, model: string, mode?: ServiceMode, check: BillingCheck = "serve"): Billing {
  return billingAt(operation, resolve(connection, model), mode, check);
}

/** `billing`, given the model's resolved price: the one place the rule is written. */
function billingAt(operation: OperationDescription, resolved: ResolvedPrice | null, mode?: ServiceMode, check: BillingCheck = "serve"): Billing {
  const cost = reportsCost(operation);
  const price = resolved !== null && operationBillable(operation, resolved.price, check) ? resolved : null;
  if (price === null) {
    if (cost) return { price: null, reportsCost: true, problem: null };
    return { price: null, reportsCost: false, problem: resolved === null ? "no_price" : "wrong_unit" };
  }
  if (!cost && mode !== undefined && !isStandardMode(mode) && priceInMode(price.price, mode) === undefined) {
    return { price, reportsCost: false, problem: "no_mode_price" };
  }
  return { price, reportsCost: cost, problem: null };
}

/**
 * The rule for a model an app lists on a connection, across the operations it
 * enables there. Returns null when the model may be listed, or the problem.
 *
 * - A model with no price at all must be billable on every enabled operation
 *   (each must report its own cost): listed by name, it would be served, and
 *   left unpriced, by any that cannot.
 * - A model with a price must be billable on at least one: an app may list
 *   `whisper-1` beside its chat models for its transcriptions. A call to an
 *   operation that cannot bill it is refused when it is made.
 */
export function listedModelProblem(
  operations: readonly OperationDescription[],
  connection: PriceSources,
  model: string,
): { readonly operation?: string } | null {
  if (operations.length === 0) return null;
  const resolved = resolve(connection, model);
  if (resolved === null) {
    const refused = operations.find((operation) => billingAt(operation, null, undefined, "save").problem !== null);
    return refused === undefined ? null : { operation: refused.name };
  }
  return operations.some((operation) => billingAt(operation, resolved, undefined, "save").problem === null) ? null : {};
}

/**
 * Whether a rewrite's target has a price this account could bill it at. A
 * rewrite names no provider, so any source counts: some connection has some
 * operation that could bill it (in any unit: each route that lists the model,
 * and each request, judges the unit), or our price list lists it for any
 * provider type (v1). A connection whose operations bill without a price is
 * judged before its rates are read.
 */
export function rewriteTargetBillable(
  model: string,
  connections: readonly PriceSources[],
  providerTypes: readonly string[],
  operationsOf: (type: string) => readonly OperationDescription[],
): boolean {
  const couldBill = (problem: BillingProblem | null) => problem === null || problem === "wrong_unit";
  return (
    providerTypes.some((type) => listPrice(type, model) !== null) ||
    connections.some((connection) => {
      const operations = operationsOf(connection.type);
      if (operations.some((operation) => couldBill(billingAt(operation, null).problem))) return true;
      const resolved = resolve(connection, model);
      return operations.some((operation) => couldBill(billingAt(operation, resolved).problem));
    })
  );
}

/**
 * The price a charge written unpriced is billed at later, by the sweep: the
 * connection's own rate, else ours. Its stored measures decide the unit, so
 * any price counts here; null when there is none yet.
 */
export function billingForCharge(connection: PriceSources, model: string): ResolvedPrice | null {
  return resolve(connection, model);
}

/** The most price-key combinations a price may have: a stored price never has more, so pricing never tries more. */
export const MAX_PRICE_KEY_COMBINATIONS = 256;

/**
 * Whether a customer's stored price for a model can be saved on a connection
 * of `providerType`, whose operations are `operations`. The model is looked
 * up exactly as live pricing looks it up (`priceSources`, `listedAs`, so a
 * gateway's `openai/gpt-4o` inherits OpenAI's modes). Its key values combine
 * in at most `MAX_PRICE_KEY_COMBINATIONS` ways, no effective price holds a
 * rate too large to store, and for every key value and every mode serving can
 * select, some operation of the connection can charge some way its answers
 * come out (the `save` check, by running the charge function). Returns null,
 * or what is wrong. Saving composes nothing of its own.
 */
export function savedPriceProblem(
  stored: CustomerRates,
  model: string,
  providerType: string,
  operations: readonly OperationDescription[],
):
  | { readonly kind: "too_large" }
  | { readonly kind: "too_many_combinations"; readonly combinations: number }
  | { readonly kind: "bills_nothing"; readonly values: Readonly<Record<string, string>>; readonly mode: string }
  | null {
  const resolved = resolve(priceSources({ type: providerType, rates: stored }), model);
  if (resolved === null) return null;
  const price = resolved.price;
  let combinations = 1;
  for (const table of Object.values(price.keyed ?? {})) combinations *= Math.max(1, Object.keys(table).length);
  if (combinations > MAX_PRICE_KEY_COMBINATIONS) return { kind: "too_many_combinations", combinations };
  try {
    effectivePrices(price);
  } catch (error) {
    if (error instanceof MoneyError) return { kind: "too_large" };
    throw error;
  }
  // A connection type with no operations has nothing to charge against, but a price with no rate at all bills nothing anywhere.
  if (operations.length === 0) {
    const empty = effectivePrices(price).find((one) => Object.keys(one.price.rates).length === 0);
    return empty === undefined ? null : { kind: "bills_nothing", values: empty.values, mode: empty.mode };
  }
  const gap = firstGap(operations, price);
  return gap === null ? null : { kind: "bills_nothing", values: gap.values, mode: gap.mode };
}

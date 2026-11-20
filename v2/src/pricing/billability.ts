/**
 * Whether, and how, the gateway can bill a model on an operation for an
 * account. This module is the only place that decides it. Saving an app
 * (routing, rewrites, presets) and serving a request both ask it, so the two
 * can never disagree about what is billable.
 *
 * A model is billable on an operation when one of these holds:
 * - its price (the connection's own rate, else ours) is in a unit the
 *   operation measures: tokens, or a transcription's minutes or hours, or an
 *   image API's images;
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
import type { OperationDescription } from "../providers/operation.ts";
import { isStandardMode, type ServiceMode } from "../usage/service-modes.ts";
import {
  listPrice,
  priceInMode,
  pricesOperation,
  reportsCost,
  resolvePrice,
  type CustomerRates,
  type ModelPrice,
  type PriceSourceKind,
} from "./prices.ts";

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
 * One provider connection's price sources: its type, and its own rates, read
 * only when a decision needs them. Built by `priceSources` alone.
 */
export interface PriceSources {
  readonly type: string;
  readonly rates: () => CustomerRates | null;
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
  return {
    type: connection.type,
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
  return resolvePrice(connection.type, model, connection.rates());
}

/** How `operation` bills `model` on a connection, in `mode` if one is asked about. */
export function billing(operation: OperationDescription, connection: PriceSources, model: string, mode?: ServiceMode): Billing {
  return billingAt(operation, resolve(connection, model), mode);
}

/** `billing`, given the model's resolved price: the one place the rule is written. */
function billingAt(operation: OperationDescription, resolved: ResolvedPrice | null, mode?: ServiceMode): Billing {
  const cost = reportsCost(operation);
  const price = resolved !== null && pricesOperation(operation, resolved.price) ? resolved : null;
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
    const refused = operations.find((operation) => billingAt(operation, null).problem !== null);
    return refused === undefined ? null : { operation: refused.name };
  }
  return operations.some((operation) => billingAt(operation, resolved).problem === null) ? null : {};
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

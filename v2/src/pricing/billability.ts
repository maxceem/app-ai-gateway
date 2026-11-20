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
 * What each caller does with a "no" is its own rule, written where it is used:
 * saving refuses; serving refuses only what was never served.
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

export interface Billing {
  /** The price the operation bills the model at, or null when it has none it can use. */
  readonly price: { readonly price: ModelPrice; readonly source: PriceSourceKind } | null;
  /** The operation's answers carry the provider's own cost. */
  readonly reportsCost: boolean;
  /** Null when billable; otherwise why not. */
  readonly problem: BillingProblem | null;
}

/** One provider connection's price sources: its type and its own rates. */
export interface PriceSources {
  readonly type: string;
  readonly rates: CustomerRates | null | undefined;
}

/** How `operation` bills `model` on a connection, in `mode` if one is asked about. */
export function billing(operation: OperationDescription, connection: PriceSources, model: string, mode?: ServiceMode): Billing {
  const resolved = resolvePrice(connection.type, model, connection.rates);
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
  const answers = operations.map((operation) => ({ operation, answer: billing(operation, connection, model) }));
  const unpriced = resolvePrice(connection.type, model, connection.rates) === null;
  if (unpriced) {
    const refused = answers.find(({ answer }) => answer.problem !== null);
    return refused === undefined ? null : { operation: refused.operation.name };
  }
  return answers.some(({ answer }) => answer.problem === null) ? null : {};
}

/**
 * Whether a rewrite's target has a price this account could bill it at. A
 * rewrite names no provider, so any source counts: our price for any provider
 * type, a connection's own rate, or a connection whose provider reports its
 * own cost (v1). Each route that lists the model, and each request, is judged
 * on its own.
 */
export function rewriteTargetBillable(
  model: string,
  connections: readonly PriceSources[],
  providerTypes: readonly string[],
  operationsOf: (type: string) => readonly OperationDescription[],
): boolean {
  return (
    providerTypes.some((type) => listPrice(type, model) !== null) ||
    connections.some((connection) => resolvePrice(connection.type, model, connection.rates) !== null || operationsOf(connection.type).some(reportsCost))
  );
}

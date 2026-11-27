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
 * The route a request takes to a price (model list, rewrite, billing) is
 * written once, in `resolveCall`. Serving calls it per request; saving runs it
 * over every call a route allows (`reachableCalls`) and judges each by one
 * rule (`callGap`), so saving never predicts serving by hand.
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
import { readingRules, rewrittenModel, type ApiStyle, type OperationDescription, type ProviderDescription } from "../providers/operation.ts";
import { declaredOperation, presetOperation, streamingSibling } from "../providers/presets.ts";
import type { UsageObservation } from "../usage/observation.ts";
import { isStandardMode, serviceModeName, STANDARD_MODE, type ServiceMode } from "../usage/service-modes.ts";
import { MoneyError, rate } from "../money.ts";
import type { PassthroughPath } from "../providers/matcher.ts";
import { LIVE_TOKEN_OPERATION, PASSTHROUGH_OPERATION } from "../providers/passthrough.ts";
import { requestedServiceMode } from "../proxy/meter.ts";
import {
  customerPrice,
  effectivePrices,
  keyCandidates,
  listedModels,
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
import { meterCases, UNIT_RATES, unitScale } from "./units.ts";
import type { Unit } from "../providers/operation.ts";

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
  /**
   * A passthrough path listed with no price: billable, charged `not_priced`
   * (plan section 4.5). Budgets are not enforced on it, and nothing is
   * retried or logged as unpriced. Only `resolvePassthrough` sets it.
   */
  readonly notPriced?: true;
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
        let value: CustomerRates | null;
        if (text === undefined) value = (connection as { readonly rates: CustomerRates | null }).rates;
        else if (text === null) value = null;
        else {
          try {
            value = JSON.parse(text) as CustomerRates;
          } catch {
            throw new UnreadableRates(type);
          }
        }
        read = { value };
      }
      return read.value;
    },
  };
}

/** A connection's stored rates cannot be read: a decision that needs them cannot be made. A `SyntaxError`, as the parse that failed. */
export class UnreadableRates extends SyntaxError {
  readonly connectionType: string;

  // A plain field, not a parameter property, so Node loads this with type stripping alone.
  constructor(connectionType: string) {
    super(`The ${connectionType} connection's rates cannot be read`);
    this.connectionType = connectionType;
    this.name = "UnreadableRates";
  }
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

/**
 * How far an operation can charge a price, at the key values it reads
 * (`keysRead`), if any, from the price's own rates:
 *
 * - `full`: one of its ways (`meterCases`) prices every usage in it;
 * - `partial`: some usage is priced, but no way fully, as a price in credits
 *   alone on text to speech, whose answer can come without its header;
 * - `none`: no usage at all, as `whisper-1` on chat, or a model the price list
 *   names as a kind the operation does not serve (`modelKinds`).
 */
type Reach = "full" | "partial" | "none";

/**
 * The one kind rule: whether an operation serves a model of its price's kind
 * (`modelKinds`). A model the price list names as another kind is
 * `wrong_unit` for the operation everywhere, at save, serve and charge. A
 * price with no kind is judged by its rates alone.
 */
function kindServed(operation: OperationDescription, price: ModelPrice): boolean {
  return operation.modelKinds === undefined || price.kind === undefined || operation.modelKinds.includes(price.kind);
}

function reach(operation: OperationDescription, price: ModelPrice, mode: ServiceMode, keys: Readonly<Record<string, string>> | undefined): Reach {
  if (!kindServed(operation, price)) return "none";
  let some = false;
  for (const way of meterCases(operation)) {
    const priced = way.map((usage) => pricesUsage(price, keys === undefined ? usage : { ...usage, priceKeys: keys }, mode));
    if (priced.every(Boolean)) return "full";
    if (priced.some(Boolean)) some = true;
  }
  return some ? "partial" : "none";
}

/**
 * The first measure `operation` produces that `price` cannot price, in the
 * way that comes closest, as words for a message: `characters`, `tokens`.
 * Null when some way prices every usage in it.
 */
export function missingMeasure(operation: OperationDescription, price: ModelPrice, mode: ServiceMode = STANDARD_MODE): string | null {
  let missing: string | null = null;
  for (const way of meterCases(operation)) {
    const unpriced = way.find((usage) => !pricesUsage(price, usage, mode));
    if (unpriced === undefined) return null;
    const units = Object.keys(unpriced.units ?? {}).map((unit) => unit.replace(/_/gu, " "));
    const measure = units.length > 0 ? units.join(" or ") : unpriced.noTokens === true ? "an answer with no usage" : "tokens";
    if (missing === null || way.length > 1) missing = measure;
  }
  return missing;
}

/** Where a price falls short: the key values and mode at which it does, and the operation, when one reaches it only partly. */
export interface Gap {
  readonly values: Readonly<Record<string, string>>;
  readonly mode: string;
  readonly operation?: string;
  /** The gap is the mode the call selects (`ReachableCall.mode`), which its price lacks. */
  readonly selectedMode?: true;
  /** The measure the price has no rate for (`missingMeasure`), when one operation is short of it. */
  readonly measure?: string;
}

/**
 * Each operation's reach of `price` at each price-key value and mode serving
 * can select, worked out once per operation, mode and key values the
 * operation reads: an operation that reads none of the keys is checked once
 * per mode, whatever the number of combinations.
 */
function reaches(price: ModelPrice): (operation: OperationDescription, mode: ServiceMode, values: Readonly<Record<string, string>>) => Reach {
  const known = new Map<string, Reach>();
  return (operation, mode, values) => {
    const keys = keysRead(operation, values);
    const id = `${operation.name}\u0000${serviceModeName(mode)}\u0000${keys === undefined ? "" : JSON.stringify(Object.entries(keys).sort())}`;
    let answer = known.get(id);
    if (answer === undefined) known.set(id, (answer = reach(operation, price, mode, keys)));
    return answer;
  };
}

/**
 * The first key values and mode at which `operation` does not charge `price`
 * fully from its rates, or null when it does at all of them: the `save` rule
 * for one call. Every way the call's answers come out must be charged.
 */
function chargeGap(operation: OperationDescription, price: ModelPrice): Gap | null {
  const reachOf = reaches(price);
  for (const candidate of keyCandidates(price).candidates) {
    for (const mode of servedModes(price)) {
      const answer = reachOf(operation, mode, candidate.values);
      if (answer !== "full") {
        const measure = missingMeasure(operation, price, mode);
        return {
          values: candidate.values,
          mode: serviceModeName(mode),
          ...(answer === "partial" ? { operation: operation.name } : {}),
          ...(measure !== null ? { measure } : {}),
        };
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

/**
 * Whether `price` has rates by key value for a session billed by its clock (xAI's voice API),
 * which never bill it. Such a session is priced by the rates the model states itself: its slices
 * name no key value, and the checkpoint bills their time only at a base time rate (`sliceUsage`).
 * Rates by key value would leave its time unbilled (Sol, #266).
 */
function keyedClockSession(operation: OperationDescription, price: ModelPrice): boolean {
  return operation.meter.kind === "wall_clock" && (price.keyed !== undefined || price.keyedAdditions !== undefined);
}

/** A live session: the relay reads and prices every one's usage (xAI's clock 9b, Gemini Live 9d, OpenAI Realtime 9e). */
function readSession(operation: OperationDescription): boolean {
  return operation.lifecycle === "session";
}

/** Whether `operation` can bill `price`, by the check asked for. */
function operationBillable(operation: OperationDescription, price: ModelPrice, check: BillingCheck): boolean {
  if (keyedClockSession(operation, price)) return false;
  if (check === "save") return chargeGap(operation, price) === null;
  // A custom provider's path is never served on a price that cannot bill some way of its in full: one rule
  // for serving and saving, so a model priced for another style is `wrong_unit` there, as whisper-1 is on chat.
  if (operation.pricedEveryWay === true) return reach(operation, price, STANDARD_MODE, undefined) === "full";
  return servable(operation, price);
}

/** How `operation` bills `model` on a connection, in `mode` if one is asked about, by the check asked for. */
export function billing(operation: OperationDescription, connection: PriceSources, model: string, mode?: ServiceMode, check: BillingCheck = "serve"): Billing {
  return billingAt(operation, resolve(connection, model), mode, check);
}

/** `billing`, given the model's resolved price: the one place the rule is written. */
function billingAt(operation: OperationDescription, resolved: ResolvedPrice | null, mode?: ServiceMode, check: BillingCheck = "serve"): Billing {
  // A model of another kind is not this operation's, whatever it reports.
  if (resolved !== null && !kindServed(operation, resolved.price)) return { price: null, reportsCost: false, problem: "wrong_unit" };
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
 * How serving resolves a call: the one place the route a request takes to a
 * price is written. Serving calls it for each request; saving runs it over
 * every call a route allows (`reachableCalls`), so the two cannot disagree.
 *
 * - An operation this build does not serve yet is refused (`servedNow`).
 *   Saving asks `asIfServed`: it judges such an operation as if it were
 *   served, so it stays strict, and a release that serves it finds its calls
 *   already judged.
 * - The app's model list judges the model the request names.
 * - Everything after it uses the model it is sent as (`rewrittenModel`: a
 *   rewrite is applied once, never to a fixed model): the price, and, for a
 *   model in a path part whose closed list is the priced models
 *   (`priced_models`, fal's `run/{model...}`), that list. A path whose model
 *   is sent as one with no price is refused, as if it were not declared,
 *   exactly as a body's model is judged after its rewrite.
 * - A model priced only in a unit the operation cannot bill was never served
 *   on it, so it is refused even when listed. A model with no price at all is
 *   refused unless the app lists it by name: its price may have gone since,
 *   and it is served and priced later (`admissionProblem`).
 */
export type CallResolution = CallRefusal | ReachableCall;

/** Why serving refuses a call, and the model it names: the one the request names, or, after the model list, the one it is sent as. */
export interface CallRefusal {
  readonly kind: "refused";
  readonly reason: "not_served" | "unpriced_path" | "model_not_allowed" | "wrong_unit" | "no_price";
  readonly model: string;
}

/** A call serving admits: the operation, the model the request names and the one it is sent as, and how it is billed. */
export interface ReachableCall {
  readonly kind: "admitted";
  readonly operation: OperationDescription;
  readonly requested: string;
  readonly model: string;
  readonly bill: Billing;
  /**
   * The service mode the call selects whatever the request says: a preset's
   * `params`, read with its connection's region. Set only when it is not
   * standard; a request's own mode is never refused (`AGENTS.md`).
   */
  readonly mode?: ServiceMode;
}

/** A call an app lets through, and where it comes in: a proxy route, a preset target, or a model a request names besides its own. */
export interface AppCall extends ReachableCall {
  /** The connection's slug. */
  readonly slug: string;
  /** Where the call comes in, as `proxy`, `alternative` or `preset:<slug>:<target index>`. */
  readonly entry: string;
}

/** A route's model policy: its model list, when it has one. */
export interface RouteModels {
  readonly models?: readonly string[] | undefined;
}

/**
 * Whether this build can serve an operation: a call measured from its
 * response or its request, or a job whose final units come in a response
 * header (`../jobs/`).
 */
export function servedNow(operation: OperationDescription): boolean {
  const { kind } = operation.meter;
  if (operation.lifecycle === "job") return operation.job !== undefined && kind === "response_header";
  return (
    operation.lifecycle === "call" &&
    (kind === "response_json" || kind === "response_header" || kind === "request_measure" || kind === "request_count")
  );
}

/** Whether the operation's model is a path part whose closed list is the priced models. */
function pricedModelsPath(operation: OperationDescription): boolean {
  const location = operation.model;
  return location.in === "path" && operation.multiSegment?.[location.part] === "priced_models";
}

/**
 * Why serving refuses a call it can bill this way, or null when it serves it.
 * `listed`: the model policy names models one by one (an app's model list, a
 * request's other models judged against it).
 */
function admissionProblem(bill: Billing, listed: boolean): "wrong_unit" | "no_price" | null {
  if (bill.problem === "wrong_unit") return "wrong_unit";
  if (bill.problem === "no_price" && !listed) return "no_price";
  return null;
}

/**
 * How a caller resolves a call. `asIfServed`: judge an operation this build
 * does not serve yet as if it did, as saving does. `forgivingPrice`: admit a
 * model with no price, as a listed one is: a live request's other models,
 * which may never answer. One with no price that does answer is left
 * unresolved, logged and retried once a rate exists, as any unpriced answer.
 */
export interface ResolveOptions {
  readonly asIfServed?: boolean;
  readonly forgivingPrice?: boolean;
}

export function resolveCall(
  route: RouteModels,
  rewrites: Readonly<Record<string, string>> | undefined,
  sources: PriceSources,
  operation: OperationDescription,
  requested: string,
  listed: ReadonlySet<string> | null = listOf(route),
  options: ResolveOptions = {},
): CallResolution {
  if (!options.asIfServed && !servedNow(operation)) return { kind: "refused", reason: "not_served", model: requested };
  if (listed !== null && !listed.has(requested)) return { kind: "refused", reason: "model_not_allowed", model: requested };
  const model = rewrittenModel(operation, requested, rewrites);
  if (pricedModelsPath(operation) && resolve(sources, model) === null) return { kind: "refused", reason: "unpriced_path", model };
  const bill = billing(operation, sources, model);
  const problem = admissionProblem(bill, listed !== null);
  if (problem !== null) return { kind: "refused", reason: problem, model };
  return { kind: "admitted", operation, requested, model, bill };
}

/** The most backend models a session's ticket names: far more than a provider lists, and the ticket stays small. */
export const BACKEND_MODELS_MAX = 128;

/**
 * The models a live session's backend may call (GPT-Live's, 9g; plan, "GPT-Live backend rules"): each
 * judged by `operation`'s own call rule, as a call to it would be (the app's model list, then the kind
 * and the price), and priced, so no backend call is ever booked without a price. With no model list,
 * the candidates are every model priced on the connection, ours or its own. Sorted, at most
 * `BACKEND_MODELS_MAX`. Never throws: a connection whose rates can't be read allows no backend model.
 */
export function backendModels(route: RouteModels, sources: PriceSources, operation: OperationDescription): string[] {
  try {
    const listed = listOf(route);
    const candidates = listed !== null ? [...listed] : [...new Set([...listedModels(sources.type), ...Object.keys(sources.rates() ?? {})])];
    return candidates
      .filter((model) => resolve(sources, model) !== null && resolveCall(route, undefined, sources, operation, model, listed, SAVING).kind === "admitted")
      .sort()
      .slice(0, BACKEND_MODELS_MAX);
  } catch {
    return [];
  }
}

/**
 * How a call to a listed passthrough path is billed (plan section 4.5): one
 * request, at the flat price the connection lists for the path, as the
 * customer's rate; or, with no price, `not_priced`. It has no model, so no
 * model list or rewrite applies, and it is always admitted. Serving calls it
 * for each request, and saving a connection checks each listed price with it
 * (`callGap`), so the two cannot disagree. A request that reaches a
 * live-session token path (plan D4) is billed the same way, as a
 * `live_token` call.
 */
export function resolvePassthrough(listed: PassthroughPath, liveToken = false): ReachableCall {
  const operation = liveToken ? LIVE_TOKEN_OPERATION : PASSTHROUGH_OPERATION;
  const bill: Billing =
    listed.priceNano === undefined
      ? { price: null, reportsCost: false, problem: null, notPriced: true }
      : billingAt(operation, { price: { rates: { per_request: rate(listed.priceNano) }, raw: {} }, source: "customer_rate" });
  return { kind: "admitted", operation, requested: "", model: "", bill };
}

/**
 * How serving resolves a model a request names besides its own
 * (`alternativeModels`, Vercel's fallback models), on an operation that
 * admitted the request's own model: it passes the same model list
 * (`allowed`), is judged under its own name, never rewritten, and is admitted
 * by the request's own rule (`admissionProblem`).
 */
export function resolveAlternative(
  operation: OperationDescription,
  sources: PriceSources,
  named: string,
  allowed: ReadonlySet<string> | null,
  options: ResolveOptions = {},
): CallResolution {
  if (!options.asIfServed && !servedNow(operation)) return { kind: "refused", reason: "not_served", model: named };
  if (allowed !== null && !allowed.has(named)) return { kind: "refused", reason: "model_not_allowed", model: named };
  const bill = billing(operation, sources, named);
  const problem = admissionProblem(bill, allowed !== null || options.forgivingPrice === true);
  if (problem !== null) return { kind: "refused", reason: problem, model: named };
  return { kind: "admitted", operation, requested: named, model: named, bill };
}

/** Why serving leaves a preset target out of its chain: its connection has no operation for the preset, or, for a fallback, the model cannot be billed there. */
export type PresetTargetResolution =
  | { readonly kind: "refused"; readonly reason: "no_operation" }
  | { readonly kind: "refused"; readonly reason: "unbillable"; readonly operation: OperationDescription; readonly model: string; readonly bill: Billing }
  | ReachableCall;

/**
 * How serving resolves one target of a preset's chain on its connection:
 *
 * - the operation is the one the target names, or the first of the preset's
 *   API style a preset can use (`presetOperation`); a caller asking for
 *   Gemini's stream gets its streaming sibling (`streamingSibling`);
 * - the model is the target's own: an app's rewrites never apply;
 * - with `select`, the call carries the service mode the preset's `params`
 *   select (`requestedServiceMode`), which saving judges (`callGap`);
 * - the first target is served even when its price has gone since the preset
 *   was saved, and priced later; a fallback that cannot be billed is left out.
 */
export function resolvePresetTarget(
  description: ProviderDescription,
  style: ApiStyle,
  target: { readonly operation?: string | undefined; readonly model: string },
  sources: PriceSources,
  options: {
    readonly primary: boolean;
    readonly streaming: boolean;
    readonly select?: { readonly params: Readonly<Record<string, unknown>>; readonly baseUrl: string | null } | undefined;
  },
): PresetTargetResolution {
  const chosen = presetOperation(description, style, target.operation, target.model);
  if (chosen === null) return { kind: "refused", reason: "no_operation" };
  const operation = (options.streaming && streamingSibling(description, chosen)) || chosen;
  const model = target.model;
  const bill = billing(operation, sources, model);
  if (bill.problem !== null && !options.primary) return { kind: "refused", reason: "unbillable", operation, model, bill };
  const select = options.select;
  const mode = select === undefined ? undefined : requestedServiceMode(description, operation, select.baseUrl, select.params as Record<string, unknown>, model).mode;
  return { kind: "admitted", operation, requested: model, model, bill, ...(mode !== undefined && !isStandardMode(mode) ? { mode } : {}) };
}

/** Each allowlist as a set, built once per list: a route's config is one object for the Worker's life, so serving and saving share it. */
const LISTS = new WeakMap<readonly string[], ReadonlySet<string>>();

/** A model list as a set for membership, the one cached set for that list; null when there is no list. */
export function modelSet(models: readonly string[] | undefined): ReadonlySet<string> | null {
  if (models === undefined) return null;
  let set = LISTS.get(models);
  if (set === undefined) LISTS.set(models, (set = new Set(models)));
  return set;
}

/** A route's model names, a set for membership; null when it has no list. */
export function listOf(route: RouteModels): ReadonlySet<string> | null {
  return modelSet(route.models);
}

/**
 * Whether `model` is a name the gateway knows on this route: the app lists or
 * rewrites it, or it has a price (ours or the customer's). A diagnostic
 * records a requested model only then, so text a caller put in the model
 * field by mistake (a key, a prompt) is never stored or shown. Never throws.
 */
export function knownModel(
  route: RouteModels,
  rewrites: Readonly<Record<string, string>> | undefined,
  sources: PriceSources,
  model: string,
): boolean {
  if (listOf(route)?.has(model) === true) return true;
  if (rewrites !== undefined && Object.hasOwn(rewrites, model)) return true;
  try {
    return resolve(sources, model) !== null;
  } catch {
    return false;
  }
}

/**
 * The model names a request to `operation` on a route can carry: its fixed
 * model, when it has one; otherwise the route's model list, or, with none,
 * every model it could name that has a price of the connection's own or a
 * rewrite, and the model a request naming none is sent with (`default`).
 * `named` is the route's part, worked out once for all its operations.
 */
function candidateModels(operation: OperationDescription, named: readonly string[], listed: boolean): readonly string[] {
  const location = operation.model;
  if (location.in === "fixed") return [location.model];
  const fallback = "default" in location ? location.default : undefined;
  if (listed || fallback === undefined || named.includes(fallback)) return named;
  return [...named, fallback];
}

/** The names `candidateModels` starts from on a route: its list, or the connection's own rates and the app's rewrites. */
function routeNames(route: RouteModels, rewrites: Readonly<Record<string, string>> | undefined, sources: PriceSources): readonly string[] {
  const listed = listOf(route);
  if (listed !== null) return [...listed];
  return [...new Set([...Object.keys(sources.rates() ?? {}), ...Object.keys(rewrites ?? {}), ...Object.values(rewrites ?? {})])];
}

/** One provider connection as an app's calls see it: its prices and what it can serve. */
export interface ConnectionView {
  readonly sources: PriceSources;
  readonly description: ProviderDescription;
  /** Its base URL, whose region a selected service mode takes (`requestedServiceMode`). */
  readonly baseUrl?: string | null | undefined;
}

/** The parts of an app's configuration that decide which calls it lets through, read loosely. */
export interface AppCallConfig {
  readonly routing: {
    readonly providers: Readonly<Record<string, { readonly operations: readonly string[]; readonly models?: readonly string[] | undefined }>>;
    readonly model_rewrites?: Readonly<Record<string, string>> | undefined;
  };
  readonly presets?:
    | Readonly<
        Record<
          string,
          {
            readonly provider: string;
            readonly operation: string;
            readonly model: string;
            readonly params?: Readonly<Record<string, unknown>> | undefined;
            readonly fallback?: readonly { readonly provider: string; readonly operation?: string | undefined; readonly model: string }[] | undefined;
          }
        >
      >
    | undefined;
}

/** Saving judges every operation, served yet or not (`ResolveOptions`). */
const SAVING: ResolveOptions = { asIfServed: true };

/** Counts the calls resolved while enumerating, beside `CHECK_PROBES`: tests read it to count work, never time. */
export const RESOLVED_CALLS = { count: 0 };

/**
 * Every call an app lets through, at every entry point serving has, each
 * resolved by the function serving calls there:
 *
 * - each proxy route: `resolveCall` over its enabled operations and every
 *   model name a request to each can carry (`candidateModels`);
 * - each model a request may name besides its own (`resolveAlternative`,
 *   Vercel's fallback models);
 * - each preset target (`resolvePresetTarget`), on the operation it picks and
 *   its streaming sibling, in the service mode its `params` select. A
 *   fallback serving cannot bill is included: serving would drop it without
 *   a word, so saving judges it (`callGap`) and refuses it.
 *
 * Operations this build does not serve yet are judged as if they were.
 *
 * A connection whose rates cannot be read is named in `unreadable`, and its
 * calls are left out: no decision about them can be made. A route with no
 * model list allows any model with a price, our list's included: those are
 * judged by a test over the price list, as no save could name them all.
 */
export function reachableCalls(
  app: AppCallConfig,
  connection: (slug: string) => ConnectionView | null,
): { readonly calls: readonly AppCall[]; readonly unreadable: ReadonlySet<string> } {
  const calls: AppCall[] = [];
  const unreadable = new Set<string>();
  const rewrites = app.routing.model_rewrites;
  const guarded = (slug: string, collect: () => AppCall[]): void => {
    try {
      calls.push(...collect());
    } catch (error) {
      if (!(error instanceof UnreadableRates)) throw error;
      unreadable.add(slug);
    }
  };
  for (const [slug, route] of Object.entries(app.routing.providers)) {
    const view = connection(slug);
    if (view === null) continue;
    const operations = view.description.operations.filter((operation) => route.operations.includes(operation.name));
    guarded(slug, () => {
      const found: AppCall[] = [];
      const listed = listOf(route);
      const named = routeNames(route, rewrites, view.sources);
      for (const operation of operations) {
        const names = candidateModels(operation, named, listed !== null);
        for (const requested of names) {
          RESOLVED_CALLS.count += 1;
          const call = resolveCall(route, rewrites, view.sources, operation, requested, listed, SAVING);
          if (call.kind === "admitted") found.push({ ...call, slug, entry: "proxy" });
        }
        if (readingRules(view.description, operation).alternativeModels === undefined) continue;
        for (const other of names) {
          RESOLVED_CALLS.count += 1;
          const call = resolveAlternative(operation, view.sources, other, listed, SAVING);
          if (call.kind === "admitted") found.push({ ...call, slug, entry: "alternative" });
        }
      }
      return found;
    });
  }
  for (const [name, preset] of Object.entries(app.presets ?? {})) {
    const style = declaredOperation(preset.operation)?.style;
    if (style === undefined) continue;
    const targets = [{ provider: preset.provider, operation: preset.operation as string | undefined, model: preset.model }, ...(preset.fallback ?? [])];
    targets.forEach((target, index) => {
      const view = connection(target.provider);
      if (view === null) return;
      guarded(target.provider, () => {
        const found: AppCall[] = [];
        for (const streaming of [false, true]) {
          RESOLVED_CALLS.count += 1;
          const select = preset.params === undefined ? undefined : { params: preset.params, baseUrl: view.baseUrl ?? null };
          // Every target as serving bills it once reached: serving leaves out a fallback it cannot bill without a word, so saving judges it instead.
          const call = resolvePresetTarget(view.description, style, target, view.sources, { primary: true, streaming, select });
          if (call.kind !== "admitted" || found.some((one) => one.operation === call.operation)) continue;
          found.push({ ...call, slug: target.provider, entry: `preset:${name}:${index}` });
        }
        return found;
      });
    });
  }
  return { calls, unreadable };
}

/** A call's identity across a save: where it comes in, the connection, the operation, the model the request names, the one it is sent as, and the mode it selects. */
export function callKey(call: AppCall): string {
  return [call.entry, call.slug, call.operation.name, call.requested, call.model, call.mode === undefined ? "" : serviceModeName(call.mode)].join("\u0000");
}

/**
 * The `save` rule for a call serving admits: every way its answers come out
 * is charged. An operation that reports its own cost charges it whatever the
 * price (`billingAt`); otherwise the call's price must charge every way, at
 * every key value and mode (`chargeGap`), and a call with no price at all
 * (a listed model whose price is gone) cannot. A call that selects a
 * service mode (`mode`) also needs a price in that mode (`no_mode_price`).
 * Returns the gap, or null.
 */
export function callGap(call: ReachableCall): Gap | null {
  if (call.bill.reportsCost || call.bill.notPriced === true) return null;
  if (call.bill.price === null) return { values: {}, mode: "standard", operation: call.operation.name };
  if (call.mode !== undefined && billingAt(call.operation, call.bill.price, call.mode).problem === "no_mode_price") {
    return { values: {}, mode: serviceModeName(call.mode), operation: call.operation.name, selectedMode: true };
  }
  return chargeGap(call.operation, call.bill.price.price);
}

/**
 * The one rule for a model an app lists on a route: some operation the route
 * enables serves it (`resolveCall`). An app may list `whisper-1` beside its
 * chat models for its transcriptions: a call to one that cannot bill it is
 * refused when made. Each call it admits is judged as any other (`callGap`).
 * Returns null when it may be listed, or the refusal that stands for all:
 * the first refusal over its price (`wrong_unit`, `no_price`,
 * `unpriced_path`). An operation this build does not serve yet is judged as
 * if it were, as every save judges it.
 */
export function listedModelRefusal(
  route: RouteModels,
  rewrites: Readonly<Record<string, string>> | undefined,
  sources: PriceSources,
  operations: readonly OperationDescription[],
  listed: string,
): CallRefusal | null {
  let refusal: CallRefusal | null = null;
  for (const operation of operations) {
    const call = resolveCall(route, rewrites, sources, operation, listed, undefined, SAVING);
    if (call.kind === "admitted") return null;
    if (refusal === null && call.reason !== "model_not_allowed") refusal = call;
  }
  return refusal;
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
/**
 * The provider's own list price for a model, at our list's rates, never a
 * customer's: what a provider's rounded cost report is judged against
 * (`../proxy/call-charge.ts`), since the provider rounds its own figure.
 */
export function providerListPrice(providerType: string, model: string): ModelPrice | null {
  return listPrice(providerType, model);
}

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
  | { readonly kind: "session_rates"; readonly operation: string; readonly byClock: boolean; readonly tokensOnly: boolean }
  | {
      readonly kind: "bills_nothing";
      readonly values: Readonly<Record<string, string>>;
      readonly mode: string;
      readonly operation?: string;
      /** The measure the price has no rate for, when one operation is short of it. */
      readonly measure?: string;
    }
  | null {
  const resolved = resolve(priceSources({ type: providerType, rates: stored }), model);
  if (resolved === null) return null;
  const price = resolved.price;
  let combinations = 1;
  for (const table of Object.values(price.keyed ?? {})) combinations *= Math.max(1, Object.keys(table).length);
  if (combinations > MAX_PRICE_KEY_COMBINATIONS) return { kind: "too_many_combinations", combinations };
  // A model our list prices for a live session (xAI's grok-voice-3.0, Gemini's Live models, OpenAI's
  // Realtime models): a custom price must still bill that session, by its own save check (for xAI, both
  // base rates and none by key value). Refused here, since an app that routes to it would otherwise be
  // judged only once the price had already made it ineligible, and its next session refused (Sol, #266
  // rounds 2 and 3). Each session operation names its model kinds, so an image model's own price is never
  // judged by a session (Sol, #269 round 1).
  const listed = listPrice(providerType, model);
  const session =
    listed === null
      ? undefined
      : operations.find((operation) => readSession(operation) && operationBillable(operation, listed, "save") && !operationBillable(operation, price, "save"));
  if (session !== undefined) {
    const tokensOnly = session.meter.kind === "provider_event" && session.meter.tokensOnly === true;
    return { kind: "session_rates", operation: session.name, byClock: session.meter.kind === "wall_clock", tokensOnly };
  }
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
  // The connection does not know which operations an app will enable: its own rates must charge some
  // operation fully, at every key value and mode. The apps that route to it are judged call by call when
  // its rates are saved (`../admin/apps.ts`, `checkConnectionChange`).
  const gap = ownRatesGap(operations, price);
  if (gap === null) return null;
  const named = operations.find((operation) => operation.name === gap.operation) ?? (operations.length === 1 ? operations[0] : undefined);
  const measure = named === undefined ? null : missingMeasure(named, price);
  return { kind: "bills_nothing", ...gap, ...(measure !== null ? { measure } : {}) };
}

/**
 * The first key values and mode at which no operation charges `price` fully
 * from its own rates, or null: a connection's rates must be usable somewhere.
 * An operation that reports its own cost does not count: the rates must
 * charge something themselves. The first operation reaching it only partly is
 * named, when one does.
 */
function ownRatesGap(operations: readonly OperationDescription[], price: ModelPrice): Gap | null {
  const reachOf = reaches(price);
  for (const candidate of keyCandidates(price).candidates) {
    for (const mode of servedModes(price)) {
      const all = operations.map((operation) => reachOf(operation, mode, candidate.values));
      if (all.includes("full")) continue;
      const partly = all.indexOf("partial");
      return { values: candidate.values, mode: serviceModeName(mode), ...(partly === -1 ? {} : { operation: operations[partly]!.name }) };
    }
  }
  return null;
}

/**
 * What one whole unit costs at our list price for a model, in nano-dollars,
 * or null when the list has no rate for it. Only a comparison: a cross-check
 * header is judged by it (`src/proxy/meter.ts`), and nothing is billed by it.
 */
/** One operation a model's calls can take, and every service mode it can be billed in (`selectableModes`). */
export interface ModeCalls {
  readonly operation: OperationDescription;
  readonly modes: readonly ServiceMode[];
}

/**
 * A mode rate this save adds or changes that can never bill, or null: the
 * one rule for whether a rate entry is ever used. Each call the model can
 * take is priced by the one charge function (`priceInServedMode`), in every
 * mode it can be billed in, over every usage its meter can produce
 * (`meterCases`, and each above every long-context threshold the rates name),
 * fallbacks included, once with the entry and once without
 * it. An entry whose absence changes no charge is never used. Entries that
 * are unchanged from `before` are not judged again.
 */
export function unusedModeRate(
  after: CustomerRates,
  before: CustomerRates | null,
  model: string,
  calls: readonly ModeCalls[],
): string | null {
  const modes = (after[model] as { modes?: Record<string, unknown> } | undefined)?.modes;
  if (modes === undefined) return null;
  const stored = (before?.[model] as { modes?: Record<string, unknown> } | undefined)?.modes;
  const changed = Object.keys(modes).filter((name) => stored === undefined || !Object.hasOwn(stored, name) || JSON.stringify(stored[name]) !== JSON.stringify(modes[name]));
  if (changed.length === 0) return null;
  // The usages each call's meter can produce, and each with its input just over every long-context threshold the
  // model's rates name, so a long rate is probed where it bills.
  const entry = after[model] as { long_context_threshold?: unknown; modes?: Record<string, { long_context_threshold?: unknown }> };
  const thresholds = [entry.long_context_threshold, ...Object.values(entry.modes ?? {}).map((one) => one?.long_context_threshold)].filter(
    (value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
  );
  const usagesOf = (operation: OperationDescription) =>
    meterCases(operation)
      .flat()
      .flatMap((usage) => [usage, ...(usage.noTokens === true ? [] : thresholds.map((threshold) => ({ ...usage, inputTokens: threshold + 1 })))]);
  const charges = (rates: CustomerRates): string[] => {
    const price = customerPrice(rates, model);
    if (price === null) return [];
    return calls.flatMap(({ operation, modes: selectable }) =>
      usagesOf(operation).flatMap((usage) =>
        selectable.map((mode) => JSON.stringify(priceInServedMode(price, usage, mode), (_, value: unknown) => (typeof value === "bigint" ? value.toString() : value))),
      ),
    );
  };
  const withEntry = charges(after);
  for (const name of changed) {
    const { [name]: _dropped, ...rest } = modes;
    const without = charges({ ...after, [model]: { ...after[model], modes: rest } });
    if (without.every((charge, index) => charge === withEntry[index])) return name;
  }
  return null;
}

export function listedUnitRate(providerType: string, model: string, unit: Unit): number | null {
  const price = listPrice(providerType, model);
  if (price === null) return null;
  for (const { field, units, per } of UNIT_RATES) {
    const value = price.rates[field as keyof ModelPrice["rates"]];
    if (units.includes(unit) && typeof value === "number" && value > 0) return (value * unitScale(unit)) / per;
  }
  return null;
}

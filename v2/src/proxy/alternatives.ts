/**
 * Models a request names besides its own, which the provider may serve it
 * with instead (`alternativeModels`, Vercel's fallback models). The one place
 * they are judged and priced, for the proxy path and presets alike:
 *
 * - each is resolved by the rule saving runs too (`resolveAlternative`): the
 *   same model policy as the request's own model, and the same admission, or
 *   the request is refused before it spends anything;
 * - the charge is priced at the model the answer says served the request, if
 *   it is one of them, in the service mode the request asks of that model's
 *   provider (`chargedAs`);
 * - when the answer does not say which model served it, the request's own is
 *   charged, as an estimate, and logged;
 * - what the customer set is their choice: a model that has the provider
 *   choose, which the app's list or a preset names itself, stands as any
 *   listed model, and so does the target of the app's own rewrite. Only the
 *   models the caller sends are judged.
 */
import { GatewayError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { callGap, modelSet, resolveAlternative, type Billing, type PriceSources } from "../pricing/billability.ts";
import { modelBodyField, readingRules, type OperationDescription, type ProviderDescription } from "../providers/operation.ts";
import type { ServiceMode, ServiceModeValue } from "../usage/service-modes.ts";
import type { CallAttempt } from "./call-charge.ts";
import { requestedServiceMode } from "./meter.ts";

/** How one of the request's other models is billed: its price, and the mode the request asks of its provider. */
export interface Alternative {
  readonly billing: Billing;
  readonly requestedMode: { readonly mode: ServiceMode; readonly unknown?: ServiceModeValue };
}

/** The request's other models, each with how it is billed. Empty when it names none. */
export type Alternatives = ReadonlyMap<string, Alternative>;

const NONE: Alternatives = new Map();

/**
 * The models `body` names at `path`: a dot path whose `[]` after a name reads
 * every item of that list (`routing.routes[].model`). Absent when nothing is
 * there; a value that is not a model id is refused.
 */
function modelsAt(body: Record<string, unknown>, path: string): string[] {
  let values: unknown[] = [body];
  for (const segment of path.split(".")) {
    const list = segment.endsWith("[]");
    const key = list ? segment.slice(0, -2) : segment;
    const next: unknown[] = [];
    for (const value of values) {
      if (typeof value !== "object" || value === null || Array.isArray(value) || !Object.hasOwn(value, key)) continue;
      const found = (value as Record<string, unknown>)[key];
      if (found === undefined || found === null) continue;
      if (!list) next.push(found);
      else if (Array.isArray(found)) next.push(...found);
      else throw invalidModels(path);
    }
    values = next;
  }
  if (!values.every((model) => typeof model === "string" && model.length > 0)) throw invalidModels(path);
  return values as string[];
}

function invalidModels(path: string): GatewayError {
  return new GatewayError(400, "invalid_request", `${path.replaceAll("[]", "")} must name model ids`);
}

/** Every model `body` names besides its own (`alternativeModels`), in order, each once, with the path it was named at. */
export function namedAlternatives(description: ProviderDescription, operation: OperationDescription, body: Record<string, unknown>): Map<string, string> {
  const named = new Map<string, string>();
  for (const path of readingRules(description, operation).alternativeModels?.paths ?? []) {
    for (const model of modelsAt(body, path)) if (!named.has(model)) named.set(model, path.replaceAll("[]", ""));
  }
  return named;
}

/**
 * The model a request stands as, by the one rule for the models a
 * request names: every one is judged, the one in its model field and every
 * one its provider reads elsewhere (`alternativeModels`), and the model the
 * answer says served it is charged (`chargedAs`).
 *
 * `own` is its model field's, as the caller sent it; undefined when it names
 * none. Null means that model stands for the request. Otherwise the first
 * model it names elsewhere does, the one the provider tries first, so it
 * must be billable as a request's own model must: when its field names none
 * (Perplexity's Agent API reads `models` alone), or names one that has the
 * provider choose (`choosingModels`). A request naming no model at all is left to the model
 * field's own rule (a default, or a refusal). One that has the provider
 * choose but names no models to choose among is refused: the provider would
 * pick a model the gateway cannot judge. That holds only where `allowed`,
 * the app's model list, limits it: without a list there is nothing to get
 * around, and the model stands as written. `own` is the model as the caller
 * sent it; one the list names itself, or one the app's own rewrite replaces
 * (`rewritten`), is the customer's choice, and stands as any listed model
 * does, so the rewrite is always applied.
 */
export function standingModel(
  description: ProviderDescription,
  operation: OperationDescription,
  body: Record<string, unknown>,
  own: string | undefined,
  allowed: readonly string[] | undefined,
  rewritten = false,
): string | null {
  // A key in another letter case is refused first, before the model it hides is judged or priced.
  refuseMiscasedModelKeys(description, operation, body);
  const rules = readingRules(description, operation);
  const choosing = own !== undefined && !rewritten && rules.choosingModels?.includes(own) === true && allowed?.includes(own) !== true;
  if (own !== undefined && !choosing) return null;
  const [first] = namedAlternatives(description, operation, body).keys();
  if (first !== undefined) return first;
  if (!choosing || allowed === undefined) return null;
  const where = (rules.alternativeModels?.paths ?? []).map((path) => path.replaceAll("[]", "")).join(" and ");
  throw new GatewayError(400, "invalid_request", `${own} has the provider choose the model, so the request must name the models it may choose among in ${where}`);
}

/**
 * Writes the request's judged `model` as its only alternative where a field
 * it sends brings a model list of its own and it sends no list
 * (`alternativeModels.pinWhen`): then the provider can serve it only with a
 * model the gateway judged. True when it changed the body.
 */
export function pinnedModels(description: ProviderDescription, operation: OperationDescription, body: Record<string, unknown>, model: string): boolean {
  const pin = readingRules(description, operation).alternativeModels?.pinWhen;
  if (pin === undefined) return false;
  const sent = (name: string) => Object.hasOwn(body, name) && body[name] !== undefined && body[name] !== null;
  if (!pin.fields.some(sent) || sent(pin.list)) return false;
  body[pin.list] = [model];
  return true;
}

/**
 * The save-time rule for the models a preset's fixed parameters name besides
 * its own: each must be the preset's model, since a preset fixes it, and be
 * one a call can be saved with (`callGap`: a price, or the provider's own cost
 * report). Null when they pass, or why not.
 */
export function savedAlternativesProblem(
  description: ProviderDescription,
  operation: OperationDescription,
  body: Record<string, unknown>,
  model: string,
  sources: PriceSources,
): string | null {
  try {
    refuseMiscasedModelKeys(description, operation, body);
  } catch (error) {
    if (error instanceof GatewayError) return error.message;
    throw error;
  }
  for (const [named, field] of namedAlternatives(description, operation, body)) {
    const call = resolveAlternative(operation, sources, named, new Set([model]), { asIfServed: true });
    if (call.kind === "refused") {
      return call.reason === "model_not_allowed"
        ? `${field} names ${named}, but a preset fixes its model to ${model}`
        : `${field} names ${named}, which has no price that ${operation.name} can bill`;
    }
    if (callGap(call) !== null) return `${field} names ${named}, which has no price that ${operation.name} can bill`;
  }
  return null;
}

/**
 * A key as a decoder that matches keys regardless of case may compare it:
 * Go folds compatibility forms too, so `ſ` (U+017F) reads as `s` and the
 * Kelvin sign as `k`. NFKC maps both before lower-casing.
 */
function folded(key: string): string {
  return key.normalize("NFKC").toLowerCase();
}

/**
 * Refuses a body that names a model under a key the operation reads in
 * another letter case, such as `Model` or `ROUTING`: a provider whose JSON
 * decoder matches keys regardless of case (Perplexity's look like Go's) would
 * read it, and the gateway, reading the exact key, would judge another model
 * or none. Checked at every level a model is read at: the model field, each
 * `alternativeModels` path and each object on it, and the fields that bring
 * models of their own (`pinWhen`). A well-formed request never has one.
 */
function refuseMiscasedModelKeys(description: ProviderDescription, operation: OperationDescription, body: Record<string, unknown>): void {
  const field = modelBodyField(operation);
  const alternatives = readingRules(description, operation).alternativeModels;
  const paths = [...(field === null ? [] : [field]), ...(alternatives?.paths ?? []), ...(alternatives?.pinWhen?.fields ?? [])];
  for (const path of paths) {
    let level: unknown[] = [body];
    for (const segment of path.split(".")) {
      const key = segment.endsWith("[]") ? segment.slice(0, -2) : segment;
      const next: unknown[] = [];
      for (const value of level) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
        const miscased = Object.keys(value).find((name) => name !== key && folded(name) === folded(key));
        if (miscased !== undefined) throw new GatewayError(400, "invalid_request", `${miscased} must be spelled ${key}`);
        if (!Object.hasOwn(value, key)) continue;
        const found = (value as Record<string, unknown>)[key];
        if (segment.endsWith("[]") && Array.isArray(found)) next.push(...found);
        else next.push(found);
      }
      level = next;
    }
  }
}

/**
 * Judges the models `body` names besides its own. `allowed` is the model
 * policy the request's own model passed: the app's list, or a preset's one
 * model; without it, any model with a price.
 */
export function judgedAlternatives(
  description: ProviderDescription,
  operation: OperationDescription,
  body: Record<string, unknown>,
  policy: { readonly allowed: readonly string[] | undefined; readonly sources: PriceSources; readonly baseUrl: string | null },
): Alternatives {
  refuseMiscasedModelKeys(description, operation, body);
  const named = namedAlternatives(description, operation, body);
  if (named.size === 0) return NONE;
  const judged = new Map<string, Alternative>();
  const allowed = modelSet(policy.allowed);
  for (const [model, field] of named) {
    // Resolved by the one rule saving runs too (`resolveAlternative`). A
    // missing price never refuses: the model may never answer, and one that
    // does with no price is left unresolved, as any unpriced answer.
    const call = resolveAlternative(operation, policy.sources, model, allowed, { forgivingPrice: true });
    if (call.kind === "refused") {
      if (call.reason === "model_not_allowed") {
        throw new GatewayError(403, "model_not_allowed", "Model is not allowed", undefined, { data: { model, field } });
      }
      throw new GatewayError(400, "pricing_not_configured", `Model ${model} has no price that ${operation.name} can bill`, undefined, {
        data: { model, field },
      });
    }
    const bill = call.bill;
    // Read with that model's provider's table: one request may name an
    // Anthropic model and a Gemini one, whose tiers mean different things.
    judged.set(model, { billing: bill, requestedMode: requestedServiceMode(description, operation, policy.baseUrl, body, model) });
  }
  return judged;
}

/**
 * The attempt as it is charged: at the model the answer says served it, when
 * that is one of the request's other models. A model the answer names that
 * the request did not is logged, and the request's own model is charged,
 * marked as an estimate. When the answer carries the provider's own cost
 * (`costReported`), that cost is the charge whatever the model's name (a
 * router's or an alias's always differs), so nothing is logged or marked.
 */
export function chargedAs(attempt: CallAttempt, servedModel: string | null, costReported = false): CallAttempt {
  const others = attempt.alternatives;
  if (others === undefined || others.size === 0 || servedModel === attempt.model) return attempt;
  const alternative = servedModel === null ? undefined : others.get(servedModel);
  if (alternative === undefined && costReported) return attempt;
  if (alternative === undefined) {
    // It may have been served by another model, priced differently: the
    // request's own model is charged, marked as an estimate.
    log("warn", servedModel === null ? "served_model_unknown" : "served_model_unexpected", {
      app: attempt.appId,
      providerSlug: attempt.providerSlug,
      model: attempt.model,
    });
    return { ...attempt, servedModelUnknown: true };
  }
  const { mode, unknown } = alternative.requestedMode;
  const { requestedModeUnknown: _ignored, ...rest } = attempt;
  return {
    ...rest,
    model: servedModel!,
    price: alternative.billing.price,
    reportsCost: alternative.billing.reportsCost,
    requestedMode: mode,
    ...(unknown !== undefined ? { requestedModeUnknown: unknown } : {}),
  };
}

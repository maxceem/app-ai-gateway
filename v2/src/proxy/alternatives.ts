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
 *   charged, as an estimate, and logged.
 */
import { GatewayError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { modelSet, resolveAlternative, type Billing, type PriceSources } from "../pricing/billability.ts";
import { readingRules, type OperationDescription, type ProviderDescription } from "../providers/operation.ts";
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
 * The model a request is judged and charged as when the provider chooses
 * among the models it names (`providerChoice`): the first model it names
 * besides its own (`alternativeModels`), each of which is judged. That is the
 * case when the request names no model of its own but a list (Perplexity's
 * Agent API reads `models` without `model`), or names a model that asks the
 * provider to choose (`perplexity/auto`). Null when the request's own model
 * is the one to judge.
 *
 * A request that lets the provider choose (a choosing model, or a field such
 * as `effort` that brings its own models) but names no models to choose among
 * is refused: the models it may be served with cannot be judged.
 */
export function chosenAmong(
  description: ProviderDescription,
  operation: OperationDescription,
  body: Record<string, unknown>,
  own: string | undefined,
): string | null {
  const rules = readingRules(description, operation);
  const choice = rules.providerChoice;
  const named = [...namedAlternatives(description, operation, body).keys()];
  const field = choice?.fields?.find((name) => Object.hasOwn(body, name) && body[name] !== undefined && body[name] !== null);
  const choosing = own !== undefined && choice?.models?.includes(own) === true;
  if ((field !== undefined || choosing) && named.length === 0) {
    const where = (rules.alternativeModels?.paths ?? []).map((path) => path.replaceAll("[]", "")).join(" or ");
    throw new GatewayError(
      400,
      "invalid_request",
      `${field ?? own} lets the provider choose the model, so the request must also name the models it may choose among in ${where}`,
    );
  }
  if (own === undefined || choosing) return named[0] ?? null;
  return null;
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
  const named = namedAlternatives(description, operation, body);
  if (named.size === 0) return NONE;
  const judged = new Map<string, Alternative>();
  const allowed = modelSet(policy.allowed);
  for (const [model, field] of named) {
    // Resolved by the one rule saving runs too (`resolveAlternative`).
    const call = resolveAlternative(operation, policy.sources, model, allowed);
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
 * the request did not is logged, and the request's own model is charged.
 */
export function chargedAs(attempt: CallAttempt, servedModel: string | null): CallAttempt {
  const others = attempt.alternatives;
  if (others === undefined || others.size === 0 || servedModel === attempt.model) return attempt;
  const alternative = servedModel === null ? undefined : others.get(servedModel);
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

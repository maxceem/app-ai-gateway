/**
 * Models a request names besides its own, which the provider may serve it
 * with instead (`alternativeModels`, Vercel's fallback models). The one place
 * they are judged and priced, for the proxy path and presets alike:
 *
 * - each must pass the same model policy as the request's own model, and be
 *   billable by the same rule (`../pricing/billability.ts`), or the request
 *   is refused before it spends anything;
 * - the charge is priced at the model the answer says served the request, if
 *   it is one of them (`chargedAs`).
 */
import { GatewayError } from "../core/errors.ts";
import { log } from "../core/log.ts";
import { billing, type Billing, type PriceSources } from "../pricing/billability.ts";
import type { OperationDescription, ProviderDescription } from "../providers/operation.ts";
import { fieldValue } from "../usage/service-modes.ts";
import type { CallAttempt } from "./call-charge.ts";

/** The request's other models, each with how it is billed. Empty when it names none. */
export type Alternatives = ReadonlyMap<string, Billing>;

const NONE: Alternatives = new Map();

/**
 * Judges the models `body` names besides its own. `allowed` is the model
 * policy the request's own model passed: the app's list, or a preset's one
 * model; without it, any model with a price.
 */
export function judgedAlternatives(
  description: ProviderDescription,
  operation: OperationDescription,
  body: Record<string, unknown>,
  policy: { readonly allowed: readonly string[] | undefined; readonly sources: PriceSources },
): Alternatives {
  const field = description.alternativeModels?.field;
  if (field === undefined) return NONE;
  const listed = fieldValue((name) => (Object.hasOwn(body, name) ? body[name] : undefined), field);
  if (listed === undefined || listed === null) return NONE;
  if (!Array.isArray(listed) || !listed.every((model) => typeof model === "string" && model.length > 0)) {
    throw new GatewayError(400, "invalid_request", `${field} must be a list of model ids`);
  }
  const judged = new Map<string, Billing>();
  for (const model of listed as string[]) {
    if (policy.allowed !== undefined && !policy.allowed.includes(model)) {
      throw new GatewayError(403, "model_not_allowed", "Model is not allowed", undefined, { data: { model, field } });
    }
    const bill = billing(operation, policy.sources, model);
    // The request's own model's rule: a model never served is refused; one the
    // app lists by name is served, and priced later if its price has gone.
    if (bill.problem === "wrong_unit" || (bill.problem === "no_price" && policy.allowed === undefined)) {
      throw new GatewayError(400, "pricing_not_configured", `Model ${model} has no price that ${operation.name} can bill`, undefined, {
        data: { model, field },
      });
    }
    judged.set(model, bill);
  }
  return judged;
}

/**
 * The attempt as it is charged: at the model the answer says served it, when
 * that is one of the request's other models. A model the answer names that
 * the request did not is logged, and the request's own model is charged.
 */
export function chargedAs(attempt: CallAttempt, servedModel: string | null): CallAttempt {
  if (servedModel === null || servedModel === attempt.model) return attempt;
  const alternative = attempt.alternatives?.get(servedModel);
  if (alternative === undefined) {
    if (attempt.alternatives !== undefined && attempt.alternatives.size > 0) {
      log("warn", "served_model_unexpected", { app: attempt.appId, providerSlug: attempt.providerSlug, model: attempt.model });
    }
    return attempt;
  }
  return { ...attempt, model: servedModel, price: alternative.price, reportsCost: alternative.reportsCost };
}

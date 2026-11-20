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
import type { OperationDescription, ProviderDescription } from "../providers/operation.ts";
import { fieldValue, type ServiceMode, type ServiceModeValue } from "../usage/service-modes.ts";
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
  const field = description.alternativeModels?.field;
  if (field === undefined) return NONE;
  const listed = fieldValue((name) => (Object.hasOwn(body, name) ? body[name] : undefined), field);
  if (listed === undefined || listed === null) return NONE;
  if (!Array.isArray(listed) || !listed.every((model) => typeof model === "string" && model.length > 0)) {
    throw new GatewayError(400, "invalid_request", `${field} must be a list of model ids`);
  }
  const judged = new Map<string, Alternative>();
  const allowed = modelSet(policy.allowed);
  for (const model of listed as string[]) {
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
    judged.set(model, { billing: bill, requestedMode: requestedServiceMode(description, policy.baseUrl, body, model) });
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

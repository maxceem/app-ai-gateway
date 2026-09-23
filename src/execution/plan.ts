import type { ApiStyle } from "../core/api-styles";
import type { ResolvedProvider } from "../core/provider-store";
import type { PreparedProxyRequest } from "../core/proxyrules";
import type { AttemptAttribution } from "../core/usage-record";

export interface ExecutionRequest {
  body: BodyInit | null;
  headers: Headers;
  query: string;
}

/** One resolved provider call. Canonical attribution lives only on this object. */
export interface ExecutionAttempt {
  readonly resolved: ResolvedProvider;
  readonly providerPath: string;
  readonly model: string;
  /**
   * The API contract this attempt speaks, settled on the way in — from the
   * client's path on the proxy, from the endpoint's own style on a named
   * endpoint. It is what picks the reader that parses the answer, so the
   * response is never sniffed for a shape the request already named.
   */
  readonly apiStyle: ApiStyle;
  readonly buildRequest: () => ExecutionRequest;
}

/**
 * Re-exported so an attempt and what it is recorded as read as one vocabulary
 * here. The shape itself belongs to `src/core/usage-record.ts`: it is the usage
 * row's own, and a core module may not reach into the execution layer for it.
 */
export type { AttemptAttribution };

/**
 * What an attempt says about itself, derived once, so a request refused at the
 * gate and the same request recorded after it are one spelling of one fact
 * rather than two.
 */
export function attemptAttribution(attempt: ExecutionAttempt): AttemptAttribution {
  const { resolved } = attempt;
  return {
    provider: resolved.type,
    providerId: resolved.id,
    providerSlug: resolved.slug,
    providerRoute: resolved.route,
    pricing: resolved.pricing,
    model: attempt.model,
    apiStyle: attempt.apiStyle,
    route: `${resolved.slug}/${attempt.providerPath}`,
  };
}

export interface ExecutionPlan {
  readonly method: string;
  readonly endpointSlug: string | null;
  readonly attempts: readonly [ExecutionAttempt, ...ExecutionAttempt[]];
}

export interface ExecutionVariables {
  executionPlan: ExecutionPlan;
}

/** An attempt whose body was prepared and validated before quota admission. */
export function preparedExecutionAttempt(
  resolved: ResolvedProvider,
  prepared: PreparedProxyRequest,
): ExecutionAttempt {
  return {
    resolved,
    providerPath: prepared.providerPath,
    model: prepared.model,
    apiStyle: prepared.apiStyle,
    buildRequest: () => ({
      body: prepared.body,
      headers: prepared.headers,
      query: prepared.query,
    }),
  };
}

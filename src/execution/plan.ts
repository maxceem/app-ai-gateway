import type { ResolvedProvider } from "../core/provider-store";
import type { PreparedProxyRequest } from "../core/proxyrules";

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
  readonly buildRequest: () => ExecutionRequest;
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
    buildRequest: () => ({
      body: prepared.body,
      headers: prepared.headers,
      query: prepared.query,
    }),
  };
}

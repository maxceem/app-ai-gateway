import { ENDPOINT_SLUG } from "../core/config";
import { prepareEndpointRequest, resolveEndpointAttempts } from "../core/endpointrules";
import { GatewayError } from "../core/errors";
import { requireProvider } from "../core/provider-store";
import { PROVIDER_SLUG_PATTERN } from "../core/providers";
import { prepareProxyRequest } from "../core/proxyrules";
import type { AppRecord, GatewayIdentity } from "../core/types";
import { lookup } from "../shared/records";
import { preparedExecutionAttempt, type ExecutionPlan } from "./plan";

/** What either kind of served request is prepared from. */
export interface PrepareInput {
  env: Env;
  request: Request;
  app: AppRecord;
  identity: GatewayIdentity;
  /** The header the credential arrived in, which is never forwarded upstream. */
  credentialHeader: string;
}

/**
 * A proxied request as one attempt against the provider instance its path
 * names. Everything that can refuse it — the slug, the path, the model, the
 * body — is decided here, before the request is admitted.
 */
export async function prepareProxyPlan(
  input: PrepareInput & { providerSlug: string; path: string },
): Promise<ExecutionPlan> {
  const { providerSlug } = input;
  if (!PROVIDER_SLUG_PATTERN.test(providerSlug)) {
    throw new GatewayError(403, "path_not_allowed", "Provider slug is invalid");
  }
  const marker = `/proxy/${providerSlug}/`;
  const markerIndex = input.path.indexOf(marker);
  const providerPath = markerIndex === -1 ? undefined : input.path.slice(markerIndex + marker.length);
  if (!providerPath) throw new GatewayError(403, "path_not_allowed", "Provider path is required");
  const resolved = await requireProvider(input.env, input.app.organizationId, providerSlug);
  const prepared = await prepareProxyRequest({
    request: input.request,
    app: input.app,
    userId: input.identity.userId,
    resolved,
    providerPath,
    tokenHeader: input.credentialHeader,
  });
  return {
    method: input.request.method,
    endpointSlug: null,
    attempts: [preparedExecutionAttempt(resolved, prepared)],
  };
}

/** A named endpoint as its fallback chain of attempts, primary first. */
export async function prepareEndpointPlan(
  input: PrepareInput & { slug: string },
): Promise<ExecutionPlan> {
  const { app, slug } = input;
  // Own-property lookup only: a path segment must never reach Object.prototype.
  const endpoint = ENDPOINT_SLUG.test(slug) && Object.hasOwn(app.config.endpoints, slug)
    ? lookup(app.config.endpoints, slug)
    : undefined;
  if (!endpoint) {
    throw new GatewayError(404, "endpoint_not_found", "Endpoint is not configured for this app");
  }
  const prepared = await prepareEndpointRequest({
    request: input.request,
    app,
    slug,
    endpoint,
    tokenHeader: input.credentialHeader,
  });
  return {
    method: "POST",
    endpointSlug: slug,
    attempts: await resolveEndpointAttempts(input.env, app, endpoint, prepared),
  };
}

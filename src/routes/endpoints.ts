import { Hono, type MiddlewareHandler } from "hono";
import { ENDPOINT_SLUG } from "../core/config";
import {
  endpointAttemptRequest,
  endpointProviderPath,
  prepareEndpointRequest,
} from "../core/endpointrules";
import { GatewayError } from "../core/errors";
import {
  requireProvider,
  resolveProvider,
  type ResolvedProvider,
} from "../core/provider-store";
import {
  unpricedMessage,
} from "../core/proxyrules";
import { supportsEndpointStyle } from "../core/capabilities";
import { lookup } from "../shared/records";
import { isBillable } from "../core/usage";
import {
  type ExecutionAttempt,
  type ExecutionPlan,
  type ExecutionVariables,
} from "../execution/plan";
import type { GatewayVariables } from "../middleware/auth";
import { executionHandler } from "./execution";

type EndpointEnv = {
  Bindings: Env;
  Variables: GatewayVariables & ExecutionVariables;
};

export const endpointPrepare: MiddlewareHandler<EndpointEnv> = async (c, next) => {
  // Named endpoints are POST-only. Rejecting here keeps other methods from
  // reading a body or reaching the dispatch boundary before the router gives up.
  if (c.req.method !== "POST") {
    throw new GatewayError(404, "invalid_request", "Route not found");
  }
  const identity = c.get("identity");
  if (identity.credentialType === "gateway_token" && !c.req.header("x-app-version")) {
    throw new GatewayError(400, "invalid_request", "X-App-Version header is required");
  }
  const slug = c.req.param("slug") ?? "";
  const app = c.get("app");
  // Own-property lookup only: a path segment must never reach Object.prototype.
  const endpoint = ENDPOINT_SLUG.test(slug) && Object.hasOwn(app.config.endpoints, slug)
    ? lookup(app.config.endpoints, slug)
    : undefined;
  if (!endpoint) {
    throw new GatewayError(404, "endpoint_not_found", "Endpoint is not configured for this app");
  }
  const prepared = await prepareEndpointRequest({
    request: c.req.raw,
    app,
    slug,
    endpoint,
    tokenHeader: c.get("authHeaderName"),
  });

  // Every target needs its own credential, because a fallback may point at a
  // different provider. The primary target must work; a fallback the
  // organization has not configured, cannot decrypt, or cannot price is simply
  // dropped from the chain rather than turned into a request that is certain to
  // fail. Resolution itself can throw — an unreadable secret, or a gateway that
  // was revoked out from under the row — and on a fallback that is still just a
  // reason to skip it.
  //
  // A *disabled* primary is the one exception: disabling is a deliberate pause,
  // so the chain falls through to its fallbacks exactly as an upstream failure
  // would. Only when no fallback survives does the pause itself get reported.
  const resolvedProviders = new Map<string, ResolvedProvider>();
  const usableTargets: typeof prepared.targets = [];
  let disabledPrimary: GatewayError | undefined;
  for (const [index, target] of prepared.targets.entries()) {
    const primary = index === 0;
    let entry = resolvedProviders.get(target.provider);
    if (!entry) {
      let found: ResolvedProvider | null;
      try {
        found = primary
          ? await requireProvider(c.env, app.organizationId, target.provider)
          : await resolveProvider(c.env, app.organizationId, target.provider);
      } catch (error) {
        if (primary) {
          if (error instanceof GatewayError && error.code === "provider_disabled") {
            disabledPrimary = error;
            continue;
          }
          throw error;
        }
        continue;
      }
      if (!found) continue;
      entry = found;
      resolvedProviders.set(target.provider, entry);
    }
    if (!supportsEndpointStyle(entry.route.kind, entry.type, endpoint.api_style)) {
      if (primary) {
        throw new GatewayError(
          502,
          "provider_unavailable",
          `Provider instance ${target.provider} does not support ${endpoint.api_style} endpoints`,
        );
      }
      continue;
    }
    if (!isBillable(entry.type, target.model, entry.pricing)) {
      if (primary) {
        throw new GatewayError(
          400,
          "pricing_not_configured",
          unpricedMessage(entry.type, target.model),
        );
      }
      continue;
    }
    usableTargets.push(target);
  }
  // A skipped disabled primary is the only way the chain can end up empty: on
  // every other primary failure the loop threw above. With nothing left to try,
  // the pause is the answer.
  if (usableTargets.length === 0 && disabledPrimary) throw disabledPrimary;

  const attempts = usableTargets.map((target) => {
    const resolved = resolvedProviders.get(target.provider);
    if (!resolved) throw new Error(`Resolved provider missing for ${target.provider}`);
    const buildRequest = () => endpointAttemptRequest(prepared, target, resolved);
    return {
      resolved,
      providerPath: endpointProviderPath(endpoint.api_style, resolved.type),
      model: target.model,
      buildRequest,
    } satisfies ExecutionAttempt;
  });
  const first = attempts[0];
  if (!first) throw disabledPrimary ?? new Error("Endpoint execution plan is empty");
  // Validate and materialize the primary before admission. Fallback builders
  // stay lazy so a multipart upload is copied only for targets actually tried.
  const primaryRequest = first.buildRequest();
  const primary: ExecutionAttempt = { ...first, buildRequest: () => primaryRequest };
  c.set("executionPlan", {
    method: "POST",
    endpointSlug: slug,
    attempts: [primary, ...attempts.slice(1)],
  } satisfies ExecutionPlan);
  await next();
};

export const endpointRoutes = new Hono<EndpointEnv>();

endpointRoutes.post("/:slug", executionHandler);

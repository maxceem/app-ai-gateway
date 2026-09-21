import { Hono, type MiddlewareHandler } from "hono";
import { ENDPOINT_SLUG } from "../core/config";
import {
  prepareEndpointRequest,
  resolveEndpointAttempts,
} from "../core/endpointrules";
import { GatewayError } from "../core/errors";
import { lookup } from "../shared/records";
import { type ExecutionPlan, type ExecutionVariables } from "../execution/plan";
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
  c.set("executionPlan", {
    method: "POST",
    endpointSlug: slug,
    attempts: await resolveEndpointAttempts(c.env, app, endpoint, prepared),
  } satisfies ExecutionPlan);
  await next();
};

export const endpointRoutes = new Hono<EndpointEnv>();

endpointRoutes.post("/:slug", executionHandler);

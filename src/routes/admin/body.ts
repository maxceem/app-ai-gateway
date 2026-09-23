import type { Context } from "hono";
import { GatewayError } from "../../core/errors";
import type { app } from "../../db/schema";
import type { AdminVariables } from "../../middleware/admin";
import type { ManagementScope } from "../../management/scope";
import type { RequestVariables } from "../../middleware/request-scope";

/**
 * The request's scope, as the management layer takes it.
 *
 * Typed by what it reads rather than by one surface's `Context`, so the admin
 * routes and the CLI handoff routes — which carry different variables — build
 * it the same way.
 */
export function managementScope(c: {
  env: Env;
  get(key: "deployment"): RequestVariables["deployment"];
  get(key: "billingRequestCache"): RequestVariables["billingRequestCache"];
}): ManagementScope {
  return {
    env: c.env,
    deployment: c.get("deployment"),
    billingCache: c.get("billingRequestCache"),
  };
}

/**
 * The request's JSON, or the refusal that says it was not JSON.
 *
 * One reader for every route that takes a body, so an unparseable request is
 * refused with the same sentence wherever it arrives. What the parsed value
 * has to *be* is a schema's business — see `schemaBody`.
 *
 * Typed by what it uses rather than by one surface's `Context`, so the
 * application-authentication routes, which carry different variables, read
 * their bodies through it too.
 */
export async function jsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new GatewayError(400, "invalid_request", "A JSON object is required");
  }
}

/**
 * The application an `/apps/:app` route is about, which the admin scope has
 * already found in the caller's account. Its absence means a route was mounted
 * outside that scope, which is a bug here rather than a request to refuse.
 */
export function scopedApp(c: Context<{ Bindings: Env; Variables: AdminVariables }>): typeof app.$inferSelect {
  const row = c.get("adminApp");
  if (!row) throw new GatewayError(500, "internal_error", "Route is not scoped to an application");
  return row;
}

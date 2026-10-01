import { identityAuthFor, MANAGEMENT_IDENTITY } from "../../auth/identity";
import { GatewayError } from "../../core/errors";
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
  req: { url: string };
  get(key: "deployment"): RequestVariables["deployment"];
  get(key: "billingRequestCache"): RequestVariables["billingRequestCache"];
  get(key: "identityAuthCache"): RequestVariables["identityAuthCache"];
}): ManagementScope {
  return {
    env: c.env,
    deployment: c.get("deployment"),
    billingCache: c.get("billingRequestCache"),
    // Memoised by the request's own cache, so every caller in the request —
    // the CLI's routes, a management service, the MCP server — shares one
    // build. It never provisions an account as a side effect: nothing on the
    // management surface registers anybody.
    identity: () => identityAuthFor(c, MANAGEMENT_IDENTITY),
  };
}

/**
 * The request's JSON, or the refusal that says it was not JSON.
 *
 * One reader for every route that takes a body, so an unparseable request is
 * refused with the same sentence wherever it arrives. What the parsed value
 * has to *be* is a schema's business — see `parseRequest`.
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

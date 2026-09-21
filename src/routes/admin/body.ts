import type { Context } from "hono";
import { GatewayError } from "../../core/errors";
import type { AdminVariables } from "../../middleware/admin";

type AdminEnv = { Bindings: Env; Variables: AdminVariables };

/**
 * The request's JSON, or the refusal that says it was not JSON.
 *
 * One reader for every admin route that takes a body, so an unparseable
 * request is refused with the same sentence wherever it arrives. What the
 * parsed value has to *be* is a schema's business — see `schemaBody`.
 */
export async function jsonBody(c: Context<AdminEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new GatewayError(400, "invalid_request", "A JSON object is required");
  }
}

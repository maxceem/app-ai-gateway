import type { Context } from "hono";
import { GatewayError } from "../../core/errors";
import type { AdminVariables } from "../../middleware/admin";

type AdminEnv = { Bindings: Env; Variables: AdminVariables };

export async function providerRequestBody(c: Context<AdminEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new GatewayError(400, "invalid_request", "A JSON object is required");
  }
}

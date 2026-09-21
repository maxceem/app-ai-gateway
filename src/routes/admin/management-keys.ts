import { Hono } from "hono";
import { identityAuthFor } from "../../auth/identity";
import { ManagementKeyCreateRequestSchema } from "../../contracts/schemas";
import { schemaBody } from "../../management/validation";
import { jsonBody } from "./body";
import { adminRouter } from "../catalog-router";
import { GatewayError } from "../../core/errors";
import type { AdminVariables } from "../../middleware/admin";

/**
 * Session-only surface. A management key carries full account administration,
 * and every key is equal: one could mint a replacement that survives revoking
 * the original, so handing a key to an outside system would hand over more than
 * the key itself. Reading and revoking are closed too, so the rule is one line
 * to state — management keys are administered by a person, in the console.
 *
 * That rule is `security: "session"` on the three catalog entries, and the
 * router enforces it; nothing is restated here.
 */
export const managementKeyRoutes = new Hono<{
  Bindings: Env;
  Variables: AdminVariables;
}>();
const routes = adminRouter(managementKeyRoutes);

routes.handle("listManagementKeys", async (c) => {
  const keys = await identityAuthFor(c).service.listApiKeys({
    actor: c.get("authState"),
    organizationId: c.get("actor").organizationId,
  });
  return { keys };
});

routes.handle("createManagementKey", async (c) => {
  const key = await identityAuthFor(c).service.createApiKey({
    actor: c.get("authState"),
    organizationId: c.get("actor").organizationId,
    name: schemaBody(ManagementKeyCreateRequestSchema, await jsonBody(c)).name,
  });
  return { key };
});

routes.handle("revokeManagementKey", async (c) => {
  const key = await identityAuthFor(c).service.revokeApiKey({
    actor: c.get("authState"),
    organizationId: c.get("actor").organizationId,
    apiKeyId: c.req.param("id"),
  });
  if (!key) throw new GatewayError(404, "not_found", "Management key was not found");
  return { key };
});

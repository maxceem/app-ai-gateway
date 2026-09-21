import { Hono } from "hono";
import { rethrowCfAuthError } from "../../auth/identity";
import { ManagementKeyCreateRequestSchema } from "../../contracts/schemas";
import { schemaBody } from "../../management/validation";
import { jsonBody } from "./body";
import { catalogRouter } from "../catalog-router";
import { GatewayError } from "../../core/errors";
import type { AdminVariables } from "../../middleware/admin";

/**
 * Session-only surface. A management key carries full account administration,
 * and every key is equal: one could mint a replacement that survives revoking
 * the original, so handing a key to an outside system would hand over more than
 * the key itself. Reading and revoking are closed too, so the rule is one line
 * to state — management keys are administered by a person, in the console.
 *
 * Guarding each handler rather than mounting middleware: these routes join the
 * admin app at `/`, so a `use("*")` here would answer for every admin path.
 */
function requireSession(admin: AdminVariables["admin"]): void {
  if (admin.credentialType !== "session") {
    throw new GatewayError(
      403,
      "session_required",
      "Management keys can only be administered from a user session",
    );
  }
}

export const managementKeyRoutes = new Hono<{
  Bindings: Env;
  Variables: AdminVariables;
}>();
const routes = catalogRouter(managementKeyRoutes, "/v1/admin");

routes.handle("listManagementKeys", async (c) => {
  requireSession(c.get("admin"));
  try {
    const keys = await c.get("identityAuth").service.listApiKeys({
      actor: c.get("authState"),
      organizationId: c.get("admin").organizationId,
    });
    return { keys };
  } catch (error) {
    rethrowCfAuthError(error);
  }
});

routes.handle("createManagementKey", async (c) => {
  requireSession(c.get("admin"));
  try {
    const key = await c.get("identityAuth").service.createApiKey({
      actor: c.get("authState"),
      organizationId: c.get("admin").organizationId,
      name: schemaBody(ManagementKeyCreateRequestSchema, await jsonBody(c)).name,
    });
    return { key };
  } catch (error) {
    rethrowCfAuthError(error);
  }
});

routes.handle("revokeManagementKey", async (c) => {
  requireSession(c.get("admin"));
  try {
    const key = await c.get("identityAuth").service.revokeApiKey({
      actor: c.get("authState"),
      organizationId: c.get("admin").organizationId,
      apiKeyId: c.req.param("id"),
    });
    if (!key) throw new GatewayError(404, "not_found", "Management key was not found");
    return { key };
  } catch (error) {
    rethrowCfAuthError(error);
  }
});

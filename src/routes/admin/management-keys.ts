import { Hono } from "hono";
import { identityAuthFor } from "../../auth/identity";
import { adminRouter } from "../catalog-router";
import { GatewayError } from "../../core/errors";
import type { AdminVariables } from "../../middleware/admin";

/**
 * Session-only surface. A `manage` management key carries full account
 * administration: one could mint a replacement that survives revoking the
 * original, so handing a key to an outside system would hand over more than
 * the key itself. A `read` key could mint nothing at all, but keeping keys out
 * of the reach of every key is simpler than a rule per grant. Reading and revoking are closed too, so the rule is one line
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
  const keys = await (await identityAuthFor(c)).service.listApiKeys({
    actor: c.get("authState"),
    organizationId: c.get("actor").organizationId,
  });
  return { keys };
});

routes.handle("createManagementKey", async (c, { actor, body }) => {
  const key = await (await identityAuthFor(c)).service.createApiKey({
    actor: c.get("authState"),
    organizationId: actor.organizationId,
    name: body.name,
    grant: body.grant,
    // Said rather than left to the library's default: the list shows where
    // each key came from, and a key minted here came from the console.
    source: "console",
  });
  return { key };
});

routes.handle("revokeManagementKey", async (c, { actor, params }) => {
  const key = await (await identityAuthFor(c)).service.revokeApiKey({
    actor: c.get("authState"),
    organizationId: actor.organizationId,
    apiKeyId: params.id,
  });
  if (!key) throw new GatewayError(404, "not_found", "Management key was not found");
  return { key };
});

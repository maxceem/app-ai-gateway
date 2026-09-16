import { Hono } from "hono";
import { rethrowCfAuthError } from "../../auth/identity";
import { GatewayError } from "../../core/errors";
import type {
  CreatedManagementKeyResponse,
  ManagementKeyListResponse,
  ManagementKeyResponse,
} from "../../contracts/responses";
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

function keyName(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GatewayError(400, "invalid_request", "A JSON object is required");
  }
  const name = (value as Record<string, unknown>).name;
  if (typeof name !== "string" || name.trim().length === 0 || name.trim().length > 100) {
    throw new GatewayError(400, "invalid_request", "name must be 1-100 characters");
  }
  return name.trim();
}

export const managementKeyRoutes = new Hono<{
  Bindings: Env;
  Variables: AdminVariables;
}>();

managementKeyRoutes.get("/keys", async (c) => {
  requireSession(c.get("admin"));
  try {
    const keys = await c.get("identityAuth").service.listApiKeys({
      actor: c.get("authState"),
      organizationId: c.get("admin").organizationId,
    });
    return c.json({ keys } satisfies ManagementKeyListResponse);
  } catch (error) {
    rethrowCfAuthError(error);
  }
});

managementKeyRoutes.post("/keys", async (c) => {
  requireSession(c.get("admin"));
  try {
    const key = await c.get("identityAuth").service.createApiKey({
      actor: c.get("authState"),
      organizationId: c.get("admin").organizationId,
      name: keyName(await c.req.json()),
    });
    return c.json({ key } satisfies CreatedManagementKeyResponse, 201);
  } catch (error) {
    rethrowCfAuthError(error);
  }
});

managementKeyRoutes.post("/keys/:id/revoke", async (c) => {
  requireSession(c.get("admin"));
  try {
    const key = await c.get("identityAuth").service.revokeApiKey({
      actor: c.get("authState"),
      organizationId: c.get("admin").organizationId,
      apiKeyId: c.req.param("id"),
    });
    if (!key) throw new GatewayError(404, "not_found", "Management key was not found");
    return c.json({ key } satisfies ManagementKeyResponse);
  } catch (error) {
    rethrowCfAuthError(error);
  }
});

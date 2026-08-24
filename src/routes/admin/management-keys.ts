import { Hono } from "hono";
import { rethrowCfAuthError } from "../../auth/operator";
import { GatewayError } from "../../core/errors";
import type { AdminVariables } from "../../middleware/admin";

function sessionActor(admin: AdminVariables["admin"]): string {
  if (admin.credentialType !== "session") {
    throw new GatewayError(
      403,
      "session_required",
      "Management keys can only be administered from a user session",
    );
  }
  return admin.userId;
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
  const actorUserId = sessionActor(c.get("admin"));
  try {
    const keys = await c.get("operatorAuth").service.listApiKeys({
      actorUserId,
      organizationId: c.get("admin").organizationId,
    });
    return c.json({ keys });
  } catch (error) {
    rethrowCfAuthError(error);
  }
});

managementKeyRoutes.post("/keys", async (c) => {
  const actorUserId = sessionActor(c.get("admin"));
  try {
    const key = await c.get("operatorAuth").service.createApiKey({
      actorUserId,
      organizationId: c.get("admin").organizationId,
      name: keyName(await c.req.json()),
    });
    return c.json({ key }, 201);
  } catch (error) {
    rethrowCfAuthError(error);
  }
});

managementKeyRoutes.post("/keys/:id/revoke", async (c) => {
  const actorUserId = sessionActor(c.get("admin"));
  try {
    const key = await c.get("operatorAuth").service.revokeApiKey({
      actorUserId,
      organizationId: c.get("admin").organizationId,
      apiKeyId: c.req.param("id"),
    });
    if (!key) throw new GatewayError(404, "not_found", "Management key was not found");
    return c.json({ key });
  } catch (error) {
    rethrowCfAuthError(error);
  }
});

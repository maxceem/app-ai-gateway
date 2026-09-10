import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { generateApiKey } from "../../core/apikeys";
import { loadAppConfig } from "../../core/config";
import { GatewayError } from "../../core/errors";
import { database } from "../../db";
import { appApiKey } from "../../db/schema";
import type { AdminVariables } from "../../middleware/admin";

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

async function assertApiKeyApp(env: Env, appId: string): Promise<void> {
  const app = await loadAppConfig(env, appId);
  if (app.authentication.type !== "api_key") {
    throw new GatewayError(400, "invalid_request", "API keys can only be managed for api_key apps");
  }
}

function serialized(row: typeof appApiKey.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.keyPrefix,
    status: row.status,
    created_at: row.createdAt,
    last_used_at: row.lastUsedAt,
  };
}

export const keyRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>();

keyRoutes.post("/apps/:app/keys", async (c) => {
  const appId = c.req.param("app");
  await assertApiKeyApp(c.env, appId);
  const name = keyName(await c.req.json());
  const generated = await generateApiKey();
  const [row] = await database(c.env.DB)
    .insert(appApiKey)
    .values({
      id: generated.id,
      appId,
      name,
      keyHash: generated.keyHash,
      keyPrefix: generated.keyPrefix,
    })
    .returning();
  return c.json({
    id: row!.id,
    name: row!.name,
    key: generated.key,
    key_prefix: row!.keyPrefix,
    created_at: row!.createdAt,
  }, 201);
});

keyRoutes.get("/apps/:app/keys", async (c) => {
  const appId = c.req.param("app");
  await assertApiKeyApp(c.env, appId);
  const rows = await database(c.env.DB)
    .select()
    .from(appApiKey)
    .where(eq(appApiKey.appId, appId))
    .orderBy(desc(appApiKey.createdAt));
  return c.json({ app_id: appId, keys: rows.map(serialized) });
});

keyRoutes.post("/apps/:app/keys/:id/revoke", async (c) => {
  const appId = c.req.param("app");
  await assertApiKeyApp(c.env, appId);
  const [row] = await database(c.env.DB)
    .update(appApiKey)
    .set({ status: "revoked" })
    .where(and(eq(appApiKey.appId, appId), eq(appApiKey.id, c.req.param("id"))))
    .returning();
  if (!row) throw new GatewayError(404, "invalid_request", "API key was not found");
  return c.json({ app_id: appId, key: serialized(row) });
});

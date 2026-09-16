import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { generateApiKey } from "../../core/apikeys";
import { loadAppConfig } from "../../core/config";
import { GatewayError } from "../../core/errors";
import { andCondition, planCap } from "../../core/plan-caps";
import { prepareResourceReceipt } from "../../core/resource-receipt";
import { database } from "../../db";
import { appApiKey } from "../../db/schema";
import type {
  ApiKey,
  ApiKeyListResponse,
  ApiKeyRevokeResponse,
  CreatedApiKey,
} from "../../contracts/responses";
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

function serialized(row: typeof appApiKey.$inferSelect): ApiKey {
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
  const receipt = await prepareResourceReceipt(c, "app.key.add", { name });
  if (receipt?.result) return c.json(receipt.result, 201);
  const generated = await generateApiKey();
  const now = new Date().toISOString();
  const outcome: CreatedApiKey = {
    id: generated.id, name, key: generated.key,
    key_prefix: generated.keyPrefix, created_at: now,
  };
  const organizationId = c.get("admin").organizationId;
  const cap = await planCap(c.env, "appKey", organizationId, c.get("billingRequestCache"), appId);
  const condition = andCondition(receipt?.condition, cap.condition);
  const statement = c.env.DB.prepare(
    `INSERT INTO app_api_key(id,app_id,name,key_hash,key_prefix,status,created_at)
     SELECT ?,?,?,?,?,'active',? WHERE ${condition.sql}
     AND EXISTS (SELECT 1 FROM app WHERE id = ? AND organization_id = ?
       AND json_extract(config_json,'$.authentication.type') = 'api_key')`,
  ).bind(generated.id, appId, name, generated.keyHash, generated.keyPrefix, now,
    ...condition.params, appId, organizationId);
  // Every guard on this statement refuses the same way — no rows changed — so
  // the cap is asked whether it is the one that did before the generic answer.
  if (receipt) {
    try {
      await receipt.commit(statement, outcome);
    } catch (error) {
      await cap.assertNotReached();
      throw error;
    }
  } else {
    const result = await statement.run();
    if (result.meta.changes !== 1) {
      await cap.assertNotReached();
      throw new GatewayError(409, "conflict", "The application changed before key creation");
    }
  }
  return c.json(receipt?.result ?? outcome, 201);
});

keyRoutes.get("/apps/:app/keys", async (c) => {
  const appId = c.req.param("app");
  await assertApiKeyApp(c.env, appId);
  const rows = await database(c.env.DB)
    .select()
    .from(appApiKey)
    .where(eq(appApiKey.appId, appId))
    .orderBy(desc(appApiKey.createdAt));
  return c.json({ app_id: appId, keys: rows.map(serialized) } satisfies ApiKeyListResponse);
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
  return c.json({ app_id: appId, key: serialized(row) } satisfies ApiKeyRevokeResponse);
});

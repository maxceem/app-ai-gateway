import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { generateApiKey } from "../../core/apikeys";
import { ApiKeyCreateRequestSchema } from "../../contracts/schemas";
import { schemaBody } from "../../management/validation";
import { jsonBody } from "./body";
import { catalogRouter } from "../catalog-router";
import { GatewayError } from "../../core/errors";
import { andCondition, planCap } from "../../core/plan-caps";
import { prepareResourceReceipt } from "./resource-receipt";
import { database } from "../../db";
import { appApiKey } from "../../db/schema";
import type { ApiKey, CreatedApiKey } from "../../contracts/responses";
import type { AdminVariables } from "../../middleware/admin";

/**
 * Read off the column rather than the configuration: what kind of application
 * this is does not need the whole grammar run over it, and a row whose stored
 * configuration no longer parses is still unambiguously one kind or the other.
 */
function assertApiKeyApp(row: AdminVariables["adminApp"]): void {
  if (!row) throw new GatewayError(404, "app_not_found", "App is not registered");
  if (row.authType !== "api_key") {
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
const routes = catalogRouter(keyRoutes, "/v1/admin");

routes.handle("createAppKey", async (c) => {
  const appId = c.req.param("app");
  assertApiKeyApp(c.get("adminApp"));
  const { name } = schemaBody(ApiKeyCreateRequestSchema, await jsonBody(c));
  const receipt = await prepareResourceReceipt(c, "app.key.add", { name });
  if (receipt?.result) return receipt.result as CreatedApiKey;
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
       AND auth_type = 'api_key')`,
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
  return (receipt?.result as CreatedApiKey | undefined) ?? outcome;
});

routes.handle("listAppKeys", async (c) => {
  const appId = c.req.param("app");
  assertApiKeyApp(c.get("adminApp"));
  const rows = await database(c.env.DB)
    .select()
    .from(appApiKey)
    .where(eq(appApiKey.appId, appId))
    .orderBy(desc(appApiKey.createdAt));
  return { app_id: appId, keys: rows.map(serialized) };
});

routes.handle("revokeAppKey", async (c) => {
  const appId = c.req.param("app");
  assertApiKeyApp(c.get("adminApp"));
  const [row] = await database(c.env.DB)
    .update(appApiKey)
    .set({ status: "revoked" })
    .where(and(eq(appApiKey.appId, appId), eq(appApiKey.id, c.req.param("key"))))
    .returning();
  if (!row) throw new GatewayError(404, "invalid_request", "API key was not found");
  return { app_id: appId, key: serialized(row) };
});

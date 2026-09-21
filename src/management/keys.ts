import { and, desc, eq } from "drizzle-orm";
import { ApiKeyCreateRequestSchema } from "../contracts/schemas";
import type {
  ApiKey,
  ApiKeyListResponse,
  ApiKeyRevokeResponse,
  CreatedApiKey,
} from "../contracts/responses";
import { generateApiKey } from "../core/apikeys";
import { GatewayError } from "../core/errors";
import { database } from "../db";
import { appApiKey, type app } from "../db/schema";
import type { Actor } from "./actor";
import { planCap } from "./plan-caps";
import type { ManagementScope } from "./scope";
import { schemaBody } from "./validation";
import { commitResourceWrite, type ResourceWriteBoundary } from "./write-boundary";

type AppRow = typeof app.$inferSelect;

/**
 * Read off the column rather than the configuration: what kind of application
 * this is does not need the whole grammar run over it, and a row whose stored
 * configuration no longer parses is still unambiguously one kind or the other.
 */
function apiKeyApp(row: AppRow | undefined): AppRow {
  if (!row) throw new GatewayError(404, "app_not_found", "App is not registered");
  if (row.authType !== "api_key") {
    throw new GatewayError(400, "invalid_request", "API keys can only be managed for api_key apps");
  }
  return row;
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

export async function createAppKey(
  scope: ManagementScope,
  actor: Actor,
  appRow: AppRow | undefined,
  input: unknown,
  boundary?: ResourceWriteBoundary,
): Promise<CreatedApiKey> {
  const appId = apiKeyApp(appRow).id;
  const { name } = schemaBody(ApiKeyCreateRequestSchema, input);
  const generated = await generateApiKey();
  const now = new Date().toISOString();
  const outcome: CreatedApiKey = {
    id: generated.id, name, key: generated.key,
    key_prefix: generated.keyPrefix, created_at: now,
  };
  const organizationId = actor.organizationId;
  const cap = await planCap(scope, "appKey", organizationId, appId);
  // The app is still this organization's api_key app, the plan still has room
  // for another active key, and whatever boundary this runs under still holds:
  // all three are conditions on the one insert, so a concurrent change cannot
  // land between the check and the write.
  await commitResourceWrite(
    scope,
    `INSERT INTO app_api_key(id,app_id,name,key_hash,key_prefix,status,created_at)
     SELECT ?,?,?,?,?,'active',?
     WHERE EXISTS (SELECT 1 FROM app WHERE id = ? AND organization_id = ?
       AND auth_type = 'api_key')
     AND /* authorization */`,
    [generated.id, appId, name, generated.keyHash, generated.keyPrefix, now,
      appId, organizationId],
    outcome,
    boundary,
    cap,
  );
  return outcome;
}

export async function listAppKeys(
  scope: ManagementScope,
  appRow: AppRow | undefined,
): Promise<ApiKeyListResponse> {
  const appId = apiKeyApp(appRow).id;
  const rows = await database(scope.env.DB)
    .select()
    .from(appApiKey)
    .where(eq(appApiKey.appId, appId))
    .orderBy(desc(appApiKey.createdAt));
  return { app_id: appId, keys: rows.map(serialized) };
}

export async function revokeAppKey(
  scope: ManagementScope,
  appRow: AppRow | undefined,
  keyId: string,
): Promise<ApiKeyRevokeResponse> {
  const appId = apiKeyApp(appRow).id;
  const [row] = await database(scope.env.DB)
    .update(appApiKey)
    .set({ status: "revoked" })
    .where(and(eq(appApiKey.appId, appId), eq(appApiKey.id, keyId)))
    .returning();
  if (!row) throw new GatewayError(404, "not_found", "API key was not found");
  return { app_id: appId, key: serialized(row) };
}

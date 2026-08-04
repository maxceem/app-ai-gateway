import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { generateDevelopmentCredential } from "../../core/development-credentials";
import { invalidateAppConfig } from "../../core/config";
import { GatewayError } from "../../core/errors";
import { database } from "../../db";
import { apps, developmentCredentials } from "../../db/schema";
import type { AdminVariables } from "../../middleware/admin";
import type { StoredAppConfig } from "../../core/types";

async function appRow(env: Env, appId: string) {
  const row = await database(env.DB).query.apps.findFirst({ where: eq(apps.id, appId) });
  if (!row) throw new GatewayError(404, "app_not_found", "App is not registered");
  if (row.config.authentication.type !== "apple_app_attest") {
    throw new GatewayError(400, "invalid_request", "Development credentials require an App Attest app");
  }
  return row;
}

function withDevelopmentAccess(config: StoredAppConfig, enabled: boolean): StoredAppConfig {
  if (config.authentication.type !== "apple_app_attest") return config;
  return {
    ...config,
    authentication: { ...config.authentication, development_access: enabled },
  };
}

function serialized(row: typeof developmentCredentials.$inferSelect) {
  return {
    enabled: true,
    secret_prefix: row.secretPrefix,
    created_at: row.createdAt,
    rotated_at: row.rotatedAt,
  };
}

export const developmentCredentialRoutes = new Hono<{
  Bindings: Env;
  Variables: AdminVariables;
}>();

developmentCredentialRoutes.get("/apps/:app/development-credential", async (c) => {
  const appId = c.req.param("app");
  await appRow(c.env, appId);
  const row = await database(c.env.DB).query.developmentCredentials.findFirst({
    where: eq(developmentCredentials.appId, appId),
  });
  return c.json(row
    ? serialized(row)
    : { enabled: false, secret_prefix: null, created_at: null, rotated_at: null },
  );
});

developmentCredentialRoutes.post("/apps/:app/development-credential", async (c) => {
  const appId = c.req.param("app");
  const app = await appRow(c.env, appId);
  const generated = await generateDevelopmentCredential();
  const [credential] = await database(c.env.DB)
    .insert(developmentCredentials)
    .values({
      appId,
      secretHash: generated.secretHash,
      secretPrefix: generated.secretPrefix,
    })
    .onConflictDoNothing({ target: developmentCredentials.appId })
    .returning();
  if (!credential) {
    throw new GatewayError(409, "invalid_request", "A development credential already exists; rotate it instead");
  }
  await database(c.env.DB)
    .update(apps)
    .set({ config: withDevelopmentAccess(app.config, true), updatedAt: new Date().toISOString() })
    .where(eq(apps.id, appId));
  invalidateAppConfig(appId);
  return c.json({ ...serialized(credential), secret: generated.secret }, 201);
});

developmentCredentialRoutes.post("/apps/:app/development-credential/rotate", async (c) => {
  const appId = c.req.param("app");
  const app = await appRow(c.env, appId);
  if (
    app.config.authentication.type !== "apple_app_attest"
    || !app.config.authentication.development_access
  ) {
    throw new GatewayError(400, "invalid_request", "Development access is disabled");
  }
  const generated = await generateDevelopmentCredential();
  const [credential] = await database(c.env.DB)
    .update(developmentCredentials)
    .set({
      secretHash: generated.secretHash,
      secretPrefix: generated.secretPrefix,
      rotatedAt: sql`datetime('now')`,
    })
    .where(eq(developmentCredentials.appId, appId))
    .returning();
  if (!credential) throw new GatewayError(404, "invalid_request", "Development credential was not found");
  return c.json({ ...serialized(credential), secret: generated.secret });
});

developmentCredentialRoutes.delete("/apps/:app/development-credential", async (c) => {
  const appId = c.req.param("app");
  const app = await appRow(c.env, appId);
  await database(c.env.DB)
    .delete(developmentCredentials)
    .where(eq(developmentCredentials.appId, appId));
  await database(c.env.DB)
    .update(apps)
    .set({ config: withDevelopmentAccess(app.config, false), updatedAt: new Date().toISOString() })
    .where(eq(apps.id, appId));
  invalidateAppConfig(appId);
  return c.json({ enabled: false });
});

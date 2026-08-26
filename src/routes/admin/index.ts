import { and, eq } from "drizzle-orm";
import { Hono, type Context, type Next } from "hono";
import prices from "../../core/prices.json";
import { GatewayError } from "../../core/errors";
import { database } from "../../db";
import { app } from "../../db/schema";
import type { AdminVariables } from "../../middleware/admin";
import { appRoutes } from "./apps";
import { keyRoutes } from "./keys";
import { usageRoutes } from "./usage";
import { userRoutes } from "./users";
import { managementKeyRoutes } from "./management-keys";
import { organizationRoutes } from "./organizations";
import { billingRoutes } from "./billing";
import { billingBinding } from "../../billing/gateway";

type AdminEnv = { Bindings: Env; Variables: AdminVariables };

export const adminRoutes = new Hono<AdminEnv>();

async function scopeAdminApp(c: Context<AdminEnv>, next: Next) {
  const appId = c.req.param("app");
  if (!appId) throw new GatewayError(404, "app_not_found", "App is not registered");
  const organizationId = c.get("admin").organizationId;
  const row = await database(c.env.DB).query.app.findFirst({
    where: and(eq(app.id, appId), eq(app.organizationId, organizationId)),
  });

  if (!row) {
    const validationOnly = c.req.method === "POST" && c.req.path.endsWith("/validate");
    const upsertOnly = (c.req.method === "POST" || c.req.method === "PUT")
      && c.req.path === `/v1/admin/apps/${appId}`;
    if (validationOnly || upsertOnly) {
      const occupied = await database(c.env.DB).query.app.findFirst({
        columns: { id: true },
        where: eq(app.id, appId),
      });
      if (!occupied) {
        await next();
        return;
      }
    }
    throw new GatewayError(404, "app_not_found", "App is not registered");
  }

  c.set("adminApp", row);
  await next();
}

adminRoutes.use("/apps/:app", scopeAdminApp);
adminRoutes.use("/apps/:app/*", scopeAdminApp);
adminRoutes.use("/billing/*", async (c, next) => {
  if (!billingBinding(c.env)) {
    throw new GatewayError(404, "not_found", "Billing is not configured");
  }
  await next();
});

/** Supplies the priced model catalog used by the proxy-policy editor. */
adminRoutes.get("/prices", (c) => c.json({ prices }));

adminRoutes.route("/", appRoutes);
adminRoutes.route("/", keyRoutes);
adminRoutes.route("/", userRoutes);
adminRoutes.route("/", usageRoutes);
adminRoutes.route("/", managementKeyRoutes);
adminRoutes.route("/", organizationRoutes);
adminRoutes.route("/billing", billingRoutes);

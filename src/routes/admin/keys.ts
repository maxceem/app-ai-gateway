import { Hono } from "hono";
import { createAppKey, listAppKeys, revokeAppKey } from "../../management/keys";
import type { AdminVariables } from "../../middleware/admin";
import { adminRouter } from "../catalog-router";
import { jsonBody, managementScope } from "./body";
import { receipted } from "./receipted";

export const keyRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>();
const routes = adminRouter(keyRoutes);

routes.handle("createAppKey", async (c) => {
  const body = await jsonBody(c);
  return receipted(c, "app.key.add", body, (boundary) =>
    createAppKey(managementScope(c), c.get("actor"), c.get("adminApp"), body, boundary));
});

routes.handle("listAppKeys", (c) => listAppKeys(managementScope(c), c.get("adminApp")));

routes.handle("revokeAppKey", (c) =>
  revokeAppKey(managementScope(c), c.get("adminApp"), c.req.param("key")));

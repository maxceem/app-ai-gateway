import { Hono } from "hono";
import { createAppKey, listAppKeys, revokeAppKey } from "../../management/keys";
import type { AdminVariables } from "../../middleware/admin";
import { adminRouter } from "../catalog-router";

export const keyRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>();
const routes = adminRouter(keyRoutes);

routes.handle("createAppKey", (_c, { scope, actor, app, body }) => createAppKey(scope, actor, app, body));

routes.handle("listAppKeys", (_c, { scope, actor, app }) => listAppKeys(scope, actor, app));

routes.handle("revokeAppKey", (c, { scope, actor, app }) =>
  revokeAppKey(scope, actor, app, c.req.param("key")));

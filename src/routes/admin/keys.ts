import { Hono } from "hono";
import { createAppKey, listAppKeys, revokeAppKey } from "../../management/keys";
import type { AdminVariables } from "../../middleware/admin";
import { adminRouter } from "../catalog-router";
import { jsonBody, managementScope, scopedApp } from "./body";

export const keyRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>();
const routes = adminRouter(keyRoutes);

routes.handle("createAppKey", async (c) =>
  createAppKey(managementScope(c), c.get("actor"), scopedApp(c), await jsonBody(c)));

routes.handle("listAppKeys", (c) => listAppKeys(managementScope(c), scopedApp(c)));

routes.handle("revokeAppKey", (c) =>
  revokeAppKey(managementScope(c), scopedApp(c), c.req.param("key")));

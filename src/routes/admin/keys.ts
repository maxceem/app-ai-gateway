import { Hono } from "hono";
import { createAppKey, listAppKeys, revokeAppKey } from "../../management/keys";
import type { AdminVariables } from "../../middleware/admin";
import { adminRouter } from "../catalog-router";
import { managementScope, scopedApp } from "./body";

export const keyRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>();
const routes = adminRouter(keyRoutes);

routes.handleReceipted("createAppKey", (c, { body, boundary }) =>
  createAppKey(managementScope(c), c.get("actor"), scopedApp(c), body, boundary));

routes.handle("listAppKeys", (c) => listAppKeys(managementScope(c), scopedApp(c)));

routes.handle("revokeAppKey", (c) =>
  revokeAppKey(managementScope(c), scopedApp(c), c.req.param("key")));

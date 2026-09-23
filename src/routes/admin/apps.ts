import { Hono } from "hono";
import {
  createApp,
  deleteApp,
  getApp,
  listApps,
  updateApp,
  validateApp,
} from "../../management/apps";
import { currentMonth } from "../../management/usage-queries";
import type { AdminVariables } from "../../middleware/admin";
import { adminRouter } from "../catalog-router";
import { jsonBody, managementScope } from "./body";
import { receipted } from "./receipted";

export const appRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>();
const routes = adminRouter(appRoutes);

routes.handle("listApps", (c, { query }) =>
  listApps(managementScope(c), c.get("actor"), query.month ?? currentMonth()));

routes.handle("createApp", async (c) => {
  const body = await jsonBody(c);
  return receipted(c, "app.add", body, (boundary) =>
    createApp(managementScope(c), c.get("actor"), body, boundary));
});

routes.handle("getApp", (c) => getApp(c.get("adminApp")));

routes.handle("validateApp", async (c) =>
  validateApp(
    managementScope(c),
    c.get("actor"),
    c.req.param("app"),
    await jsonBody(c),
    c.get("adminApp"),
  ));

routes.handle("updateApp", async (c) =>
  updateApp(
    managementScope(c),
    c.get("actor"),
    c.req.param("app"),
    await jsonBody(c),
    c.get("adminApp"),
  ));

routes.handle("deleteApp", (c, { query }) =>
  deleteApp(managementScope(c), c.get("actor"), c.req.param("app"), query.confirm));

import { Hono } from "hono";
import {
  createApp,
  deleteApp,
  getApp,
  listApps,
  updateApp,
  validateApp,
  validateAppDraft,
} from "../../management/apps";
import { currentMonth } from "../../management/usage-queries";
import type { AdminVariables } from "../../middleware/admin";
import { adminRouter } from "../catalog-router";

export const appRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>();
const routes = adminRouter(appRoutes);

routes.handle("listApps", (_c, { scope, actor, query }) =>
  listApps(scope, actor, query.month ?? currentMonth()));

routes.handle("createApp", (_c, { scope, actor, body }) => createApp(scope, actor, body));

routes.handle("getApp", (_c, { scope, actor, app }) => getApp(scope, actor, app));

routes.handle("validateApp", (_c, { scope, actor, app, body }) => validateApp(scope, actor, app, body));

routes.handle("validateAppDraft", (_c, { scope, actor, body }) => validateAppDraft(scope, actor, body));

routes.handle("updateApp", (_c, { scope, actor, app, body }) => updateApp(scope, actor, app, body));

routes.handle("deleteApp", (_c, { scope, actor, app, query }) =>
  deleteApp(scope, actor, app, query.confirm));

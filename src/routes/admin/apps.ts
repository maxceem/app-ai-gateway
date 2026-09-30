import { Hono } from "hono";
import type { AdminVariables } from "../../middleware/admin";
import { adminRouter } from "../catalog-router";

export const appRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>();
const routes = adminRouter(appRoutes);

routes.handle("listApps");
routes.handle("createApp");
routes.handle("getApp");
routes.handle("validateApp");
routes.handle("validateAppDraft");
routes.handle("updateApp");
routes.handle("deleteApp");

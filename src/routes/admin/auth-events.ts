import { Hono } from "hono";
import type { AdminVariables } from "../../middleware/admin";
import { getAppAuthEventSummary, listAppAuthEvents } from "../../management/auth-events";
import { adminRouter } from "../catalog-router";

export const authEventRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>();
const routes = adminRouter(authEventRoutes);

routes.handle("getAppAuthEventSummary", (_c, { scope, actor, app, query }) =>
  getAppAuthEventSummary(scope, actor, app, query));

routes.handle("listAppAuthEvents", (_c, { scope, actor, app, query }) =>
  listAppAuthEvents(scope, actor, app, query));

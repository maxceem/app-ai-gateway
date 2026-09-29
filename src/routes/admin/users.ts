import { Hono } from "hono";
import type { AdminVariables } from "../../middleware/admin";
import { getAppUser, listAppUsers, setAppUserBlocked } from "../../management/users";
import { adminRouter } from "../catalog-router";

export const userRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>();
const routes = adminRouter(userRoutes);

routes.handle("listAppUsers", (_c, { scope, actor, app, query }) =>
  listAppUsers(scope, actor, app, query));

routes.handle("getAppUser", (c, { scope, actor, app, query }) =>
  getAppUser(scope, actor, app, c.req.param("user"), query));

routes.handle("blockAppUser", (c, { scope, actor, app }) =>
  setAppUserBlocked(scope, actor, app, c.req.param("user"), true));

routes.handle("unblockAppUser", (c, { scope, actor, app }) =>
  setAppUserBlocked(scope, actor, app, c.req.param("user"), false));

import { Hono } from "hono";
import type { AdminVariables } from "../../middleware/admin";
import { adminRouter } from "../catalog-router";

export const keyRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>();
const routes = adminRouter(keyRoutes);

routes.handle("createAppKey");
routes.handle("listAppKeys");
routes.handle("revokeAppKey");

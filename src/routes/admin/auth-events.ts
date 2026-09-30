import { Hono } from "hono";
import type { AdminVariables } from "../../middleware/admin";
import { adminRouter } from "../catalog-router";

export const authEventRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>();
const routes = adminRouter(authEventRoutes);

routes.handle("getAppAuthEventSummary");
routes.handle("listAppAuthEvents");
routes.handle("listAppRejectionEvents");

import { Hono } from "hono";
import type { AdminVariables } from "../../middleware/admin";
import { adminRouter } from "../catalog-router";

export const usageRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>();
const routes = adminRouter(usageRoutes);

routes.handle("getAppUsage");
routes.handle("repriceAppUsage");
routes.handle("getAppUsageTimeseries");
routes.handle("getAppUsageBreakdown");
routes.handle("listAppEvents");

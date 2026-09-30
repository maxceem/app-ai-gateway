import { Hono } from "hono";
import type { AdminVariables } from "../../middleware/admin";
import { adminRouter } from "../catalog-router";

export const userRoutes = new Hono<{ Bindings: Env; Variables: AdminVariables }>();
const routes = adminRouter(userRoutes);

routes.handle("listAppUsers");
routes.handle("getAppUser");
routes.handle("blockAppUser");
routes.handle("unblockAppUser");

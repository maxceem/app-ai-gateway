import { Hono } from "hono";
import type { AdminVariables } from "../../middleware/admin";
import { adminRouter } from "../catalog-router";

type ProviderEnv = { Bindings: Env; Variables: AdminVariables };
export const providerRoutes = new Hono<ProviderEnv>();
const routes = adminRouter(providerRoutes);

routes.handle("listProviders");
routes.handle("testProviderCredential");
routes.handle("createProvider");
routes.handle("updateProvider");
routes.handle("deleteProvider");

import { Hono } from "hono";
import type { AdminVariables } from "../../middleware/admin";
import { adminRouter } from "../catalog-router";

type ProviderGatewayEnv = { Bindings: Env; Variables: AdminVariables };
export const providerGatewayRoutes = new Hono<ProviderGatewayEnv>();
const routes = adminRouter(providerGatewayRoutes);

routes.handle("testProviderGateway");
routes.handle("listProviderGateways");
routes.handle("createProviderGateway");
routes.handle("updateProviderGateway");
routes.handle("rotateProviderGateway");
routes.handle("deleteProviderGateway");

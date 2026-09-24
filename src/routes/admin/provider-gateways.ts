import { Hono } from "hono";
import {
  createProviderGateway,
  deleteProviderGateway,
  listProviderGateways,
  rotateProviderGateway,
  testProviderGateway,
  updateProviderGateway,
} from "../../management/provider-gateways";
import type { AdminVariables } from "../../middleware/admin";
import { adminRouter } from "../catalog-router";

type ProviderGatewayEnv = { Bindings: Env; Variables: AdminVariables };
export const providerGatewayRoutes = new Hono<ProviderGatewayEnv>();
const routes = adminRouter(providerGatewayRoutes);

routes.handle("testProviderGateway", (_c, { scope, actor, body }) =>
  testProviderGateway(scope, actor, body));

routes.handle("listProviderGateways", (_c, { scope, actor }) =>
  listProviderGateways(scope, actor));

routes.handle("createProviderGateway", (_c, { scope, actor, body }) =>
  createProviderGateway(scope, actor, body));

routes.handle("updateProviderGateway", (c, { scope, actor, body }) =>
  updateProviderGateway(scope, actor, c.req.param("id"), body));

routes.handle("rotateProviderGateway", (c, { scope, actor, body }) =>
  rotateProviderGateway(scope, actor, c.req.param("id"), body));

routes.handle("deleteProviderGateway", (c, { scope, actor }) =>
  deleteProviderGateway(scope, actor, c.req.param("id")));

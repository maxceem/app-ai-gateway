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
import { jsonBody, managementScope } from "./body";

type ProviderGatewayEnv = { Bindings: Env; Variables: AdminVariables };
export const providerGatewayRoutes = new Hono<ProviderGatewayEnv>();
const routes = adminRouter(providerGatewayRoutes);

routes.handle("testProviderGateway", async (c) =>
  testProviderGateway(await jsonBody(c)));

routes.handle("listProviderGateways", (c) =>
  listProviderGateways(managementScope(c), c.get("actor")));

routes.handleReceipted("createProviderGateway", (c, { body, boundary }) =>
  createProviderGateway(managementScope(c), c.get("actor"), body, boundary));

routes.handle("updateProviderGateway", async (c) =>
  updateProviderGateway(managementScope(c), c.get("actor"), c.req.param("id"), await jsonBody(c)));

routes.handle("rotateProviderGateway", async (c) =>
  rotateProviderGateway(managementScope(c), c.get("actor"), c.req.param("id"), await jsonBody(c)));

routes.handle("deleteProviderGateway", (c) =>
  deleteProviderGateway(managementScope(c), c.get("actor"), c.req.param("id")));

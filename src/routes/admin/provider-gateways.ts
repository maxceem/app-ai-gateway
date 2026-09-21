import { Hono } from "hono";
import type { ProviderGatewayResponse } from "../../contracts/responses";
import {
  createProviderGateway,
  deleteProviderGateway,
  listProviderGateways,
  rotateProviderGateway,
  testProviderGateway,
  updateProviderGateway,
} from "../../management/provider-gateways";
import type { AdminVariables } from "../../middleware/admin";
import { catalogRouter } from "../catalog-router";
import { jsonBody } from "./body";
import { prepareResourceReceipt } from "./resource-receipt";

type ProviderGatewayEnv = { Bindings: Env; Variables: AdminVariables };
export const providerGatewayRoutes = new Hono<ProviderGatewayEnv>();
const routes = catalogRouter(providerGatewayRoutes, "/v1/admin");

routes.handle("testProviderGateway", async (c) =>
  testProviderGateway(await jsonBody(c)));

routes.handle("listProviderGateways", (c) =>
  listProviderGateways(c.env, c.get("admin")));

routes.handle("createProviderGateway", async (c) => {
  const body = await jsonBody(c);
  const receipt = await prepareResourceReceipt(c, "provider-gateway.add", body);
  if (receipt?.result) return receipt.result as ProviderGatewayResponse;
  try {
    const outcome = await createProviderGateway(c.env, c.get("admin"), body, receipt);
    return (receipt?.result ?? outcome) as ProviderGatewayResponse;
  } catch (error) {
    if (receipt && (await receipt.read())) return receipt.result as ProviderGatewayResponse;
    throw error;
  }
});

routes.handle("updateProviderGateway", async (c) =>
  updateProviderGateway(c.env, c.get("admin"), c.req.param("id"), await jsonBody(c)));

routes.handle("rotateProviderGateway", async (c) =>
  rotateProviderGateway(c.env, c.get("admin"), c.req.param("id"), await jsonBody(c)));

routes.handle("deleteProviderGateway", (c) =>
  deleteProviderGateway(c.env, c.get("admin"), c.req.param("id")));

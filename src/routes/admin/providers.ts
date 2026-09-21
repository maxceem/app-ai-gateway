import { Hono } from "hono";
import type { ProviderResponse } from "../../contracts/responses";
import {
  createProvider,
  deleteProvider,
  listProviders,
  testProvider,
  updateProvider,
} from "../../management/providers";
import type { AdminVariables } from "../../middleware/admin";
import { catalogRouter } from "../catalog-router";
import { jsonBody } from "./body";
import { prepareResourceReceipt } from "./resource-receipt";

type ProviderEnv = { Bindings: Env; Variables: AdminVariables };
export const providerRoutes = new Hono<ProviderEnv>();
const routes = catalogRouter(providerRoutes, "/v1/admin");

routes.handle("listProviders", (c) => listProviders(c.env, c.get("admin")));

routes.handle("testProviderCredential", async (c) =>
  testProvider(c.env, c.get("admin"), await jsonBody(c)));

routes.handle("createProvider", async (c) => {
  const body = await jsonBody(c);
  const receipt = await prepareResourceReceipt(c, "provider.add", body);
  if (receipt?.result) return receipt.result as ProviderResponse;
  try {
    const outcome = await createProvider(c.env, c.get("admin"), body, receipt);
    return (receipt?.result ?? outcome) as ProviderResponse;
  } catch (error) {
    if (receipt && (await receipt.read())) return receipt.result as ProviderResponse;
    throw error;
  }
});

routes.handle("updateProvider", async (c) =>
  updateProvider(c.env, c.get("admin"), c.req.param("id"), await jsonBody(c)));

routes.handle("deleteProvider", (c) =>
  deleteProvider(c.env, c.get("admin"), c.req.param("id")));

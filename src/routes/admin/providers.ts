import { Hono } from "hono";
import {
  createProvider,
  deleteProvider,
  listProviders,
  testProvider,
  updateProvider,
} from "../../management/providers";
import type { AdminVariables } from "../../middleware/admin";
import { adminRouter } from "../catalog-router";
import { jsonBody, managementScope } from "./body";
import { receipted } from "./receipted";

type ProviderEnv = { Bindings: Env; Variables: AdminVariables };
export const providerRoutes = new Hono<ProviderEnv>();
const routes = adminRouter(providerRoutes);

routes.handle("listProviders", (c) => listProviders(managementScope(c), c.get("actor")));

routes.handle("testProviderCredential", async (c) =>
  testProvider(managementScope(c), c.get("actor"), await jsonBody(c)));

routes.handle("createProvider", async (c) => {
  const body = await jsonBody(c);
  return receipted(c, "provider.add", body, (boundary) =>
    createProvider(managementScope(c), c.get("actor"), body, boundary));
});

routes.handle("updateProvider", async (c) =>
  updateProvider(managementScope(c), c.get("actor"), c.req.param("id"), await jsonBody(c)));

routes.handle("deleteProvider", (c) =>
  deleteProvider(managementScope(c), c.get("actor"), c.req.param("id")));

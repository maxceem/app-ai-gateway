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

type ProviderEnv = { Bindings: Env; Variables: AdminVariables };
export const providerRoutes = new Hono<ProviderEnv>();
const routes = adminRouter(providerRoutes);

routes.handle("listProviders", (_c, { scope, actor }) => listProviders(scope, actor));

routes.handle("testProviderCredential", (_c, { scope, actor, body }) => testProvider(scope, actor, body));

routes.handle("createProvider", (_c, { scope, actor, body }) => createProvider(scope, actor, body));

routes.handle("updateProvider", (c, { scope, actor, body }) =>
  updateProvider(scope, actor, c.req.param("id"), body));

routes.handle("deleteProvider", (c, { scope, actor }) =>
  deleteProvider(scope, actor, c.req.param("id")));

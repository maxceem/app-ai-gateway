import { Hono } from "hono";
import type { ProviderDeleteResponse, ProviderListResponse, ProviderResponse, ProviderTestResponse } from "../../contracts/responses";
import {
  createProvider,
  deleteProvider,
  listProviders,
  testProvider,
  updateProvider,
} from "../../management/providers";
import type { AdminVariables } from "../../middleware/admin";
import { providerRequestBody } from "./provider-shared";
import { prepareResourceReceipt } from "./resource-receipt";

type ProviderEnv = { Bindings: Env; Variables: AdminVariables };
export const providerRoutes = new Hono<ProviderEnv>();

providerRoutes.get("/providers", async (c) =>
  c.json(await listProviders(c.env, c.get("admin")) satisfies ProviderListResponse),
);

providerRoutes.post("/providers/test", async (c) =>
  c.json(await testProvider(c.env, c.get("admin"), await providerRequestBody(c)) satisfies ProviderTestResponse),
);

providerRoutes.post("/providers", async (c) => {
  const body = await providerRequestBody(c);
  const receipt = await prepareResourceReceipt(c, "provider.add", body);
  if (receipt?.result) return c.json(receipt.result as ProviderResponse, 201);
  try {
    const outcome = await createProvider(c.env, c.get("admin"), body, receipt);
    return c.json((receipt?.result ?? outcome) as ProviderResponse, 201);
  } catch (error) {
    if (receipt && (await receipt.read())) return c.json(receipt.result as ProviderResponse, 201);
    throw error;
  }
});

providerRoutes.put("/providers/:id", async (c) =>
  c.json(await updateProvider(c.env, c.get("admin"), c.req.param("id"), await providerRequestBody(c)) satisfies ProviderResponse),
);

providerRoutes.delete("/providers/:id", async (c) =>
  c.json(await deleteProvider(c.env, c.get("admin"), c.req.param("id")) satisfies ProviderDeleteResponse),
);

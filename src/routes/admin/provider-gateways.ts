import { Hono } from "hono";
import type {
  ProviderGatewayDeleteResponse,
  ProviderGatewayListResponse,
  ProviderGatewayResponse,
  ProviderGatewayTestResponse,
} from "../../contracts/responses";
import {
  createProviderGateway,
  deleteProviderGateway,
  listProviderGateways,
  rotateProviderGateway,
  testProviderGateway,
  updateProviderGateway,
} from "../../management/provider-gateways";
import type { AdminVariables } from "../../middleware/admin";
import { providerRequestBody } from "./provider-shared";
import { prepareResourceReceipt } from "./resource-receipt";

type ProviderGatewayEnv = { Bindings: Env; Variables: AdminVariables };
export const providerGatewayRoutes = new Hono<ProviderGatewayEnv>();

providerGatewayRoutes.post("/provider-gateways/test", async (c) =>
  c.json(await testProviderGateway(await providerRequestBody(c)) satisfies ProviderGatewayTestResponse),
);

providerGatewayRoutes.get("/provider-gateways", async (c) =>
  c.json(await listProviderGateways(c.env, c.get("admin")) satisfies ProviderGatewayListResponse),
);

providerGatewayRoutes.post("/provider-gateways", async (c) => {
  const body = await providerRequestBody(c);
  const receipt = await prepareResourceReceipt(c, "provider-gateway.add", body);
  if (receipt?.result) return c.json(receipt.result as ProviderGatewayResponse, 201);
  try {
    const outcome = await createProviderGateway(c.env, c.get("admin"), body, receipt);
    return c.json((receipt?.result ?? outcome) as ProviderGatewayResponse, 201);
  } catch (error) {
    if (receipt && (await receipt.read())) return c.json(receipt.result as ProviderGatewayResponse, 201);
    throw error;
  }
});

providerGatewayRoutes.patch("/provider-gateways/:id", async (c) =>
  c.json(await updateProviderGateway(c.env, c.get("admin"), c.req.param("id"), await providerRequestBody(c)) satisfies ProviderGatewayResponse),
);

providerGatewayRoutes.post("/provider-gateways/:id/rotate", async (c) =>
  c.json(await rotateProviderGateway(c.env, c.get("admin"), c.req.param("id"), await providerRequestBody(c)) satisfies ProviderGatewayResponse),
);

providerGatewayRoutes.delete("/provider-gateways/:id", async (c) =>
  c.json(await deleteProviderGateway(c.env, c.get("admin"), c.req.param("id")) satisfies ProviderGatewayDeleteResponse),
);

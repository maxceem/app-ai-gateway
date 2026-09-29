import { narrowedCapability, type ProviderRoute } from "@shared/capabilities";
import { gatewayDescriptor } from "@shared/gateways";
import { providerCapability, type ProviderType } from "@shared/providers";
import type { ProviderCredential } from "@/lib/types";

/**
 * The `route` and `capability` a provider row is served with, as the gateway
 * computes them from the same shared tables — so a fixture describes a row the
 * server could actually return, rather than a capability someone typed.
 */
export function served(
  type: ProviderType,
  route: ProviderRoute = "direct",
): Pick<ProviderCredential, "route" | "capability"> {
  const own = providerCapability(type);
  const gateway = route === "direct" ? undefined : gatewayDescriptor(route).routes[type];
  const capability = route === "direct" ? own : narrowedCapability(own, gateway);
  return {
    route,
    capability: {
      apiStyles: [...(capability?.apiStyles ?? [])],
      endpointStyles: [...(capability?.endpointStyles ?? [])],
      modelPrefix: gateway?.modelPrefix ?? null,
      paths: gateway?.apiStyles === undefined ? "provider" : "gateway",
    },
  };
}

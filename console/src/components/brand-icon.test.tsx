import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { GATEWAY_TYPES, gatewayDescriptor } from "@shared/gateways";
import { PROVIDER_TYPES, providerDescriptor } from "@shared/providers";
import { GatewayName, ProviderName } from "./brand-icon";

/**
 * Every type the shared descriptors admit is named everywhere through these
 * two components, so each has to render its descriptor's label beside a mark
 * that actually drew: a type added to a descriptor table with no vendored SVG
 * would show a name beside an empty box.
 */
describe("brand names", () => {
  it.each(PROVIDER_TYPES)("names the %s provider type with its mark", (type) => {
    const { container } = render(<ProviderName type={type} />);
    expect(container.textContent).toBe(providerDescriptor(type).label);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it.each(GATEWAY_TYPES)("names the %s gateway type with its mark", (type) => {
    const { container } = render(<GatewayName type={type} />);
    expect(container.textContent).toBe(gatewayDescriptor(type).label);
    expect(container.querySelector("svg")).not.toBeNull();
  });
});

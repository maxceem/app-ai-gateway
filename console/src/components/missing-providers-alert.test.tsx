import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { MissingProvidersAlert, unconfiguredProviders } from "./missing-providers-alert";
import { renderAuthenticated, stubApi } from "@/test/render";
import { PROVIDERS, type ProxyConfig } from "@/lib/config-types";
import type { ProviderCredential } from "@/lib/types";

const ALL: ProxyConfig = { providers: { mode: "all" }, model_rewrites: {} };

const SELECTED: ProxyConfig = {
  providers: {
    mode: "selected",
    selected: { openai: { allowed_paths: [], allowed_models: [] } },
  },
  model_rewrites: {},
};

function credential(overrides: Partial<ProviderCredential>): ProviderCredential {
  return {
    id: "provider-1",
    type: "openai",
    slug: "openai",
    name: "Prod OpenAI",
    secretHint: "gain",
    providerGatewayId: null,
    gatewayRoute: null,
    baseUrl: null,
    pricing: null,
    status: "active",
    createdAt: "2026-02-01T00:00:00.000Z",
    createdBy: "user-1",
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("unconfiguredProviders", () => {
  it("ignores a disabled row, because the gateway will not serve traffic to it", () => {
    expect(unconfiguredProviders(SELECTED, [credential({ status: "disabled" })])).toEqual(["openai"]);
    expect(unconfiguredProviders(SELECTED, [credential({})])).toEqual([]);
  });

  it("reads a slug-keyed policy through the org's instances", () => {
    const SLUGGED: ProxyConfig = {
      providers: {
        mode: "selected",
        selected: { "openai-dev": { allowed_paths: [], allowed_models: [] } },
      },
      model_rewrites: {},
    };
    // The app allows an OpenAI instance, and the org has it: nothing missing.
    expect(unconfiguredProviders(SLUGGED, [credential({ slug: "openai-dev" })])).toEqual([]);
    // The same policy with no such row leaves the app pointing at nothing;
    // a default-slug policy still names its type, which is the common case.
    expect(unconfiguredProviders(SLUGGED, [])).toEqual([]);
    expect(unconfiguredProviders(SELECTED, [])).toEqual(["openai"]);
  });

  it("counts any instance of a type, whatever its slug or connection", () => {
    // A second OpenAI key, or one routed through a gateway, configures the type
    // just as the default-slug instance does.
    expect(unconfiguredProviders(
      SELECTED,
      [credential({ id: "provider-2", slug: "openai-cf", secretHint: null, providerGatewayId: "gw-1" })],
    )).toEqual([]);
  });

  it("treats an all-providers app as needing every provider", () => {
    expect(unconfiguredProviders(ALL, [credential({})]))
      .toEqual(PROVIDERS.filter((provider) => provider !== "openai"));
  });
});

describe("MissingProvidersAlert", () => {
  it("stays silent while the provider list is still loading", () => {
    stubApi({ "/v1/admin/providers": { body: { providers: [] } } });
    renderAuthenticated(<MissingProvidersAlert proxy={SELECTED} />);

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("names the missing providers and links to the page that fixes it", async () => {
    stubApi({ "/v1/admin/providers": { body: { providers: [] } } });
    renderAuthenticated(<MissingProvidersAlert proxy={SELECTED} />);

    // Read off the alert as a whole: each provider's name sits in its own
    // element beside that provider's mark.
    expect((await screen.findByRole("alert")).textContent)
      .toMatch(/No credential for OpenAI/);
    expect(screen.getByRole("link", { name: /add a provider key/i }).getAttribute("href"))
      .toBe("/providers");
  });

  it("says nothing once every allowed provider is configured", async () => {
    stubApi({ "/v1/admin/providers": { body: { providers: [credential({})] } } });
    const { client } = renderAuthenticated(<MissingProvidersAlert proxy={SELECTED} />);

    await waitFor(() => expect(client.getQueryData(["providers"])).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

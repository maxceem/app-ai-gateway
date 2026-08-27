import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { MissingProvidersAlert, unconfiguredProviders } from "./missing-providers-alert";
import { renderAuthenticated, stubApi } from "@/test/render";
import type { ProxyConfig } from "@/lib/config-types";
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
    name: "Prod OpenAI",
    secretHint: "gain",
    gateway: null,
    gatewayConfig: null,
    pricing: null,
    status: "active",
    createdAt: "2026-02-01T00:00:00.000Z",
    createdBy: "user-1",
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("unconfiguredProviders", () => {
  it("ignores a revoked row, because the gateway will not resolve it", () => {
    expect(unconfiguredProviders(SELECTED, [credential({ status: "revoked" })])).toEqual(["openai"]);
    expect(unconfiguredProviders(SELECTED, [credential({})])).toEqual([]);
  });

  it("treats an all-providers app as needing every provider", () => {
    expect(unconfiguredProviders(ALL, [credential({})]))
      .toEqual(["anthropic", "xai", "gemini", "perplexity"]);
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

    expect(await screen.findByText(/No credential for OpenAI/)).toBeTruthy();
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

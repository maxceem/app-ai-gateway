import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EndpointsTab } from "./endpoints";
import { useAppDraft } from "@/hooks/use-app-draft";
import { renderAuthenticated, stubApi } from "@/test/render";
import type { EndpointsConfig } from "@/lib/config-types";
import type { ProviderCredential, ProviderGateway } from "@/lib/types";

const APP_ID = "my-app";

/** Anthropic composes neither endpoint style, so its instance is never a target. */
const PROVIDERS: ProviderCredential[] = [
  {
    id: "provider-1",
    type: "openai",
    slug: "openai-dev",
    name: "Dev OpenAI",
    secretHint: "dev4",
    providerGatewayId: null,
    gatewayRoute: null,
    pricing: null,
    status: "active",
    createdAt: "2026-02-01T00:00:00.000Z",
    createdBy: "user-1",
  },
  {
    id: "provider-2",
    type: "xai",
    slug: "grok",
    name: "xAI",
    secretHint: "xai9",
    providerGatewayId: null,
    gatewayRoute: null,
    pricing: null,
    status: "active",
    createdAt: "2026-02-01T00:00:00.000Z",
    createdBy: "user-1",
  },
  {
    id: "provider-3",
    type: "anthropic",
    slug: "claude",
    name: "Anthropic",
    secretHint: "an7c",
    providerGatewayId: null,
    gatewayRoute: null,
    pricing: null,
    status: "active",
    createdAt: "2026-02-01T00:00:00.000Z",
    createdBy: "user-1",
  },
];

const PRICES = {
  openai: { "gpt-5.6-luna": { input: 1, output: 2 } },
  xai: { "grok-5": { input: 3, output: 4 } },
};

function appRow(endpoints: EndpointsConfig) {
  return {
    id: APP_ID,
    name: "My app",
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    config: {
      authentication: {
        type: "api_key",
        end_user: { header: "x-end-user-id", required: false, fallback: "api_key" },
      },
      routing: { providers: { mode: "all" }, model_rewrites: {} },
      limits: {
        per_user: { requests: { per_minute: null, per_day: null }, spending: { monthly_usd: null } },
        per_app: { requests: { per_minute: null, per_day: null }, spending: { monthly_usd: null } },
      },
      endpoints,
    },
  };
}

function Harness() {
  const state = useAppDraft(APP_ID);
  return state.draft ? <EndpointsTab appId={APP_ID} state={state} /> : null;
}

const VERCEL_GATEWAY: ProviderGateway = {
  id: "gw-vercel",
  type: "vercel",
  name: "Team Vercel gateway",
  config: {},
  secretHint: "1abc",
  providerCount: 1,
  referencedCount: 1,
  status: "active",
  createdAt: "2026-02-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
  createdBy: "user-1",
};

/** An eligible provider type on a route that serves only some of its APIs. */
const OPENAI_VIA_VERCEL: ProviderCredential = {
  ...PROVIDERS[0]!,
  id: "provider-4",
  slug: "openai-vercel",
  name: "OpenAI via Vercel",
  secretHint: null,
  providerGatewayId: "gw-vercel",
};

function renderTab(
  endpoints: EndpointsConfig,
  providers = PROVIDERS,
  gateways: ProviderGateway[] = [],
) {
  stubApi({
    [`/v1/admin/apps/${APP_ID}`]: {
      body: { app: appRow(endpoints), resolved: null, config_error: null },
    },
    "/v1/admin/providers": { body: { providers } },
    "/v1/admin/provider-gateways": { body: { gateways } },
    "/v1/admin/prices": { body: { prices: PRICES } },
  });
  return renderAuthenticated(<Harness />);
}

const CHAT: EndpointsConfig = {
  chat: { api_style: "responses", provider: "openai-dev", model: "gpt-5.6-luna" },
};

afterEach(() => vi.unstubAllGlobals());

describe("EndpointsTab", () => {
  it("targets provider instances, and only those whose type serves the style", async () => {
    renderTab(CHAT);

    await userEvent.click(await screen.findByRole("combobox", { name: "Provider" }));
    const options = (await screen.findAllByRole("option")).map((entry) => entry.textContent);

    expect(options).toEqual([
      "openai-dev — Dev OpenAI (OpenAI)",
      "grok — xAI (xAI)",
    ]);
    // The Anthropic instance cannot compose a Responses request.
    expect(options.some((label) => label?.includes("claude"))).toBe(false);
  });

  /**
   * The provider type composes both styles; its Vercel route serves only one.
   * Offering it for transcription would produce a configuration the Worker
   * refuses on save.
   */
  it("drops an instance whose route cannot serve the style", async () => {
    renderTab(
      { speech: { api_style: "transcription", provider: "openai-dev", model: "gpt-5.6-luna" } },
      [...PROVIDERS, OPENAI_VIA_VERCEL],
      [VERCEL_GATEWAY],
    );

    await userEvent.click(await screen.findByRole("combobox", { name: "Provider" }));
    const transcription = (await screen.findAllByRole("option")).map((entry) => entry.textContent);
    expect(transcription.some((label) => label?.includes("openai-vercel"))).toBe(false);
    expect(transcription.some((label) => label?.includes("openai-dev"))).toBe(true);
  });

  it("keeps that instance for a style its route does serve", async () => {
    renderTab(CHAT, [...PROVIDERS, OPENAI_VIA_VERCEL], [VERCEL_GATEWAY]);

    await userEvent.click(await screen.findByRole("combobox", { name: "Provider" }));
    expect(
      (await screen.findAllByRole("option")).some((entry) =>
        entry.textContent?.includes("openai-vercel")
      ),
    ).toBe(true);
  });

  it("prices the model list through the instance's provider type", async () => {
    renderTab(CHAT);

    await userEvent.click(await screen.findByRole("combobox", { name: "Model" }));
    const models = (await screen.findAllByRole("option")).map((entry) => entry.textContent);

    // "openai-dev" is an OpenAI row, so it is priced from the OpenAI catalog.
    expect(models).toEqual(["gpt-5.6-luna"]);
  });

  it("offers a model only the selected instance prices", async () => {
    renderTab(CHAT, [
      { ...PROVIDERS[0]!, pricing: { "gpt-lab-only": { input: 5, output: 6 } } },
      ...PROVIDERS.slice(1),
    ]);

    await userEvent.click(await screen.findByRole("combobox", { name: "Model" }));

    // The gateway accepts a model this row prices, so the picker must offer it.
    expect((await screen.findAllByRole("option")).map((entry) => entry.textContent))
      .toEqual(["gpt-5.6-luna", "gpt-lab-only"]);
  });

  it("cannot add an endpoint when no instance can serve one", async () => {
    // Anthropic composes neither style, so there is no target to create.
    renderTab({}, [PROVIDERS[2]!]);

    const add = await screen.findByRole("button", { name: /add endpoint/i });
    expect(add).toHaveProperty("disabled", true);
    expect(screen.getByText(/add an openai or xai provider first/i)).toBeTruthy();
    expect(add.getAttribute("aria-describedby")).toBe("add-endpoint-disabled-reason");

    await userEvent.click(add);
    // No phantom endpoint pointing at a provider that is not configured.
    expect(screen.queryByLabelText("Endpoint slug")).toBeNull();
  });

  it("switches an endpoint to another instance and clears the stale model", async () => {
    renderTab(CHAT);

    await userEvent.click(await screen.findByRole("combobox", { name: "Provider" }));
    await userEvent.click(await screen.findByRole("option", { name: /grok/ }));

    expect(screen.getByRole("combobox", { name: "Provider" }).textContent)
      .toContain("grok");
    await userEvent.click(screen.getByRole("combobox", { name: "Model" }));
    expect((await screen.findAllByRole("option")).map((entry) => entry.textContent))
      .toEqual(["grok-5"]);
  });

  it("keeps a slug the organization no longer has selectable rather than silently repointing it", async () => {
    renderTab({ chat: { api_style: "responses", provider: "openai-gone", model: "gpt-5.6-luna" } });

    const trigger = await screen.findByRole("combobox", { name: "Provider" });
    expect(trigger.textContent).toContain("openai-gone — not configured");
  });

  it("starts a new endpoint on an instance the organization has", async () => {
    renderTab({});

    // The action waits for the instance list: what it creates depends on it.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /add endpoint/i }))
        .toHaveProperty("disabled", false));
    await userEvent.click(screen.getByRole("button", { name: /add endpoint/i }));

    // The old default was the literal type name, which need not be a slug here.
    await screen.findByLabelText("Endpoint slug");
    expect(screen.getByRole("combobox", { name: "Provider" }).textContent).toContain("openai-dev");
  });
});

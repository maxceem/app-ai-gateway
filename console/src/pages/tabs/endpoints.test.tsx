import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EndpointsTab, endpointSummary } from "./endpoints";
import { useAppDraft } from "@/hooks/use-app-draft";
import { renderAuthenticated, stubApi } from "@/test/render";
import type { EndpointsConfig } from "@/lib/config-types";
import type { ProviderCredential, ProviderGateway } from "@/lib/types";
import { served } from "@/test/providers";

const APP_ID = "my-app";

/** Anthropic composes neither endpoint style, so its instance is never a target. */
const PROVIDERS: ProviderCredential[] = [
  {
    id: "provider-1",
    type: "openai",
    ...served("openai"),
    slug: "openai-dev",
    name: "Dev OpenAI",
    secretHint: "dev4",
    providerGatewayId: null,
    gatewayRoute: null,
    baseUrl: null,
    pricing: null,
    revision: 1,
    status: "active",
    createdAt: "2026-02-01T00:00:00.000Z",
    createdBy: "user-1",
  },
  {
    id: "provider-2",
    type: "xai",
    ...served("xai"),
    slug: "grok",
    name: "xAI",
    secretHint: "xai9",
    providerGatewayId: null,
    gatewayRoute: null,
    baseUrl: null,
    pricing: null,
    revision: 1,
    status: "active",
    createdAt: "2026-02-01T00:00:00.000Z",
    createdBy: "user-1",
  },
  {
    id: "provider-3",
    type: "anthropic",
    ...served("anthropic"),
    slug: "claude",
    name: "Anthropic",
    secretHint: "an7c",
    providerGatewayId: null,
    gatewayRoute: null,
    baseUrl: null,
    pricing: null,
    revision: 1,
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
        end_user: { source: "none" },
      },
      routing: { providers: { mode: "all" }, model_rewrites: {} },
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
  revision: 1,
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
  ...served("openai", "vercel"),
};

function renderTab(
  endpoints: EndpointsConfig,
  providers = PROVIDERS,
  gateways: ProviderGateway[] = [],
) {
  stubApi({
    [`/v1/admin/apps/${APP_ID}`]: {
      body: { app: appRow(endpoints) },
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

/** Opens a row's editor; the list shows every endpoint closed. */
const expand = async (slug: string) =>
  userEvent.click(await screen.findByRole("button", { name: `Edit ${slug}` }));

describe("endpointSummary", () => {
  it("says the style, the target, and only the extras that are set", () => {
    expect(endpointSummary(CHAT.chat!)).toBe("responses · openai-dev → gpt-5.6-luna");
    expect(
      endpointSummary({
        ...CHAT.chat!,
        max_output_tokens: 4096,
        fallback: [{ provider: "grok", model: "grok-5" }],
      }),
    ).toBe("responses · openai-dev → gpt-5.6-luna · 1 fallback · up to 4,096 output tokens");
    expect(endpointSummary({ api_style: "responses", provider: "openai-dev", model: "" }))
      .toBe("responses · openai-dev → no model");
  });
});

describe("EndpointsTab", () => {
  it("lists endpoints closed, each with its URL and a one-line summary, and opens one to edit", async () => {
    renderTab({
      ...CHAT,
      speech: { api_style: "audio_transcription", provider: "openai-dev", model: "gpt-5.6-luna" },
    });

    expect(await screen.findByText(`POST /v1/apps/${APP_ID}/endpoints/chat`)).toBeTruthy();
    expect(screen.getByText("responses · openai-dev → gpt-5.6-luna")).toBeTruthy();
    expect(screen.getByText("audio_transcription · openai-dev → gpt-5.6-luna")).toBeTruthy();
    // Closed rows hold no fields.
    expect(screen.queryByLabelText("Endpoint slug")).toBeNull();

    const toggle = screen.getByRole("button", { name: "Edit chat" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("Endpoint slug")).toHaveProperty("value", "chat");
    // Only the row that was opened.
    expect(screen.getAllByLabelText("Endpoint slug")).toHaveLength(1);

    await userEvent.click(toggle);
    expect(screen.queryByLabelText("Endpoint slug")).toBeNull();
  });

  it("keeps a row open while its slug is retyped, and says when the slug is not valid", async () => {
    renderTab(CHAT);

    await expand("chat");
    const slug = screen.getByLabelText("Endpoint slug");
    await userEvent.type(slug, "-v2");

    expect(screen.getByRole("button", { name: "Edit chat-v2" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(`POST /v1/apps/${APP_ID}/endpoints/chat-v2`)).toBeTruthy();

    await userEvent.type(slug, "!");
    expect(screen.getAllByText("Use 1-64 characters from a-z, 0-9, and -").length).toBeGreaterThan(0);
  });

  it("marks a closed row whose endpoint cannot be saved yet", async () => {
    renderTab({ chat: { api_style: "responses", provider: "openai-dev", model: "" } });

    expect(await screen.findByText("Choose a model")).toBeTruthy();
  });

  it("marks a row whose provider the account no longer has", async () => {
    renderTab({ chat: { api_style: "responses", provider: "openai-gone", model: "gpt-5.6-luna" } });

    expect(await screen.findByText("provider not configured")).toBeTruthy();
  });

  it("removes an endpoint from inside its open row", async () => {
    renderTab(CHAT);

    await screen.findByText(`POST /v1/apps/${APP_ID}/endpoints/chat`);
    // Closed, a row offers nothing destructive.
    expect(screen.queryByRole("button", { name: /remove endpoint/i })).toBeNull();
    await expand("chat");
    await userEvent.click(screen.getByRole("button", { name: /remove endpoint/i }));

    expect(screen.queryByText(`POST /v1/apps/${APP_ID}/endpoints/chat`)).toBeNull();
    expect(screen.getByText(/no custom endpoints/i)).toBeTruthy();
  });

  it("targets provider instances, and only those whose type serves the style", async () => {
    renderTab(CHAT);

    await expand("chat");
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
      { speech: { api_style: "audio_transcription", provider: "openai-dev", model: "gpt-5.6-luna" } },
      [...PROVIDERS, OPENAI_VIA_VERCEL],
      [VERCEL_GATEWAY],
    );

    await expand("speech");
    await userEvent.click(await screen.findByRole("combobox", { name: "Provider" }));
    const transcription = (await screen.findAllByRole("option")).map((entry) => entry.textContent);
    expect(transcription.some((label) => label?.includes("openai-vercel"))).toBe(false);
    expect(transcription.some((label) => label?.includes("openai-dev"))).toBe(true);
  });

  it("keeps that instance for a style its route does serve", async () => {
    renderTab(CHAT, [...PROVIDERS, OPENAI_VIA_VERCEL], [VERCEL_GATEWAY]);

    await expand("chat");
    await userEvent.click(await screen.findByRole("combobox", { name: "Provider" }));
    expect(
      (await screen.findAllByRole("option")).some((entry) =>
        entry.textContent?.includes("openai-vercel")
      ),
    ).toBe(true);
  });

  /**
   * A routed row's capability comes with the row itself, so nothing waits on
   * the gateway list: even with that list failing, the Vercel-routed OpenAI row
   * is offered for the style its route serves and withheld from the one it
   * does not.
   */
  it("judges a routed instance by the capability on the row, not the gateway list", async () => {
    stubApi({
      [`/v1/admin/apps/${APP_ID}`]: {
        body: { app: appRow(CHAT) },
      },
      "/v1/admin/providers": { body: { providers: [...PROVIDERS, OPENAI_VIA_VERCEL] } },
      "/v1/admin/provider-gateways": { status: 500, body: { error: { code: "internal_error" } } },
      "/v1/admin/prices": { body: { prices: PRICES } },
    });
    renderAuthenticated(<Harness />);

    await expand("chat");
    await userEvent.click(await screen.findByRole("combobox", { name: "Provider" }));
    const options = (await screen.findAllByRole("option")).map((entry) => entry.textContent);
    expect(options.some((label) => label?.includes("openai-vercel"))).toBe(true);
    expect(options.some((label) => label?.includes("openai-dev"))).toBe(true);
  });

  it("prices the model list through the instance's provider type", async () => {
    renderTab(CHAT);

    await expand("chat");
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

    await expand("chat");
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
    expect(screen.getByText(/add a provider of type openai or xai first/i)).toBeTruthy();
    expect(add.getAttribute("aria-describedby")).toBe("add-endpoint-disabled-reason");

    await userEvent.click(add);
    // No phantom endpoint pointing at a provider that is not configured.
    expect(screen.queryByLabelText("Endpoint slug")).toBeNull();
  });

  it("switches an endpoint to another instance and clears the stale model", async () => {
    renderTab(CHAT);

    await expand("chat");
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

    await expand("chat");
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

    // A new row opens on its own: it has nothing to read yet, only to fill in.
    expect(screen.getByRole("button", { name: "Edit endpoint" }).getAttribute("aria-expanded")).toBe("true");
    // The old default was the literal type name, which need not be a slug here.
    await screen.findByLabelText("Endpoint slug");
    expect(screen.getByRole("combobox", { name: "Provider" }).textContent).toContain("openai-dev");
  });
});

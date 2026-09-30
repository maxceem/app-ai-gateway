import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProviderAccessTab } from "./provider-access";
import { useAppDraft } from "@/hooks/use-app-draft";
import { renderAuthenticated, stubApi } from "@/test/render";
import type { ProxyConfig } from "@/lib/config-types";
import type { ProviderCredential } from "@/lib/types";
import { served } from "@/test/providers";

const APP_ID = "my-app";

/** Two instances of one type plus a second type: policy can only name slugs. */
const PROVIDERS: ProviderCredential[] = [
  {
    id: "provider-1",
    type: "openai",
    ...served("openai"),
    slug: "openai",
    name: "Prod OpenAI",
    secretHint: "gain",
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

function appRow(routing: ProxyConfig) {
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
      routing,
    },
  };
}

function Harness() {
  const state = useAppDraft(APP_ID);
  if (!state.draft) return null;
  return (
    <>
      <ProviderAccessTab state={state} />
      {/* What a save would send, so a row on screen can be told from a row in the draft. */}
      <pre data-testid="providers">{JSON.stringify(state.draft.config.routing.providers)}</pre>
    </>
  );
}

const draftProviders = () => JSON.parse(screen.getByTestId("providers").textContent ?? "null");

function renderTab(routing: ProxyConfig, providers = PROVIDERS) {
  stubApi({
    [`/v1/admin/apps/${APP_ID}`]: {
      body: { app: appRow(routing) },
    },
    "/v1/admin/providers": { body: { providers } },
    "/v1/admin/prices": { body: { prices: { openai: { "gpt-5.6-luna": { input: 1, output: 2 } } } } },
  });
  return renderAuthenticated(<Harness />);
}

const selectedRouting = (selected: Record<string, unknown>): ProxyConfig =>
  ({ providers: { mode: "selected", selected }, model_rewrites: {} }) as ProxyConfig;

afterEach(() => vi.unstubAllGlobals());

const ALL: ProxyConfig = { providers: { mode: "all" }, model_rewrites: {} };

const modeField = () => screen.getByRole("combobox", { name: "Providers this app can call" });
const choose = async (field: string, option: string) => {
  await userEvent.click(screen.getByRole("combobox", { name: field }));
  await userEvent.click(await screen.findByRole("option", { name: option }));
};
const chooseMode = (option: "All providers" | "Selected providers") =>
  choose("Providers this app can call", option);
const ENDPOINTS = "Endpoints this provider serves";
const MODELS = "Models this provider serves";
const switchFor = (slug: string) => screen.getByRole("switch", { name: `Enable ${slug}` });
const isOn = (slug: string) => switchFor(slug).getAttribute("aria-checked") === "true";
const expand = (slug: string) =>
  userEvent.click(screen.getByRole("button", { name: `Restrictions for ${slug}` }));

describe("ProviderAccessTab", () => {
  it("makes the default and explicit endpoint policies visible as the list changes", async () => {
    renderTab(selectedRouting({ "openai-dev": { allowed_paths: [], allowed_models: [] } }));

    // Closed, the row says its policy in one line; open, it asks two questions.
    expect(await screen.findByText("All inference endpoints · all models · no output cap")).toBeTruthy();
    await expand("openai-dev");
    expect(screen.getByRole("combobox", { name: ENDPOINTS }).textContent).toBe("All inference endpoints");
    expect(screen.queryByPlaceholderText("v1/responses")).toBeNull();

    // Selecting starts with a row to type in, and the summary counts it.
    await choose(ENDPOINTS, "Selected endpoints");
    expect(screen.getByPlaceholderText("v1/responses")).toBeTruthy();
    expect(screen.getByText("1 endpoint · all models · no output cap")).toBeTruthy();

    // Removing the last row is what "all" is, and the field says so again.
    await userEvent.click(screen.getByRole("button", { name: /remove endpoint/i }));
    expect(screen.getByRole("combobox", { name: ENDPOINTS }).textContent).toBe("All inference endpoints");
    expect(screen.getByText("All inference endpoints · all models · no output cap")).toBeTruthy();
  });

  it("keeps an endpoint list through a detour to all endpoints", async () => {
    renderTab(selectedRouting({ "openai-dev": { allowed_paths: ["v1/responses"], allowed_models: [] } }));

    await screen.findByText("1 endpoint · all models · no output cap");
    await expand("openai-dev");
    expect(screen.getByRole("combobox", { name: ENDPOINTS }).textContent).toBe("Selected endpoints");
    expect(screen.getByDisplayValue("v1/responses")).toBeTruthy();

    await choose(ENDPOINTS, "All inference endpoints");
    await waitFor(() =>
      expect(draftProviders().selected["openai-dev"].allowed_paths).toEqual([]));
    expect(screen.queryByDisplayValue("v1/responses")).toBeNull();

    await choose(ENDPOINTS, "Selected endpoints");
    await waitFor(() =>
      expect(draftProviders().selected["openai-dev"].allowed_paths).toEqual(["v1/responses"]));
  });

  it("asks for models the same way, and only shows the list once asked", async () => {
    renderTab(selectedRouting({ "openai-dev": { allowed_paths: [], allowed_models: [] } }));

    await screen.findByText("Dev OpenAI");
    await expand("openai-dev");
    expect(screen.getByRole("combobox", { name: MODELS }).textContent).toBe("All models");
    expect(screen.queryByPlaceholderText("gpt-5.6-terra")).toBeNull();

    // Asking for a selection shows the list; nothing changes until a model is added.
    await choose(MODELS, "Selected models");
    expect(screen.getByRole("combobox", { name: MODELS }).textContent).toBe("Selected models");
    await userEvent.type(screen.getByPlaceholderText("gpt-5.6-terra"), "gpt-5.6-luna");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(draftProviders().selected["openai-dev"].allowed_models).toEqual(["gpt-5.6-luna"]));
    expect(screen.getByText("All inference endpoints · 1 model · no output cap")).toBeTruthy();

    // Back to all clears the list; asking again brings it back.
    await choose(MODELS, "All models");
    await waitFor(() =>
      expect(draftProviders().selected["openai-dev"].allowed_models).toEqual([]));
    expect(screen.queryByPlaceholderText("gpt-5.6-terra")).toBeNull();
    await choose(MODELS, "Selected models");
    await waitFor(() =>
      expect(draftProviders().selected["openai-dev"].allowed_models).toEqual(["gpt-5.6-luna"]));

    // Removing the last model is what "all models" is.
    await userEvent.click(screen.getByRole("button", { name: "Remove gpt-5.6-luna" }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: MODELS }).textContent).toBe("All models"));
  });

  it("switches the organization's instances, not the five provider types", async () => {
    renderTab(selectedRouting({ "openai-dev": { allowed_paths: [], allowed_models: [] } }));

    // One row per instance, named by the row an operator recognises, with the
    // slug clients call beside it.
    expect(await screen.findByText("Dev OpenAI")).toBeTruthy();
    expect(screen.getByText("Prod OpenAI")).toBeTruthy();
    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("/proxy/openai-dev/…")).toBeTruthy();
    expect(isOn("openai-dev")).toBe(true);
    expect(isOn("openai")).toBe(false);
    expect(isOn("claude")).toBe(false);
    expect(modeField().textContent).toBe("Selected providers");
  });

  it("allows a second instance of a type that is already allowed", async () => {
    renderTab(selectedRouting({ "openai-dev": { allowed_paths: [], allowed_models: [] } }));

    await userEvent.click(await screen.findByRole("switch", { name: "Enable openai" }));

    // Per-instance policy is the point: two OpenAI rows, both nameable.
    await waitFor(() =>
      expect(draftProviders()).toEqual({
        mode: "selected",
        selected: {
          "openai-dev": { allowed_paths: [], allowed_models: [] },
          openai: { allowed_paths: [], allowed_models: [] },
        },
      }));
  });

  it("keeps a slug the organization no longer has, so it can be turned off", async () => {
    renderTab(selectedRouting({ "openai-gone": { allowed_paths: [], allowed_models: [] } }));

    // The row keeps its switch and its restrictions and only gains a "deleted" mark.
    expect(await screen.findByText("openai-gone")).toBeTruthy();
    expect(screen.getByText("deleted")).toBeTruthy();
    expect(isOn("openai-gone")).toBe(true);
    expect(screen.getByText(/no provider has this slug any more/i)).toBeTruthy();

    await userEvent.click(switchFor("openai-gone"));
    await waitFor(() => expect(draftProviders()).toEqual({ mode: "selected", selected: {} }));
  });

  it("takes a switched-off instance out of the draft, and restores its policy when switched back on", async () => {
    const policy = { allowed_paths: ["v1/responses"], allowed_models: ["gpt-5.6-luna"] };
    renderTab(selectedRouting({ "openai-dev": policy }));

    await userEvent.click(await screen.findByRole("switch", { name: "Enable openai-dev" }));
    // Gone, rather than kept under its slug as a value the save has to drop.
    await waitFor(() => expect(draftProviders()).toEqual({ mode: "selected", selected: {} }));

    await userEvent.click(switchFor("openai-dev"));
    await waitFor(() =>
      expect(draftProviders()).toEqual({ mode: "selected", selected: { "openai-dev": policy } }));
  });

  /**
   * A paused instance keeps its whole row: the app is still configured to use
   * it, the restrictions are still editable, and re-enabling it on the
   * Providers page brings it straight back. Only the badge changes.
   */
  it("badges a disabled instance without taking its configuration away", async () => {
    const paused = PROVIDERS.map((row) =>
      row.slug === "openai-dev" ? { ...row, status: "disabled" as const } : row);
    renderTab(
      selectedRouting({ "openai-dev": { allowed_paths: [], allowed_models: ["gpt-5.6-luna"] } }),
      paused,
    );

    expect(await screen.findByText("Dev OpenAI")).toBeTruthy();
    expect(screen.getByText("disabled")).toBeTruthy();
    // Still switched on, and still offering the controls that configure it.
    expect(isOn("openai-dev")).toBe(true);
    expect(screen.getByText("All inference endpoints · 1 model · no output cap")).toBeTruthy();
    await expand("openai-dev");
    expect(screen.getByRole("combobox", { name: MODELS }).textContent).toBe("Selected models");
    expect(screen.getByText("gpt-5.6-luna")).toBeTruthy();
    // The row it belongs to is unaffected: no other row is marked.
    expect(screen.queryAllByText("disabled")).toHaveLength(1);
  });

  it("lists every instance as allowed in all mode, with no switch to flip", async () => {
    const paused = PROVIDERS.map((row) =>
      row.slug === "claude" ? { ...row, status: "disabled" as const } : row);
    renderTab(ALL, paused);

    expect(await screen.findByText("Anthropic")).toBeTruthy();
    expect(screen.getAllByText("Allowed")).toHaveLength(3);
    // Each row says what all mode grants it, in the words selected mode uses.
    expect(screen.getAllByText("All inference endpoints · all models · no output cap")).toHaveLength(3);
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    // A paused instance is still one of "all", and says so.
    expect(screen.getByText("disabled")).toBeTruthy();
    expect(modeField().textContent).toBe("All providers");
  });

  it("starts a selection from everything all mode was allowing", async () => {
    renderTab(ALL);

    await screen.findByText("Dev OpenAI");
    await chooseMode("Selected providers");

    // Nothing changes for the app until a switch is turned off.
    await waitFor(() => expect(isOn("openai-dev")).toBe(true));
    expect(isOn("openai")).toBe(true);
    expect(isOn("claude")).toBe(true);
    expect(draftProviders()).toEqual({
      mode: "selected",
      selected: {
        openai: { allowed_paths: [], allowed_models: [] },
        "openai-dev": { allowed_paths: [], allowed_models: [] },
        claude: { allowed_paths: [], allowed_models: [] },
      },
    });
  });

  it("brings the selection back after a detour through all mode", async () => {
    const policy = { allowed_paths: ["v1/responses"], allowed_models: [] };
    renderTab(selectedRouting({ "openai-dev": policy }));

    await screen.findByText("Dev OpenAI");
    await chooseMode("All providers");
    await waitFor(() => expect(draftProviders()).toEqual({ mode: "all" }));
    expect(screen.queryAllByRole("switch")).toHaveLength(0);

    await chooseMode("Selected providers");
    await waitFor(() =>
      expect(draftProviders()).toEqual({ mode: "selected", selected: { "openai-dev": policy } }));
  });

  it("suggests the models the selected instance itself prices", async () => {
    renderTab(
      selectedRouting({ "openai-dev": { allowed_paths: [], allowed_models: [] } }),
      [
        PROVIDERS[0]!,
        { ...PROVIDERS[1]!, pricing: { "gpt-lab-only": { input: 5, output: 6 } } },
        PROVIDERS[2]!,
      ],
    );

    await screen.findByText("Dev OpenAI");
    await expand("openai-dev");
    await choose(MODELS, "Selected models");
    const suggested = [...document.querySelectorAll("datalist option")]
      .map((option) => option.getAttribute("value"));

    // A custom-priced model is allowlistable for the row that prices it.
    expect(suggested).toContain("gpt-lab-only");
    expect(suggested).toContain("gpt-5.6-luna");
  });

  it("says what to do when the organization has no instances at all", async () => {
    renderTab(selectedRouting({}), []);

    expect(await screen.findByText(/no providers to choose from/i)).toBeTruthy();
  });
});

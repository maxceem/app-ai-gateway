import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProxyPolicyTab } from "./proxy-policy";
import { useAppDraft } from "@/hooks/use-app-draft";
import { renderAuthenticated, stubApi } from "@/test/render";
import type { ProxyConfig } from "@/lib/config-types";
import type { ProviderCredential } from "@/lib/types";

const APP_ID = "my-app";

/** Two instances of one type plus a second type: policy can only name slugs. */
const PROVIDERS: ProviderCredential[] = [
  {
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
  },
  {
    id: "provider-2",
    type: "openai",
    slug: "openai-dev",
    name: "Dev OpenAI",
    secretHint: "dev4",
    providerGatewayId: null,
    gatewayRoute: null,
    baseUrl: null,
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
    baseUrl: null,
    pricing: null,
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
        end_user: { header: "x-end-user-id", required: false, fallback: "api_key" },
      },
      routing,
      limits: {
        per_user: { requests: { per_minute: null, per_day: null }, spending: { monthly_usd: null } },
        per_app: { requests: { per_minute: null, per_day: null }, spending: { monthly_usd: null } },
      },
    },
  };
}

function Harness() {
  const state = useAppDraft(APP_ID);
  return state.draft ? <ProxyPolicyTab state={state} /> : null;
}

function renderTab(routing: ProxyConfig, providers = PROVIDERS) {
  stubApi({
    [`/v1/admin/apps/${APP_ID}`]: {
      body: { app: appRow(routing), resolved: null, config_error: null },
    },
    "/v1/admin/providers": { body: { providers } },
    "/v1/admin/prices": { body: { prices: { openai: { "gpt-5.6-luna": { input: 1, output: 2 } } } } },
  });
  return renderAuthenticated(<Harness />);
}

const selectedRouting = (selected: Record<string, unknown>): ProxyConfig =>
  ({ providers: { mode: "selected", selected }, model_rewrites: {} }) as ProxyConfig;

afterEach(() => vi.unstubAllGlobals());

describe("ProxyPolicyTab", () => {
  it("switches the organization's instances, not the five provider types", async () => {
    renderTab(selectedRouting({ "openai-dev": { allowed_paths: [], allowed_models: [] } }));

    // One card per instance, named by the row an operator recognises. By
    // heading, not by text: the card's description names the provider type as
    // well, so an instance named after its own brand appears twice.
    expect(await screen.findByRole("heading", { name: "Dev OpenAI" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Prod OpenAI" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Anthropic" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Enable openai-dev" }))
      .toHaveProperty("ariaChecked", "true");
    expect(screen.getByRole("switch", { name: "Enable openai" }))
      .toHaveProperty("ariaChecked", "false");
    expect(screen.getByText("1 of 3 provider instances enabled")).toBeTruthy();
  });

  it("allows a second instance of a type that is already allowed", async () => {
    renderTab(selectedRouting({ "openai-dev": { allowed_paths: [], allowed_models: [] } }));

    await userEvent.click(await screen.findByRole("switch", { name: "Enable openai" }));

    // Per-instance policy is the point: two OpenAI rows, both nameable.
    await waitFor(() =>
      expect(screen.getByText("2 of 3 provider instances enabled")).toBeTruthy());
  });

  it("keeps a slug the organization no longer has, so it can be turned off", async () => {
    renderTab(selectedRouting({ "openai-gone": { allowed_paths: [], allowed_models: [] } }));

    // The card keeps its full configuration UI and only gains a "deleted" mark.
    expect(await screen.findByText(/no instance answers for this slug/i)).toBeTruthy();
    expect(screen.getByText("deleted")).toBeTruthy();
    const orphan = screen.getByRole("switch", { name: "Enable openai-gone" });
    expect(orphan).toHaveProperty("ariaChecked", "true");

    await userEvent.click(orphan);
    await waitFor(() =>
      expect(screen.getByText("0 of 3 provider instances enabled")).toBeTruthy());
  });

  /**
   * A paused instance keeps its whole card: the app is still configured to use
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
    expect(screen.getByRole("switch", { name: "Enable openai-dev" }))
      .toHaveProperty("ariaChecked", "true");
    expect(screen.getAllByRole("button", { name: /add path/i }).length).toBeGreaterThan(0);
    // The row it belongs to is unaffected: no other card is marked.
    expect(screen.queryAllByText("disabled")).toHaveLength(1);
  });

  it("keeps a disabled instance in the all-mode chips, muted", async () => {
    const paused = PROVIDERS.map((row) =>
      row.slug === "claude" ? { ...row, status: "disabled" as const } : row);
    renderTab({ providers: { mode: "all" }, model_rewrites: {} }, paused);

    const chip = await screen.findByText("claude");
    expect(chip.className).toContain("line-through");
    expect(chip.getAttribute("title")).toMatch(/disabled and serves no traffic/u);
    expect((await screen.findByText("openai")).className).not.toContain("line-through");
  });

  it("starts individual configuration from an instance the org actually has", async () => {
    renderTab({ providers: { mode: "all" }, model_rewrites: {} });

    // Every instance is allowed in all mode, listed by the slug clients call.
    expect(await screen.findByText("openai-dev")).toBeTruthy();
    await userEvent.click(screen.getByRole("switch", { name: /configure providers individually/i }));

    await waitFor(() =>
      expect(screen.getByText("1 of 3 provider instances enabled")).toBeTruthy());
    expect(screen.getByRole("switch", { name: "Enable openai" }))
      .toHaveProperty("ariaChecked", "true");
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
    const suggested = [...document.querySelectorAll("datalist option")]
      .map((option) => option.getAttribute("value"));

    // A custom-priced model is allowlistable for the row that prices it.
    expect(suggested).toContain("gpt-lab-only");
    expect(suggested).toContain("gpt-5.6-luna");
  });

  it("says what to do when the organization has no instances at all", async () => {
    renderTab(selectedRouting({}), []);

    expect(await screen.findByText(/no provider instances to choose from/i)).toBeTruthy();
  });
});

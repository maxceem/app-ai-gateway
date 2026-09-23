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
    revision: 1,
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
    revision: 1,
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
      <ProxyPolicyTab state={state} />
      {/* What a save would send, so a row on screen can be told from a row in the draft. */}
      <pre data-testid="rewrites">{JSON.stringify(state.draft.config.routing.model_rewrites ?? {})}</pre>
    </>
  );
}

const draftRewrites = () => JSON.parse(screen.getByTestId("rewrites").textContent ?? "null");

function renderTab(routing: ProxyConfig, providers = PROVIDERS) {
  stubApi({
    [`/v1/admin/apps/${APP_ID}`]: {
      body: { app: appRow(routing), config_error: null },
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
  it("makes the default and explicit path policies visible as the list changes", async () => {
    renderTab(selectedRouting({ "openai-dev": { allowed_paths: [], allowed_models: [] } }));

    expect(await screen.findByText("Inference APIs are allowed by default")).toBeTruthy();
    for (const label of [
      "Responses",
      "Chat Completions",
      "Anthropic Messages",
      "Gemini generateContent",
      "Transcription",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }

    await userEvent.click(screen.getAllByRole("button", { name: /add path/i })[0]!);
    expect(screen.getByText("Only listed paths")).toBeTruthy();
    expect(screen.queryByText("Inference APIs are allowed by default")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /remove path/i }));
    expect(screen.getByText("Inference APIs are allowed by default")).toBeTruthy();
    expect(screen.queryByText("Only listed paths")).toBeNull();
  });

  it("switches the organization's instances, not the five provider types", async () => {
    renderTab(selectedRouting({ "openai-dev": { allowed_paths: [], allowed_models: [] } }));

    // One card per instance, named by the row an operator recognises. By
    // heading, not by text: the card's description names the provider type as
    // well, so an instance named after its own brand appears twice.
    expect(await screen.findByRole("heading", { name: "Dev OpenAI" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Prod OpenAI" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Anthropic" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Enable openai-dev" }).getAttribute("aria-checked"))
      .toBe("true");
    expect(screen.getByRole("switch", { name: "Enable openai" }).getAttribute("aria-checked"))
      .toBe("false");
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
    expect(orphan.getAttribute("aria-checked")).toBe("true");

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
    expect(screen.getByRole("switch", { name: "Enable openai-dev" }).getAttribute("aria-checked"))
      .toBe("true");
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
    expect(screen.getByRole("switch", { name: "Enable openai" }).getAttribute("aria-checked"))
      .toBe("true");
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

  /**
   * The map the draft stores cannot hold a row that has no source yet, so the
   * row lives in the card until it is finished. Adding one used to commit it
   * straight to the map, where it was dropped for having an empty key: the
   * button changed nothing and reported nothing.
   */
  it("adds a rewrite row and keeps it while it is being filled in", async () => {
    renderTab({ providers: { mode: "all" }, model_rewrites: {} });

    await userEvent.click(await screen.findByRole("button", { name: /add rewrite/i }));

    const source = screen.getByRole("textbox", { name: /rewrite 1 source model/i });
    expect(screen.queryByText(/no rewrites/i)).toBeNull();

    // Half a rewrite stays on screen, and stays out of the draft: the Worker
    // refuses an entry with an empty target, so saving one would fail.
    await userEvent.type(source, "gpt-5.6-terra");
    expect((source as HTMLInputElement).value).toBe("gpt-5.6-terra");
    expect(draftRewrites()).toEqual({});

    await userEvent.type(
      screen.getByRole("textbox", { name: /rewrite 1 target model/i }),
      "gpt-5.6-luna",
    );
    await waitFor(() =>
      expect(draftRewrites()).toEqual({ "gpt-5.6-terra": "gpt-5.6-luna" }));
  });

  it("adds a second row rather than replacing the first blank one", async () => {
    renderTab({ providers: { mode: "all" }, model_rewrites: {} });

    const add = await screen.findByRole("button", { name: /add rewrite/i });
    await userEvent.click(add);
    await userEvent.click(add);

    expect(screen.getAllByRole("button", { name: /remove rewrite/i })).toHaveLength(2);
  });

  it("edits and removes a rewrite the application already has", async () => {
    renderTab({
      providers: { mode: "all" },
      model_rewrites: { "gpt-5.6-terra": "gpt-5.6-luna", "old-model": "gpt-5.6-luna" },
    });

    const target = await screen.findByRole("textbox", { name: /rewrite 1 target model/i });
    expect((target as HTMLInputElement).value).toBe("gpt-5.6-luna");

    await userEvent.click(screen.getByRole("button", { name: /remove rewrite 2/i }));

    await waitFor(() => expect(draftRewrites()).toEqual({ "gpt-5.6-terra": "gpt-5.6-luna" }));
    expect(screen.getAllByRole("button", { name: /remove rewrite/i })).toHaveLength(1);
  });

  it("says what to do when the organization has no instances at all", async () => {
    renderTab(selectedRouting({}), []);

    expect(await screen.findByText(/no provider instances to choose from/i)).toBeTruthy();
  });
});

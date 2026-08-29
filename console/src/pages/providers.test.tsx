import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProvidersPage, draftsToPricing } from "./providers";
import { renderAuthenticated } from "@/test/render";
import type { ProviderCredential, ProviderGateway } from "@/lib/types";

const SECRET = "sk-live-never-shown-again";

const DIRECT: ProviderCredential = {
  id: "provider-1",
  type: "openai",
  slug: "openai",
  name: "Prod OpenAI",
  secretHint: "gain",
  providerGatewayId: null,
  pricing: { "gpt-brand-new": { input: 1.25, output: 10 } },
  status: "active",
  createdAt: "2026-02-01T00:00:00.000Z",
  createdBy: "user-1",
};

const VIA_GATEWAY: ProviderCredential = {
  ...DIRECT,
  id: "provider-2",
  type: "anthropic",
  slug: "anthropic-cf",
  name: "Anthropic via CF",
  // A routed row owns no secret at all: the gateway token authenticates it.
  secretHint: null,
  providerGatewayId: "gw-1",
  pricing: null,
};

const GATEWAY: ProviderGateway = {
  id: "gw-1",
  type: "cf_aig",
  name: "Prod CF gateway",
  config: { accountId: "acct-1", gatewayId: "cf-gw" },
  secretHint: "9xyz",
  providerCount: 1,
  referencedCount: 1,
  status: "active",
  createdAt: "2026-02-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
  createdBy: "user-1",
};

/** Nothing references this one, so it may be deleted. */
const SPARE_GATEWAY: ProviderGateway = {
  ...GATEWAY,
  id: "gw-2",
  name: "Spare gateway",
  providerCount: 0,
  referencedCount: 0,
};

/**
 * Serves no traffic, but revoked rows still hold its foreign key — the API
 * refuses to delete it just the same.
 */
const RETIRED_GATEWAY: ProviderGateway = {
  ...GATEWAY,
  id: "gw-3",
  name: "Retired gateway",
  providerCount: 0,
  referencedCount: 2,
};

const CREATED_GATEWAY: ProviderGateway = {
  ...GATEWAY,
  id: "gw-new",
  name: "Fresh gateway",
  providerCount: 0,
  referencedCount: 0,
};

interface Call {
  url: string;
  method: string;
  body: any;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * Mirrors the admin API the page talks to: providers and provider gateways are
 * two separate collections, and a gateway id is the only link between them.
 */
function stubProviders(
  options: {
    providers?: ProviderCredential[];
    gateways?: ProviderGateway[];
    createProvider?: { status: number; body: unknown };
  } = {},
) {
  const providers = options.providers ?? [DIRECT, VIA_GATEWAY];
  const gateways = options.gateways ?? [GATEWAY];
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    if (url.includes("/v1/admin/provider-gateways")) {
      if (method === "GET") return json({ gateways });
      if (method === "DELETE") return json({ deleted: true, provider_gateway_id: SPARE_GATEWAY.id });
      if (method === "PATCH") return json({ gateway: { ...GATEWAY, name: "Renamed gateway" } });
      // Create and rotate answer with the same envelope.
      return json({ gateway: CREATED_GATEWAY, validated: true }, url.endsWith("/rotate") ? 200 : 201);
    }
    if (method === "POST") {
      const stub = options.createProvider;
      return stub ? json(stub.body, stub.status) : json({ provider: DIRECT, validated: true }, 201);
    }
    if (method === "PUT") return json({ provider: DIRECT, validated: true });
    if (method === "DELETE") return json({ deleted: true, provider_id: DIRECT.id });
    return json({ providers });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

/** Radix renders its listbox in a portal, so options are found on the screen. */
async function choose(trigger: HTMLElement, option: RegExp | string) {
  await userEvent.click(trigger);
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

afterEach(() => vi.unstubAllGlobals());

describe("draftsToPricing", () => {
  it("drops an entirely blank row and keeps a deliberate zero", () => {
    expect(draftsToPricing([
      { model: "free-model", input: "0", output: "0" },
      { model: "", input: "", output: "" },
    ])).toEqual({ pricing: { "free-model": { input: 0, output: 0 } } });
  });

  it.each([
    ["an empty input price", { model: "m", input: "", output: "2" }],
    ["an empty output price", { model: "m", input: "1", output: "" }],
    ["whitespace instead of a price", { model: "m", input: " ", output: "2" }],
  ])("refuses to read %s as free", (_label, draft) => {
    // Number("") is 0, so an empty field must never become a $0 allowance.
    expect(draftsToPricing([draft])).toEqual({
      error: "Enter both prices for m — use 0 only if it is genuinely free",
    });
  });

  it("rejects a duplicated model instead of letting the last row win", () => {
    expect(draftsToPricing([
      { model: "m", input: "1", output: "2" },
      { model: " m ", input: "3", output: "4" },
    ])).toEqual({ error: "m is priced twice — remove the duplicate row" });
  });

  it("names the row that cannot be saved", () => {
    expect(draftsToPricing([{ model: "m", input: "-1", output: "2" }]))
      .toEqual({ error: "Prices for m must be numbers of 0 or more" });
    expect(draftsToPricing([{ model: "", input: "1", output: "2" }]))
      .toEqual({ error: "Every pricing row needs a model name" });
  });
});

describe("ProvidersPage", () => {
  it("lists each instance by slug, hint and the gateway it is routed through", async () => {
    stubProviders();
    renderAuthenticated(<ProvidersPage />);

    const direct = (await screen.findByText("Prod OpenAI")).closest("tr")!;
    const routed = screen.getByText("Anthropic via CF").closest("tr")!;

    // The slug is the URL segment callers use, so it is shown verbatim.
    expect(within(direct).getByText("openai")).toBeTruthy();
    expect(within(routed).getByText("anthropic-cf")).toBeTruthy();
    expect(within(direct).getByText("…gain")).toBeTruthy();
    expect(within(direct).getByText("Direct")).toBeTruthy();
    // The gateway's name, not the opaque Cloudflare gateway id.
    expect(within(routed).getByText("Prod CF gateway")).toBeTruthy();
    expect(within(routed).queryByText(/cf-gw/)).toBeNull();
  });

  it("offers onboarding copy when nothing is configured", async () => {
    stubProviders({ providers: [], gateways: [] });
    renderAuthenticated(<ProvidersPage />);

    expect(await screen.findByText(/add a key per provider/i)).toBeTruthy();
    expect(screen.getByText(/no gateways yet/i)).toBeTruthy();
  });

  it("submits a new key and clears it from the form afterwards", async () => {
    const calls = stubProviders({ providers: [], gateways: [] });
    renderAuthenticated(<ProvidersPage />);

    await userEvent.type(await screen.findByLabelText("Name"), "Prod OpenAI");
    const secretField = screen.getByLabelText("API key");
    await userEvent.type(secretField, SECRET);
    await userEvent.click(screen.getByRole("button", { name: /add provider/i }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.method === "POST");
      expect(call?.body).toEqual({ type: "openai", name: "Prod OpenAI", secret: SECRET });
    });
    // The plaintext exists nowhere the operator or the cache can read it back.
    await waitFor(() => expect((secretField as HTMLInputElement).value).toBe(""));
    expect(secretField.getAttribute("type")).toBe("password");
    // autocomplete="off" is ignored on login-shaped forms, which is how the
    // operator's own saved password ended up in a provider key field.
    expect(secretField.getAttribute("autocomplete")).toBe("new-password");
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("opts every credential field out of browser and manager autofill", async () => {
    stubProviders({ providers: [], gateways: [] });
    renderAuthenticated(<ProvidersPage />);

    const secretFields = [await screen.findByLabelText("API key")];
    const plainFields = [screen.getByLabelText("Name")];

    await userEvent.click(screen.getByRole("button", { name: /add gateway/i }));
    const dialog = await screen.findByRole("dialog");
    secretFields.push(within(dialog).getByLabelText("Gateway token"));
    plainFields.push(
      within(dialog).getByLabelText("Account ID"),
      within(dialog).getByLabelText("Gateway ID"),
      within(dialog).getByLabelText("Name"),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));

    for (const field of secretFields) {
      expect(field.getAttribute("autocomplete")).toBe("new-password");
    }
    // The text inputs matter too: a field beside a password is what makes the
    // browser treat the whole form as a sign-in and offer a saved username.
    for (const field of plainFields) {
      expect(field.getAttribute("autocomplete")).toBe("off");
    }
    for (const field of [...secretFields, ...plainFields]) {
      expect(field.getAttribute("data-1p-ignore")).toBe("true");
      expect(field.getAttribute("data-lpignore")).toBe("true");
    }
  });

  it("adds a provider through an existing gateway instead of a key", async () => {
    const calls = stubProviders({ providers: [], gateways: [GATEWAY] });
    renderAuthenticated(<ProvidersPage />);

    await userEvent.type(await screen.findByLabelText("Name"), "OpenAI via CF");
    await choose(screen.getByLabelText("Connection"), /via gateway/i);
    // A routed instance carries no secret of its own.
    expect(screen.queryByLabelText("API key")).toBeNull();
    await choose(screen.getByLabelText("Gateway"), /prod cf gateway/i);
    await userEvent.click(screen.getByRole("button", { name: /add provider/i }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.method === "POST");
      expect(call?.url).toContain("/v1/admin/providers");
      expect(call?.body).toEqual({
        type: "openai",
        name: "OpenAI via CF",
        providerGatewayId: "gw-1",
      });
    });
  });

  it("creates a gateway from the add-provider form and keeps it selected", async () => {
    const calls = stubProviders({ providers: [], gateways: [] });
    renderAuthenticated(<ProvidersPage />);

    await userEvent.type(await screen.findByLabelText("Name"), "OpenAI via CF");
    await choose(screen.getByLabelText("Connection"), /via gateway/i);
    await choose(screen.getByLabelText("Gateway"), /configure new gateway/i);

    const dialog = await screen.findByRole("dialog");
    await userEvent.clear(within(dialog).getByLabelText("Name"));
    await userEvent.type(within(dialog).getByLabelText("Name"), "Fresh gateway");
    await userEvent.type(within(dialog).getByLabelText("Account ID"), "acct-1");
    await userEvent.type(within(dialog).getByLabelText("Gateway ID"), "cf-gw");
    await userEvent.type(within(dialog).getByLabelText("Gateway token"), "cf-aig-run-token");
    await userEvent.click(within(dialog).getByRole("button", { name: /save gateway/i }));

    await waitFor(() => {
      const call = calls.find(
        (entry) => entry.method === "POST" && entry.url.endsWith("/provider-gateways"),
      );
      expect(call?.body).toEqual({
        type: "cf_aig",
        name: "Fresh gateway",
        accountId: "acct-1",
        gatewayId: "cf-gw",
        token: "cf-aig-run-token",
      });
    });
    // Saving the gateway only pre-selects it; the provider is still being added.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.some((entry) => entry.method === "POST" && entry.url.endsWith("/providers")))
      .toBe(false);

    await userEvent.click(screen.getByRole("button", { name: /add provider/i }));
    await waitFor(() => {
      const call = calls.find(
        (entry) => entry.method === "POST" && entry.url.endsWith("/providers"),
      );
      expect(call?.body).toMatchObject({ providerGatewayId: CREATED_GATEWAY.id });
    });
  });

  it("adds a gateway on its own, with no provider selection", async () => {
    const calls = stubProviders({ providers: [], gateways: [] });
    renderAuthenticated(<ProvidersPage />);

    await userEvent.click(await screen.findByRole("button", { name: /add gateway/i }));
    const dialog = await screen.findByRole("dialog");
    // The old batch flow picked provider types here; each row is added on its own now.
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    await userEvent.type(within(dialog).getByLabelText("Account ID"), "acct-1");
    await userEvent.type(within(dialog).getByLabelText("Gateway ID"), "cf-gw");
    const tokenField = within(dialog).getByLabelText("Gateway token");
    await userEvent.type(tokenField, "cf-aig-run-token");
    await userEvent.click(within(dialog).getByRole("button", { name: /save gateway/i }));

    await waitFor(() => {
      expect(calls.some((entry) => entry.method === "POST" && entry.url.endsWith("/provider-gateways")))
        .toBe(true);
    });
    expect(calls.some((entry) => entry.method === "POST" && entry.url.endsWith("/providers")))
      .toBe(false);
    expect(document.body.textContent).not.toContain("cf-aig-run-token");
  });

  it("links a routed provider to its gateway's row", async () => {
    stubProviders();
    renderAuthenticated(<ProvidersPage />);

    const link = await screen.findByRole("link", { name: "Prod CF gateway" });
    expect(link.getAttribute("href")).toBe("#gateway-gw-1");
    // The anchor exists, so the link lands on the gateway's own row.
    expect(document.getElementById("gateway-gw-1")).toBeTruthy();
  });

  it("refreshes the gateway counts when a routed provider is added", async () => {
    const calls = stubProviders({ providers: [], gateways: [GATEWAY] });
    renderAuthenticated(<ProvidersPage />);
    const gatewayReads = () =>
      calls.filter((entry) => entry.method === "GET" && entry.url.includes("provider-gateways"))
        .length;

    await waitFor(() => expect(gatewayReads()).toBe(1));
    await userEvent.type(await screen.findByLabelText("Name"), "OpenAI via CF");
    await choose(screen.getByLabelText("Connection"), /via gateway/i);
    await choose(screen.getByLabelText("Gateway"), /prod cf gateway/i);
    await userEvent.click(screen.getByRole("button", { name: /add provider/i }));

    // The new row moves the gateway's providerCount, which is what decides
    // whether its delete action stays available.
    await waitFor(() => expect(gatewayReads()).toBe(2));
  });

  it("refreshes the gateway counts when a provider is deleted", async () => {
    const calls = stubProviders();
    renderAuthenticated(<ProvidersPage />);
    const gatewayReads = () =>
      calls.filter((entry) => entry.method === "GET" && entry.url.includes("provider-gateways"))
        .length;

    await waitFor(() => expect(gatewayReads()).toBe(1));
    await userEvent.click(await screen.findByRole("button", { name: /delete prod openai/i }));
    await userEvent.click(screen.getByRole("button", { name: /^delete provider$/i }));

    await waitFor(() => expect(gatewayReads()).toBe(2));
  });

  it("leaves the default slug free when the only instance chose a custom one", async () => {
    // The type is configured, but nothing holds `openai`, so the next instance
    // may still take the default and needs no manual slug.
    stubProviders({ providers: [{ ...DIRECT, slug: "openai-legacy" }], gateways: [] });
    renderAuthenticated(<ProvidersPage />);

    await screen.findByText("openai-legacy");
    expect(screen.queryByLabelText("Slug")).toBeNull();
  });

  it("asks for a slug only once the default one is taken", async () => {
    const calls = stubProviders({ providers: [DIRECT], gateways: [] });
    renderAuthenticated(<ProvidersPage />);

    // OpenAI is taken, so the default slug is unavailable and must be replaced.
    const slugField = await screen.findByLabelText("Slug");
    await userEvent.type(await screen.findByLabelText("Name"), "Dev OpenAI");
    await userEvent.type(screen.getByLabelText("API key"), SECRET);
    expect(screen.getByRole("button", { name: /add provider/i }))
      .toHaveProperty("disabled", true);

    await userEvent.type(slugField, "openai-dev");
    await userEvent.click(screen.getByRole("button", { name: /add provider/i }));
    await waitFor(() => {
      const call = calls.find((entry) => entry.method === "POST");
      expect(call?.body).toMatchObject({ slug: "openai-dev", type: "openai" });
    });

    // A type with no instance keeps today's URLs, so the field disappears.
    await choose(screen.getByLabelText("Provider"), /gemini/i);
    expect(screen.queryByLabelText("Slug")).toBeNull();
  });

  it("reveals and focuses the slug field when the API reports the slug taken", async () => {
    stubProviders({
      providers: [],
      gateways: [],
      createProvider: {
        status: 409,
        body: { error: { code: "slug_taken", message: "An active provider instance already uses slug openai" } },
      },
    });
    renderAuthenticated(<ProvidersPage />);

    // The client's list said nothing was configured, so no slug was asked for.
    await userEvent.type(await screen.findByLabelText("Name"), "Prod OpenAI");
    expect(screen.queryByLabelText("Slug")).toBeNull();
    await userEvent.type(screen.getByLabelText("API key"), SECRET);
    await userEvent.click(screen.getByRole("button", { name: /add provider/i }));

    const slugField = await screen.findByLabelText("Slug");
    await waitFor(() => expect(document.activeElement).toBe(slugField));
  });

  it("lists gateways with their connection, hint and provider count", async () => {
    stubProviders({ gateways: [GATEWAY, SPARE_GATEWAY, RETIRED_GATEWAY] });
    renderAuthenticated(<ProvidersPage />);

    const spare = (await screen.findByText("Spare gateway")).closest("tr")!;
    expect(within(spare).getByText("acct-1 · cf-gw")).toBeTruthy();
    expect(within(spare).getByText("…9xyz")).toBeTruthy();
    // The column counts what the gateway serves, not what merely references it.
    const retired = screen.getByText("Retired gateway").closest("tr")!;
    expect(within(retired).getByText("0")).toBeTruthy();
    // A gateway still in use cannot be deleted, and says why.
    expect(screen.getByRole("button", { name: /delete prod cf gateway/i }))
      .toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /delete spare gateway/i }))
      .toHaveProperty("disabled", false);
  });

  it("blocks deleting a gateway only revoked rows still reference", async () => {
    stubProviders({ gateways: [RETIRED_GATEWAY] });
    renderAuthenticated(<ProvidersPage />);

    // Nothing routes through it, but the foreign key counts revoked rows too,
    // so "delete the active instances first" would be unactionable advice.
    const blocked = await screen.findByRole("button", { name: /delete retired gateway/i });
    expect(blocked).toHaveProperty("disabled", true);
    expect(screen.getByText(/revoked provider instances still reference this gateway/i))
      .toBeTruthy();
  });

  it("rotates the gateway token once for every provider behind it", async () => {
    const calls = stubProviders();
    renderAuthenticated(<ProvidersPage />);

    const gatewayRow = (await screen.findByText("acct-1 · cf-gw")).closest("tr")!;
    await userEvent.click(within(gatewayRow).getByRole("button", { name: "Rotate" }));
    await userEvent.type(await screen.findByLabelText("New gateway token"), "cf-aig-new-token");
    await userEvent.click(screen.getByRole("button", { name: /rotate token/i }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.url.includes("/rotate"));
      expect(call?.url).toContain("/v1/admin/provider-gateways/gw-1/rotate");
      expect(call?.body).toEqual({ token: "cf-aig-new-token" });
    });
    expect(document.body.textContent).not.toContain("cf-aig-new-token");
  });

  it("renames a gateway without touching its connection", async () => {
    const calls = stubProviders();
    renderAuthenticated(<ProvidersPage />);

    const gatewayRow = (await screen.findByText("acct-1 · cf-gw")).closest("tr")!;
    await userEvent.click(within(gatewayRow).getByRole("button", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.clear(within(dialog).getByLabelText("Name"));
    await userEvent.type(within(dialog).getByLabelText("Name"), "Renamed gateway");
    await userEvent.click(within(dialog).getByRole("button", { name: /save name/i }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.method === "PATCH");
      expect(call?.url).toContain("/v1/admin/provider-gateways/gw-1");
      expect(call?.body).toEqual({ name: "Renamed gateway" });
    });
  });

  it("deletes a gateway nothing routes through", async () => {
    const calls = stubProviders({ gateways: [SPARE_GATEWAY] });
    renderAuthenticated(<ProvidersPage />);

    await userEvent.click(await screen.findByRole("button", { name: /delete spare gateway/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^delete gateway$/i }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.method === "DELETE");
      expect(call?.url).toContain("/v1/admin/provider-gateways/gw-2");
    });
  });

  it("rotates a credential in place", async () => {
    const calls = stubProviders();
    renderAuthenticated(<ProvidersPage />);

    const row = (await screen.findByText("Prod OpenAI")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Rotate" }));
    await userEvent.type(await screen.findByLabelText("New API key"), "sk-rotated");
    await userEvent.click(screen.getByRole("button", { name: /rotate key/i }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.method === "PUT");
      expect(call?.url).toContain("/v1/admin/providers/provider-1");
      expect(call?.body).toEqual({ secret: "sk-rotated" });
    });
    expect(document.body.textContent).not.toContain("sk-rotated");
  });

  it("sends a gateway-routed row to the gateway for rotation", async () => {
    stubProviders();
    renderAuthenticated(<ProvidersPage />);

    const row = (await screen.findByText("Anthropic via CF")).closest("tr")!;
    const rotate = within(row).getByRole("button", { name: "Rotate" });
    expect(rotate).toHaveProperty("disabled", true);
    expect(rotate.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("edits custom model pricing without touching the credential", async () => {
    const calls = stubProviders();
    renderAuthenticated(<ProvidersPage />);

    await userEvent.click((await screen.findAllByRole("button", { name: "Pricing" }))[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByDisplayValue("gpt-brand-new")).toBeTruthy();

    await userEvent.click(within(dialog).getByRole("button", { name: /add model/i }));
    await userEvent.type(within(dialog).getByLabelText("Model 2"), "another-model");
    await userEvent.type(within(dialog).getByLabelText("Input price 2"), "2");
    await userEvent.type(within(dialog).getByLabelText("Output price 2"), "4");
    await userEvent.click(within(dialog).getByRole("button", { name: /save pricing/i }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.method === "PUT");
      expect(call?.body).toEqual({
        pricing: {
          "gpt-brand-new": { input: 1.25, output: 10 },
          "another-model": { input: 2, output: 4 },
        },
      });
      // Nothing about the credential travels with a pricing edit.
      expect(call?.body.secret).toBeUndefined();
    });
  });

  it("refuses to save a pricing row with a missing price", async () => {
    const calls = stubProviders();
    const errorToast = vi.spyOn(toast, "error");
    renderAuthenticated(<ProvidersPage />);

    await userEvent.click((await screen.findAllByRole("button", { name: "Pricing" }))[0]!);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /add model/i }));
    await userEvent.type(within(dialog).getByLabelText("Model 2"), "half-priced");
    await userEvent.type(within(dialog).getByLabelText("Input price 2"), "2");
    await userEvent.click(within(dialog).getByRole("button", { name: /save pricing/i }));

    await waitFor(() => {
      expect(errorToast).toHaveBeenCalledWith(
        "Enter both prices for half-priced — use 0 only if it is genuinely free",
      );
    });
    // Nothing was sent, and the dialog stays open on the row that needs fixing.
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("spells out that deleting breaks apps within a minute", async () => {
    const calls = stubProviders();
    renderAuthenticated(<ProvidersPage />);

    await userEvent.click(await screen.findByRole("button", { name: /delete prod openai/i }));
    expect(await screen.findByText(/start failing within a minute/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^delete provider$/i }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "DELETE" && call.url.includes("/providers/")))
        .toBe(true);
    });
  });

  it("stops a read-only member changing anything", async () => {
    stubProviders();
    renderAuthenticated(<ProvidersPage />, { session: { role: "member" } });

    await screen.findByText("Prod OpenAI");
    expect(screen.getByRole("button", { name: /add provider/i })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /add gateway/i })).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("API key")).toHaveProperty("disabled", true);
    for (const button of screen.getAllByRole("button", { name: "Rotate" })) {
      expect(button).toHaveProperty("disabled", true);
    }
  });
});

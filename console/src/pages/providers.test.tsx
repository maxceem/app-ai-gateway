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
    testProvider?: { status: number; body: unknown };
    testGateway?: { status: number; body: unknown };
    createGateway?: { status: number; body: unknown };
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
      if (url.endsWith("/test")) {
        const stub = options.testGateway;
        return stub ? json(stub.body, stub.status) : json({ validated: true });
      }
      const stub = options.createGateway;
      if (stub && !url.endsWith("/rotate")) return json(stub.body, stub.status);
      // Create and rotate answer with the same envelope.
      return json({ gateway: CREATED_GATEWAY, validated: true }, url.endsWith("/rotate") ? 200 : 201);
    }
    if (url.endsWith("/v1/admin/providers/test")) {
      const stub = options.testProvider;
      return stub ? json(stub.body, stub.status) : json({ validated: true });
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

/**
 * The newest dialog. Radix hides the layers below it from the accessibility
 * tree, but the gateway modal opens on top of the provider one, and both carry
 * a "Name" field — every query has to say which of them it means.
 */
async function topDialog(): Promise<HTMLElement> {
  const dialogs = await screen.findAllByRole("dialog");
  return dialogs[dialogs.length - 1]!;
}

/** Every row action lives behind the row's menu, so a test opens that first. */
async function openRowActions(label: string): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole("button", { name: `Actions for ${label}` }));
  return await screen.findByRole("menu");
}

/** Opens a row's menu and runs one of its actions. */
async function runRowAction(label: string, action: RegExp) {
  const menu = await openRowActions(label);
  await userEvent.click(within(menu).getByRole("menuitem", { name: action }));
}

/** Providers are added the same way apps and management keys are: in a modal. */
async function openAddProvider(): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole("button", { name: /new provider/i }));
  return topDialog();
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

  it("submits a new key from the modal and leaves nothing behind", async () => {
    const calls = stubProviders({ providers: [], gateways: [] });
    renderAuthenticated(<ProvidersPage />);

    const dialog = await openAddProvider();
    await userEvent.type(within(dialog).getByLabelText("Name"), "Prod OpenAI");
    const secretField = within(dialog).getByLabelText("API key");
    await userEvent.type(secretField, SECRET);
    expect(secretField.getAttribute("type")).toBe("password");
    // autocomplete="off" is ignored on login-shaped forms, which is how the
    // operator's own saved password ended up in a provider key field.
    expect(secretField.getAttribute("autocomplete")).toBe("new-password");
    await userEvent.click(within(dialog).getByRole("button", { name: /add provider/i }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.method === "POST");
      expect(call?.body).toEqual({ type: "openai", name: "Prod OpenAI", secret: SECRET });
    });
    // Creating finishes in the modal, so it closes on success.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.textContent).not.toContain(SECRET);

    // The plaintext exists nowhere the operator or the cache can read it back.
    const reopened = await openAddProvider();
    expect((within(reopened).getByLabelText("API key") as HTMLInputElement).value).toBe("");
    expect((within(reopened).getByLabelText("Name") as HTMLInputElement).value).toBe("");
  });

  it("opts every credential field out of browser and manager autofill", async () => {
    stubProviders({ providers: [], gateways: [] });
    renderAuthenticated(<ProvidersPage />);

    const provider = await openAddProvider();
    const secretFields = [within(provider).getByLabelText("API key")];
    const plainFields = [within(provider).getByLabelText("Name")];
    await userEvent.click(within(provider).getByRole("button", { name: /cancel/i }));

    await userEvent.click(screen.getByRole("button", { name: /add gateway/i }));
    const dialog = await topDialog();
    secretFields.push(within(dialog).getByLabelText("Gateway token"));
    plainFields.push(
      within(dialog).getByLabelText("Cloudflare Account ID"),
      within(dialog).getByLabelText("Cloudflare Gateway ID"),
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

    const dialog = await openAddProvider();
    await userEvent.type(within(dialog).getByLabelText("Name"), "OpenAI via CF");
    await choose(within(dialog).getByLabelText("Authentication"), /use gateway/i);
    // A routed instance carries no secret of its own.
    expect(within(dialog).queryByLabelText("API key")).toBeNull();
    await choose(within(dialog).getByLabelText("Gateway"), /prod cf gateway/i);
    await userEvent.click(within(dialog).getByRole("button", { name: /add provider/i }));

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

  it("creates a gateway in a second modal without losing the provider", async () => {
    const calls = stubProviders({ providers: [], gateways: [] });
    renderAuthenticated(<ProvidersPage />);

    const provider = await openAddProvider();
    await userEvent.type(within(provider).getByLabelText("Name"), "OpenAI via CF");
    await choose(within(provider).getByLabelText("Authentication"), /use gateway/i);
    await choose(within(provider).getByLabelText("Gateway"), /new gateway/i);

    // The gateway modal opens on top of the provider one, which keeps its state.
    const dialog = await topDialog();
    expect(dialog).not.toBe(provider);
    await userEvent.clear(within(dialog).getByLabelText("Name"));
    await userEvent.type(within(dialog).getByLabelText("Name"), "Fresh gateway");
    await userEvent.type(within(dialog).getByLabelText("Cloudflare Account ID"), "acct-1");
    await userEvent.type(within(dialog).getByLabelText("Cloudflare Gateway ID"), "cf-gw");
    await userEvent.type(within(dialog).getByLabelText("Gateway token"), "cf-aig-run-token");
    await userEvent.click(within(dialog).getByRole("button", { name: /^add gateway$/i }));

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
    // Only the gateway modal closes; the provider it was created for is still
    // half-written underneath, with the new gateway pre-selected.
    await waitFor(() => expect(screen.queryByLabelText("Gateway token")).toBeNull());
    expect(within(provider).getByLabelText("Name")).toHaveProperty("value", "OpenAI via CF");
    expect(calls.some((entry) => entry.method === "POST" && entry.url.endsWith("/providers")))
      .toBe(false);

    await userEvent.click(within(provider).getByRole("button", { name: /add provider/i }));
    await waitFor(() => {
      const call = calls.find(
        (entry) => entry.method === "POST" && entry.url.endsWith("/providers"),
      );
      expect(call?.body).toMatchObject({ providerGatewayId: CREATED_GATEWAY.id });
    });
  });

  it("checks a credential on request without storing it", async () => {
    const calls = stubProviders({ providers: [], gateways: [] });
    renderAuthenticated(<ProvidersPage />);

    const dialog = await openAddProvider();
    const test = within(dialog).getByRole("button", { name: /test provider/i });
    // Nothing to check until a credential is entered.
    expect(test).toHaveProperty("disabled", true);

    await userEvent.type(within(dialog).getByLabelText("API key"), SECRET);
    expect(test).toHaveProperty("disabled", false);
    await userEvent.click(test);

    expect(await within(dialog).findByText(/the provider accepted this credential/i)).toBeTruthy();
    const probe = calls.find((entry) => entry.url.endsWith("/providers/test"));
    expect(probe?.method).toBe("POST");
    expect(probe?.body).toEqual({ type: "openai", secret: SECRET });
    // A test is not a create: the modal stays open and nothing was stored.
    expect(calls.some((entry) => entry.method === "POST" && entry.url.endsWith("/providers")))
      .toBe(false);
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("does not gate adding a provider on the test, and drops a stale verdict", async () => {
    const calls = stubProviders({
      providers: [],
      gateways: [],
      testProvider: {
        status: 400,
        body: {
          error: {
            code: "provider_key_invalid",
            message: "The credential was rejected by the provider (HTTP 401)",
          },
        },
      },
    });
    renderAuthenticated(<ProvidersPage />);

    const dialog = await openAddProvider();
    await userEvent.type(within(dialog).getByLabelText("Name"), "Prod OpenAI");
    await userEvent.type(within(dialog).getByLabelText("API key"), "sk-wrong");
    await userEvent.click(within(dialog).getByRole("button", { name: /test provider/i }));

    expect(await within(dialog).findByText(/rejected by the provider/i)).toBeTruthy();
    // A failed check is advice, not a lock: the operator may still add it.
    const add = within(dialog).getByRole("button", { name: /add provider/i });
    expect(add).toHaveProperty("disabled", false);

    // Editing the credential retires the verdict, which was about the old one.
    await userEvent.type(within(dialog).getByLabelText("API key"), "-corrected");
    expect(within(dialog).queryByText(/rejected by the provider/i)).toBeNull();

    await userEvent.click(add);
    await waitFor(() => {
      const call = calls.find(
        (entry) => entry.method === "POST" && entry.url.endsWith("/providers"),
      );
      expect(call?.body).toMatchObject({ secret: "sk-wrong-corrected" });
    });
  });

  it("names what stopped a gateway check instead of calling it inconclusive", async () => {
    stubProviders({
      providers: [],
      gateways: [GATEWAY],
      testProvider: {
        status: 200,
        body: { validated: false, reason: "unexpected_status", status: 400 },
      },
    });
    renderAuthenticated(<ProvidersPage />);

    const dialog = await openAddProvider();
    await choose(within(dialog).getByLabelText("Authentication"), /use gateway/i);
    await choose(within(dialog).getByLabelText("Gateway"), /prod cf gateway/i);
    await userEvent.click(within(dialog).getByRole("button", { name: /test provider/i }));

    // The status is the operator's only clue about which end is misconfigured.
    const refused = await within(dialog).findByText(/gateway answered with HTTP 400/i);
    expect(refused.textContent).toMatch(/stored key for OpenAI/i);
    // Something rejected the request, so it reads as the error it is.
    expect(refused.className).toContain("text-destructive");
  });

  it("keeps an upstream outage neutral rather than blaming the credential", async () => {
    stubProviders({
      providers: [],
      gateways: [],
      testProvider: {
        status: 200,
        body: { validated: false, reason: "unexpected_status", status: 503 },
      },
    });
    renderAuthenticated(<ProvidersPage />);

    const dialog = await openAddProvider();
    await userEvent.type(within(dialog).getByLabelText("API key"), SECRET);
    await userEvent.click(within(dialog).getByRole("button", { name: /test provider/i }));

    // A provider having a moment proves nothing either way, so it is not an error.
    const line = await within(dialog).findByText(/HTTP 503/i);
    expect(line.textContent).toMatch(/nothing is proven either way/i);
    expect(line.className).not.toContain("text-destructive");
  });

  it("says when a provider has no check of its own", async () => {
    stubProviders({
      providers: [],
      gateways: [],
      testProvider: { status: 200, body: { validated: false, reason: "no_probe" } },
    });
    renderAuthenticated(<ProvidersPage />);

    const dialog = await openAddProvider();
    await choose(within(dialog).getByLabelText("Provider"), /perplexity/i);
    await userEvent.type(within(dialog).getByLabelText("API key"), SECRET);
    await userEvent.click(within(dialog).getByRole("button", { name: /test provider/i }));

    expect(await within(dialog).findByText(/no test call for Perplexity/i)).toBeTruthy();
  });

  it("adds a gateway on its own, with no provider selection", async () => {
    const calls = stubProviders({ providers: [], gateways: [] });
    renderAuthenticated(<ProvidersPage />);

    await userEvent.click(await screen.findByRole("button", { name: /add gateway/i }));
    const dialog = await topDialog();
    // The old batch flow picked provider types here; each row is added on its own now.
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    await userEvent.type(within(dialog).getByLabelText("Cloudflare Account ID"), "acct-1");
    await userEvent.type(within(dialog).getByLabelText("Cloudflare Gateway ID"), "cf-gw");
    const tokenField = within(dialog).getByLabelText("Gateway token");
    await userEvent.type(tokenField, "cf-aig-run-token");
    await userEvent.click(within(dialog).getByRole("button", { name: /^add gateway$/i }));

    await waitFor(() => {
      expect(calls.some((entry) => entry.method === "POST" && entry.url.endsWith("/provider-gateways")))
        .toBe(true);
    });
    expect(calls.some((entry) => entry.method === "POST" && entry.url.endsWith("/providers")))
      .toBe(false);
    expect(document.body.textContent).not.toContain("cf-aig-run-token");
  });

  it("checks a gateway connection on demand, without storing it", async () => {
    const calls = stubProviders({ providers: [], gateways: [] });
    renderAuthenticated(<ProvidersPage />);

    await userEvent.click(await screen.findByRole("button", { name: /add gateway/i }));
    const dialog = await topDialog();
    await userEvent.type(within(dialog).getByLabelText("Cloudflare Account ID"), "acct-1");
    await userEvent.type(within(dialog).getByLabelText("Cloudflare Gateway ID"), "cf-gw");
    await userEvent.type(within(dialog).getByLabelText("Gateway token"), "cf-aig-probe-token");
    await userEvent.click(within(dialog).getByRole("button", { name: /test gateway/i }));

    expect(await within(dialog).findByText(/the gateway accepted this token/i)).toBeTruthy();
    const test = calls.find((entry) => entry.url.endsWith("/provider-gateways/test"));
    expect(test?.body).toEqual({
      type: "cf_aig",
      accountId: "acct-1",
      gatewayId: "cf-gw",
      token: "cf-aig-probe-token",
    });
    // A dry run stores nothing: the form is still open on the same fields.
    expect(calls.some((entry) =>
      entry.method === "POST" && entry.url.endsWith("/provider-gateways"))).toBe(false);
    expect(document.body.textContent).not.toContain("cf-aig-probe-token");
  });

  it("says a refused token can still be saved, and drops the verdict when it changes", async () => {
    stubProviders({
      providers: [],
      gateways: [],
      testGateway: { status: 200, body: { validated: false, reason: "rejected", status: 401 } },
    });
    renderAuthenticated(<ProvidersPage />);

    await userEvent.click(await screen.findByRole("button", { name: /add gateway/i }));
    const dialog = await topDialog();
    await userEvent.type(within(dialog).getByLabelText("Cloudflare Account ID"), "acct-1");
    await userEvent.type(within(dialog).getByLabelText("Cloudflare Gateway ID"), "cf-gw");
    await userEvent.type(within(dialog).getByLabelText("Gateway token"), "cf-aig-bad-token");
    await userEvent.click(within(dialog).getByRole("button", { name: /test gateway/i }));

    // The refusal names both things it can mean, and never disables the submit.
    const line = await within(dialog).findByText(/refused this token \(HTTP 401\)/i);
    expect(line.textContent).toMatch(/authentication is turned on/i);
    expect(within(dialog).getByRole("button", { name: /^add gateway$/i }))
      .toHaveProperty("disabled", false);

    // A verdict belongs to the connection that was probed, not the next one.
    await userEvent.type(within(dialog).getByLabelText("Cloudflare Gateway ID"), "-2");
    expect(within(dialog).queryByText(/refused this token/i)).toBeNull();
  });

  it("stores a gateway the probe could not confirm, and says so", async () => {
    const warn = vi.spyOn(toast, "warning");
    const calls = stubProviders({
      providers: [],
      gateways: [],
      createGateway: {
        status: 201,
        body: { gateway: CREATED_GATEWAY, validated: false, reason: "rejected", status: 401 },
      },
    });
    renderAuthenticated(<ProvidersPage />);

    await userEvent.click(await screen.findByRole("button", { name: /add gateway/i }));
    const dialog = await topDialog();
    await userEvent.type(within(dialog).getByLabelText("Cloudflare Account ID"), "acct-1");
    await userEvent.type(within(dialog).getByLabelText("Cloudflare Gateway ID"), "cf-gw");
    await userEvent.type(within(dialog).getByLabelText("Gateway token"), "cf-aig-unproven");
    await userEvent.click(within(dialog).getByRole("button", { name: /^add gateway$/i }));

    // The gateway is stored either way; the operator is told what the probe found.
    await waitFor(() => {
      expect(calls.some((entry) => entry.method === "POST" && entry.url.endsWith("/provider-gateways")))
        .toBe(true);
    });
    await waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/refused the token/i));
    });
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
    const dialog = await openAddProvider();
    await userEvent.type(within(dialog).getByLabelText("Name"), "OpenAI via CF");
    await choose(within(dialog).getByLabelText("Authentication"), /use gateway/i);
    await choose(within(dialog).getByLabelText("Gateway"), /prod cf gateway/i);
    await userEvent.click(within(dialog).getByRole("button", { name: /add provider/i }));

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
    await runRowAction("Prod OpenAI", /delete provider/i);
    await userEvent.click(screen.getByRole("button", { name: /^delete provider$/i }));

    await waitFor(() => expect(gatewayReads()).toBe(2));
  });

  it("leaves the default slug free when the only instance chose a custom one", async () => {
    // The type is configured, but nothing holds `openai`, so the next instance
    // may still take the default and needs no manual slug.
    stubProviders({ providers: [{ ...DIRECT, slug: "openai-legacy" }], gateways: [] });
    renderAuthenticated(<ProvidersPage />);

    await screen.findByText("openai-legacy");
    const dialog = await openAddProvider();
    expect(within(dialog).queryByLabelText("Slug")).toBeNull();
  });

  it("asks for a slug only once the default one is taken", async () => {
    const calls = stubProviders({ providers: [DIRECT], gateways: [] });
    renderAuthenticated(<ProvidersPage />);

    // OpenAI is taken, so the default slug is unavailable and must be replaced.
    const dialog = await openAddProvider();
    const slugField = within(dialog).getByLabelText("Slug");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Dev OpenAI");
    await userEvent.type(within(dialog).getByLabelText("API key"), SECRET);
    expect(within(dialog).getByRole("button", { name: /add provider/i }))
      .toHaveProperty("disabled", true);

    await userEvent.type(slugField, "openai-dev");
    await userEvent.click(within(dialog).getByRole("button", { name: /add provider/i }));
    await waitFor(() => {
      const call = calls.find((entry) => entry.method === "POST");
      expect(call?.body).toMatchObject({ slug: "openai-dev", type: "openai" });
    });

    // A type with no instance keeps today's URLs, so the field disappears.
    const reopened = await openAddProvider();
    await choose(within(reopened).getByLabelText("Provider"), /gemini/i);
    expect(within(reopened).queryByLabelText("Slug")).toBeNull();
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
    const dialog = await openAddProvider();
    await userEvent.type(within(dialog).getByLabelText("Name"), "Prod OpenAI");
    expect(within(dialog).queryByLabelText("Slug")).toBeNull();
    await userEvent.type(within(dialog).getByLabelText("API key"), SECRET);
    await userEvent.click(within(dialog).getByRole("button", { name: /add provider/i }));

    // A rejected credential keeps the modal open on the field that fixes it.
    const slugField = await within(dialog).findByLabelText("Slug");
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
    const inUse = await openRowActions("Prod CF gateway");
    expect(within(inUse).getByRole("menuitem", { name: /delete gateway/i }))
      .toHaveProperty("ariaDisabled", "true");
    await userEvent.keyboard("{Escape}");
    const unused = await openRowActions("Spare gateway");
    expect(within(unused).getByRole("menuitem", { name: /delete gateway/i }))
      .toHaveProperty("ariaDisabled", null);
  });

  it("blocks deleting a gateway only revoked rows still reference", async () => {
    stubProviders({ gateways: [RETIRED_GATEWAY] });
    renderAuthenticated(<ProvidersPage />);

    // Nothing routes through it, but the foreign key counts revoked rows too,
    // so "delete the active instances first" would be unactionable advice.
    const menu = await openRowActions("Retired gateway");
    const blocked = within(menu).getByRole("menuitem", { name: /delete gateway/i });
    expect(blocked).toHaveProperty("ariaDisabled", "true");
    expect(screen.getByText(/revoked provider instances still reference this gateway/i))
      .toBeTruthy();
  });

  it("rotates the gateway token once for every provider behind it", async () => {
    const calls = stubProviders();
    renderAuthenticated(<ProvidersPage />);

    await screen.findByText("acct-1 · cf-gw");
    await runRowAction("Prod CF gateway", /update token/i);
    await userEvent.type(await screen.findByLabelText("New gateway token"), "cf-aig-new-token");
    await userEvent.click(screen.getByRole("button", { name: /update token/i }));

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

    await screen.findByText("acct-1 · cf-gw");
    await runRowAction("Prod CF gateway", /rename/i);
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

    await runRowAction("Spare gateway", /delete gateway/i);
    await userEvent.click(await screen.findByRole("button", { name: /^delete gateway$/i }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.method === "DELETE");
      expect(call?.url).toContain("/v1/admin/provider-gateways/gw-2");
    });
  });

  it("rotates a credential in place", async () => {
    const calls = stubProviders();
    renderAuthenticated(<ProvidersPage />);

    await screen.findByText("Prod OpenAI");
    await runRowAction("Prod OpenAI", /update key/i);
    await userEvent.type(await screen.findByLabelText("New API key"), "sk-rotated");
    await userEvent.click(screen.getByRole("button", { name: /update key/i }));

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

    const menu = await openRowActions("Anthropic via CF");
    const rotate = within(menu).getByRole("menuitem", { name: /update key/i });
    expect(rotate).toHaveProperty("ariaDisabled", "true");
    expect(rotate.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("edits custom model pricing without touching the credential", async () => {
    const calls = stubProviders();
    renderAuthenticated(<ProvidersPage />);

    await runRowAction("Prod OpenAI", /pricing/i);
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

    await runRowAction("Prod OpenAI", /pricing/i);
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

    await runRowAction("Prod OpenAI", /delete provider/i);
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
    // The creation flows live behind these two buttons, so a read-only member
    // never reaches a field at all.
    expect(screen.getByRole("button", { name: /new provider/i })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /add gateway/i })).toHaveProperty("disabled", true);
    // The row menus still open, and each action says why it is unavailable.
    const menu = await openRowActions("Prod OpenAI");
    expect(within(menu).getByRole("menuitem", { name: /update key/i }))
      .toHaveProperty("ariaDisabled", "true");
    expect(within(menu).getByRole("menuitem", { name: /delete provider/i }))
      .toHaveProperty("ariaDisabled", "true");
    // Pricing is only a view until its own save button, which is guarded.
    expect(within(menu).getByRole("menuitem", { name: /pricing/i }))
      .toHaveProperty("ariaDisabled", null);
  });
});

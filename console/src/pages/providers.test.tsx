import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProvidersPage, draftsToPricing } from "./providers";
import { renderAuthenticated } from "@/test/render";
import type { ProviderCredential } from "@/lib/types";

const SECRET = "sk-live-never-shown-again";

const DIRECT: ProviderCredential = {
  id: "provider-1",
  type: "openai",
  name: "Prod OpenAI",
  secretHint: "gain",
  gateway: null,
  gatewayConfig: null,
  pricing: { "gpt-brand-new": { input: 1.25, output: 10 } },
  status: "active",
  createdAt: "2026-02-01T00:00:00.000Z",
  createdBy: "user-1",
};

const VIA_GATEWAY: ProviderCredential = {
  ...DIRECT,
  id: "provider-2",
  type: "anthropic",
  name: "Via our CF gateway",
  gateway: "cf_aig",
  gatewayConfig: { accountId: "acct-1", gatewayId: "gw-1" },
  pricing: null,
};

interface Call {
  url: string;
  method: string;
  body: any;
}

function stubProviders(rows: ProviderCredential[] = [DIRECT, VIA_GATEWAY]) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    if (method === "POST" && url.includes("cf-aig-preset")) {
      return new Response(
        JSON.stringify({ providers: [VIA_GATEWAY], conflicts: [], validated: true }),
        { status: 201 },
      );
    }
    if (method === "POST") {
      return new Response(JSON.stringify({ provider: DIRECT, validated: true }), { status: 201 });
    }
    if (method === "PUT") {
      return new Response(JSON.stringify({ provider: DIRECT, validated: true }), { status: 200 });
    }
    if (method === "DELETE") {
      return new Response(JSON.stringify({ deleted: true, provider_id: DIRECT.id }), { status: 200 });
    }
    return new Response(JSON.stringify({ providers: rows }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
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
  it("lists credentials by hint and how their traffic is routed", async () => {
    stubProviders();
    renderAuthenticated(<ProvidersPage />);

    expect(await screen.findByText("Prod OpenAI")).toBeTruthy();
    expect(screen.getAllByText("…gain")).toHaveLength(2);
    expect(screen.getByText("Direct")).toBeTruthy();
    expect(screen.getByText(/Cloudflare AI Gateway · gw-1/)).toBeTruthy();
  });

  it("offers onboarding copy when nothing is configured", async () => {
    stubProviders([]);
    renderAuthenticated(<ProvidersPage />);

    expect(await screen.findByText(/add a key per provider/i)).toBeTruthy();
  });

  it("submits a new key and clears it from the form afterwards", async () => {
    const calls = stubProviders();
    renderAuthenticated(<ProvidersPage />);

    await userEvent.type(await screen.findByLabelText("Name"), "Prod OpenAI");
    const secretField = screen.getByLabelText("API key");
    await userEvent.type(secretField, SECRET);
    await userEvent.click(screen.getByRole("button", { name: /add provider/i }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST" && call.body?.secret === SECRET)).toBe(true);
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
    stubProviders();
    renderAuthenticated(<ProvidersPage />);

    const secretFields = [await screen.findByLabelText("API key")];
    const plainFields = [screen.getByLabelText("Name")];
    await userEvent.click(screen.getByRole("tab", { name: /connect cloudflare/i }));
    secretFields.push(screen.getByLabelText("Gateway token"));
    plainFields.push(
      screen.getByLabelText("Account ID"),
      screen.getByLabelText("Gateway ID"),
      screen.getByLabelText("Name"),
    );
    await userEvent.click(screen.getByRole("tab", { name: /add a provider key/i }));
    await userEvent.click((await screen.findAllByRole("button", { name: "Rotate" }))[0]!);
    secretFields.push(await screen.findByLabelText("New API key"));

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

  it("connects a Cloudflare AI Gateway for the checked providers", async () => {
    const calls = stubProviders();
    renderAuthenticated(<ProvidersPage />);

    await userEvent.click(await screen.findByRole("tab", { name: /connect cloudflare/i }));
    await userEvent.type(screen.getByLabelText("Account ID"), "acct-1");
    await userEvent.type(screen.getByLabelText("Gateway ID"), "gw-1");
    const tokenField = screen.getByLabelText("Gateway token");
    await userEvent.type(tokenField, "cf-aig-run-token");
    await userEvent.click(screen.getByRole("checkbox", { name: "Anthropic" }));
    await userEvent.click(screen.getByRole("button", { name: /connect gateway/i }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.url.includes("cf-aig-preset"));
      expect(call?.body).toMatchObject({
        accountId: "acct-1",
        gatewayId: "gw-1",
        token: "cf-aig-run-token",
        types: ["anthropic"],
      });
    });
    await waitFor(() => expect((tokenField as HTMLInputElement).value).toBe(""));
  });

  it("rotates a credential in place", async () => {
    const calls = stubProviders();
    renderAuthenticated(<ProvidersPage />);

    await userEvent.click((await screen.findAllByRole("button", { name: "Rotate" }))[0]!);
    await userEvent.type(await screen.findByLabelText("New API key"), "sk-rotated");
    await userEvent.click(screen.getByRole("button", { name: /rotate key/i }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.method === "PUT");
      expect(call?.url).toContain("/v1/admin/providers/provider-1");
      expect(call?.body).toEqual({ secret: "sk-rotated" });
    });
    expect(document.body.textContent).not.toContain("sk-rotated");
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
      expect(calls.some((call) => call.method === "DELETE")).toBe(true);
    });
  });

  it("stops a read-only member changing anything", async () => {
    stubProviders();
    renderAuthenticated(<ProvidersPage />, { session: { role: "member" } });

    await screen.findByText("Prod OpenAI");
    expect(screen.getByRole("button", { name: /add provider/i })).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("API key")).toHaveProperty("disabled", true);
    for (const button of screen.getAllByRole("button", { name: "Rotate" })) {
      expect(button).toHaveProperty("disabled", true);
    }
  });
});

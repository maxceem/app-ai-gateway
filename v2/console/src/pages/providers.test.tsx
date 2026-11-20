import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProvidersPage, testResultText } from "./providers";
import { renderAuthenticated, settled } from "@/test/render";
import { cloudflareCapable, PROVIDER_TYPES } from "@/lib/providers";

const PROVIDER = {
  id: "prov-1",
  type: "openai",
  slug: "openai",
  name: "OpenAI main",
  status: "active",
  secretHint: "abcd",
  baseUrl: null,
  pricing: null,
  revision: 3,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
};

const SECRET = "sk-test-0123456789";

function stub(providers: unknown[] = [PROVIDER], test: unknown = { validated: true }, testStatus = 200) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/v2/admin/providers/test") return new Response(JSON.stringify(test), { status: testStatus });
    if (url === "/v2/admin/providers" && init?.method === "POST") return new Response(JSON.stringify({ provider: PROVIDER }), { status: 201 });
    if (url.startsWith("/v2/admin/providers/") && init?.method === "PUT") return new Response(JSON.stringify({ provider: PROVIDER }));
    return new Response(JSON.stringify({ providers }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const bodyOf = (fetchMock: ReturnType<typeof stub>, url: string, method: string) => {
  const found = fetchMock.mock.calls.find(([input, init]) => String(input) === url && init?.method === method);
  return found ? JSON.parse(String(found[1]!.body)) : undefined;
};

afterEach(() => vi.unstubAllGlobals());

describe("ProvidersPage", () => {
  it("lists connections with the key's last characters, never the key", async () => {
    stub();
    renderAuthenticated(<ProvidersPage />);
    const row = (await screen.findByText("OpenAI main")).closest("tr")!;
    expect(within(row).getByText("…abcd")).toBeTruthy();
    expect(within(row).getByText("OpenAI")).toBeTruthy();
  });

  it("tests a key, then adds the connection with it", async () => {
    const fetchMock = stub([]);
    renderAuthenticated(<ProvidersPage />);

    await userEvent.click(await screen.findByRole("button", { name: /add provider/i }));
    // Pasting, not typing key by key, keeps this test quick.
    await userEvent.click(screen.getByLabelText(/^name$/i));
    await userEvent.paste("Main");
    await userEvent.click(screen.getByLabelText(/api key/i));
    await userEvent.paste(SECRET);
    await userEvent.click(screen.getByRole("button", { name: /test key/i }));
    expect((await screen.findByRole("status")).textContent).toMatch(/accepted this key/i);
    // The dialog starts on the first provider in label order.
    expect(bodyOf(fetchMock, "/v2/admin/providers/test", "POST")).toEqual({ type: PROVIDER_TYPES[0]!.type, secret: SECRET });

    await userEvent.click(screen.getByRole("button", { name: /^add provider$/i, hidden: false }));
    await waitFor(() =>
      expect(bodyOf(fetchMock, "/v2/admin/providers", "POST")).toEqual({ type: PROVIDER_TYPES[0]!.type, name: "Main", secret: SECRET }),
    );
  });

  it("says so when a key test could not run", async () => {
    stub([], { error: { code: "internal_error", message: "boom" } }, 500);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: /add provider/i }));
    await userEvent.type(screen.getByLabelText(/api key/i), SECRET);
    await userEvent.click(screen.getByRole("button", { name: /test key/i }));
    expect((await screen.findByRole("status")).textContent).toMatch(/could not be tested just now/i);
  });

  it("tests a replacement key against the connection's own host", async () => {
    const fetchMock = stub([{ ...PROVIDER, baseUrl: "https://proxy.example.com/v1" }]);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /replace key/i }));
    await userEvent.type(await screen.findByLabelText(/api key/i), SECRET);
    await userEvent.click(screen.getByRole("button", { name: /test key/i }));
    await waitFor(() =>
      expect(bodyOf(fetchMock, "/v2/admin/providers/test", "POST")).toEqual({ type: "openai", secret: SECRET, baseUrl: "https://proxy.example.com/v1" }),
    );
  });

  it("turns a connection off at the revision it was read at", async () => {
    const fetchMock = stub();
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /turn off/i }));
    await waitFor(() => expect(bodyOf(fetchMock, "/v2/admin/providers/prov-1", "PUT")).toEqual({ revision: 3, status: "disabled" }));
  });

  it("reloads the list when a remove is refused, as the connection may already be gone", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return new Response(JSON.stringify({ error: { code: "provider_not_found", message: "gone" } }), { status: 404 });
      }
      return new Response(JSON.stringify({ providers: [PROVIDER] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const lists = () => fetchMock.mock.calls.filter(([input, init]) => String(input) === "/v2/admin/providers" && (init?.method ?? "GET") === "GET").length;
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /remove/i }));
    const before = lists();
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /^remove$/i }));
    await waitFor(() => expect(lists()).toBeGreaterThan(before));
  });

  it("drops a key test's answer once the key was edited", async () => {
    let answer: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/v2/admin/providers/test") return new Promise<Response>((resolve) => (answer = resolve));
        return new Response(JSON.stringify({ providers: [] }));
      }),
    );
    const { client } = renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: /add provider/i }));
    const key = screen.getByLabelText(/api key/i);
    await userEvent.type(key, SECRET);
    await userEvent.click(screen.getByRole("button", { name: /test key/i }));
    await userEvent.type(key, "-other");
    answer(new Response(JSON.stringify({ validated: true })));
    await settled(client);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("locks the replace-key form while its save runs, so the key shown is the key sent", async () => {
    let answer: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/v2/admin/providers/") && init?.method === "PUT") return new Promise<Response>((resolve) => (answer = resolve));
        return new Response(JSON.stringify({ providers: [PROVIDER] }));
      }),
    );
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /replace key/i }));
    await userEvent.type(await screen.findByLabelText(/new api key/i), SECRET);
    await userEvent.click(screen.getByRole("button", { name: /^replace key$/i }));
    // A disabled fieldset locks every control inside it in a browser; jsdom
    // does not compute that, so the test checks the fieldset itself.
    const locked = (element: HTMLElement) => element.closest("fieldset")?.disabled === true;
    await waitFor(() => expect(locked(screen.getByLabelText(/new api key/i))).toBe(true));
    expect(locked(screen.getByRole("button", { name: /test key/i }))).toBe(true);
    answer(new Response(JSON.stringify({ provider: PROVIDER })));
  });

  it("adds a connection through Cloudflare AI Gateway with no provider key", async () => {
    const fetchMock = stub([]);
    const type = PROVIDER_TYPES[0]!.type;
    expect(cloudflareCapable(type)).toBe(true);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: /add provider/i }));
    await userEvent.click(screen.getByLabelText(/^name$/i));
    await userEvent.paste("Via Cloudflare");
    await userEvent.click(screen.getByRole("checkbox", { name: /send through cloudflare ai gateway/i }));
    await userEvent.click(screen.getByLabelText(/cloudflare account id/i));
    await userEvent.paste("acct");
    await userEvent.click(screen.getByLabelText(/cloudflare gateway id/i));
    await userEvent.paste("gw");
    await userEvent.click(screen.getByLabelText(/cloudflare token/i));
    await userEvent.paste("cf-token-1234");
    await userEvent.click(screen.getByRole("button", { name: /^add provider$/i }));
    await waitFor(() =>
      expect(bodyOf(fetchMock, "/v2/admin/providers", "POST")).toEqual({
        type,
        name: "Via Cloudflare",
        cloudflareGateway: { accountId: "acct", gatewayId: "gw", token: "cf-token-1234" },
      }),
    );
  });

  it("shows a connection that goes through Cloudflare, and offers no key test it could not run", async () => {
    stub([{ ...PROVIDER, cloudflareGateway: { accountId: "acct", gatewayId: "gw", tokenHint: "1234" } }]);
    renderAuthenticated(<ProvidersPage />);
    const row = (await screen.findByText("OpenAI main")).closest("tr")!;
    expect(within(row).getByText(/via cloudflare ai gateway/i)).toBeTruthy();
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /replace key/i }));
    await screen.findByLabelText(/new api key/i);
    expect(screen.queryByRole("button", { name: /test key/i })).toBeNull();
  });

  it("sends no key when Cloudflare's stored keys are chosen, whatever was typed (S8)", async () => {
    const fetchMock = stub();
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /cloudflare ai gateway/i }));
    await userEvent.click(await screen.findByLabelText(/cloudflare account id/i));
    await userEvent.paste("acct");
    await userEvent.click(screen.getByLabelText(/cloudflare gateway id/i));
    await userEvent.paste("gw");
    await userEvent.click(screen.getByLabelText(/cloudflare token/i));
    await userEvent.paste("cf-token-1234");
    // Moving to a gateway says what key goes with it: Save waits for one.
    expect(screen.getByRole("button", { name: /^save$/i }).hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByLabelText(/^api key$/i));
    await userEvent.paste(SECRET);
    await userEvent.click(screen.getByRole("checkbox", { name: /use the keys stored in cloudflare/i }));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(bodyOf(fetchMock, "/v2/admin/providers/prov-1", "PUT")).toEqual({
        revision: 3,
        cloudflareGateway: { accountId: "acct", gatewayId: "gw", token: "cf-token-1234" },
        secret: null,
      }),
    );
  });

  it("stops a read-only member adding a provider", async () => {
    stub();
    renderAuthenticated(<ProvidersPage />, { session: { role: "member" } });
    expect((await screen.findByRole("button", { name: /add provider/i })).hasAttribute("disabled")).toBe(true);
  });
});

describe("testResultText", () => {
  it("blames the key only when the provider refused it", () => {
    expect(testResultText({ validated: false, reason: "rejected", status: 401 }).ok).toBe(false);
    expect(testResultText({ validated: false, reason: "no_probe" }).ok).toBe(true);
    expect(testResultText({ validated: false, reason: "unexpected_status", status: 403 }).text).toMatch(/403/);
  });
});

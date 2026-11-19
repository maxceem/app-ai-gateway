import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProvidersPage, testResultText } from "./providers";
import { renderAuthenticated } from "@/test/render";

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

function stub(providers: unknown[] = [PROVIDER], test: unknown = { validated: true }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/v2/admin/providers/test") return new Response(JSON.stringify(test));
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
    await userEvent.type(screen.getByLabelText(/^name$/i), "Main");
    await userEvent.type(screen.getByLabelText(/api key/i), SECRET);
    await userEvent.click(screen.getByRole("button", { name: /test key/i }));
    expect((await screen.findByRole("status")).textContent).toMatch(/accepted this key/i);
    expect(bodyOf(fetchMock, "/v2/admin/providers/test", "POST")).toEqual({ type: "elevenlabs", secret: SECRET });

    await userEvent.click(screen.getByRole("button", { name: /^add provider$/i, hidden: false }));
    await waitFor(() =>
      expect(bodyOf(fetchMock, "/v2/admin/providers", "POST")).toEqual({ type: "elevenlabs", name: "Main", secret: SECRET }),
    );
  });

  it("turns a connection off at the revision it was read at", async () => {
    const fetchMock = stub();
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /turn off/i }));
    await waitFor(() => expect(bodyOf(fetchMock, "/v2/admin/providers/prov-1", "PUT")).toEqual({ revision: 3, status: "disabled" }));
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

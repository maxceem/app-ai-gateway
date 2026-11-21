import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { parsePathLines, pathLine, ProvidersPage, testResultText } from "./providers";
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

  it("adds a custom provider only once the trust choice is made, with its base URL and key header", async () => {
    const fetchMock = stub([]);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: /add provider/i }));
    await userEvent.click(screen.getByRole("combobox", { name: /provider/i }));
    await userEvent.click(await screen.findByRole("option", { name: "Custom provider" }));
    await userEvent.click(screen.getByLabelText(/^name$/i));
    await userEvent.paste("My LLM");
    await userEvent.click(screen.getByLabelText(/base url/i));
    await userEvent.paste("https://llm.example.com/v1/");
    await userEvent.clear(screen.getByLabelText(/key header/i));
    await userEvent.click(screen.getByLabelText(/key header/i));
    await userEvent.paste("X-Api-Key");
    await userEvent.click(screen.getByLabelText(/api key/i));
    await userEvent.paste(SECRET);
    // What passing paths through gives up is in view, and the choice is needed.
    expect(screen.getByText(/budgets do not limit it/i)).toBeTruthy();
    const add = screen.getByRole("button", { name: /^add provider$/i, hidden: false }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    await userEvent.click(screen.getByRole("checkbox", { name: /i understand, and want to add this provider/i }));
    expect(add.disabled).toBe(false);
    await userEvent.click(add);
    await waitFor(() =>
      expect(bodyOf(fetchMock, "/v2/admin/providers", "POST")).toEqual({
        type: "custom",
        name: "My LLM",
        secret: SECRET,
        baseUrl: "https://llm.example.com/v1/",
        auth: { header: "x-api-key", format: "Bearer {key}" },
      }),
    );
  });

  it("lists a built-in provider's first passthrough paths only once the trust choice is made", async () => {
    const fetchMock = stub();
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /passthrough paths/i }));
    await userEvent.click(await screen.findByLabelText(/one path per line/i));
    await userEvent.paste("get v1/files/{file_id} $0.001\nPOST v1/moderations");
    const save = screen.getByRole("button", { name: /save paths/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await userEvent.click(screen.getByRole("checkbox", { name: /i understand/i }));
    await userEvent.click(save);
    await waitFor(() =>
      expect(bodyOf(fetchMock, "/v2/admin/providers/prov-1", "PUT")).toEqual({
        revision: 3,
        passthrough: [
          { method: "GET", path: "v1/files/{file_id}", per_request: 0.001 },
          { method: "POST", path: "v1/moderations" },
        ],
      }),
    );
  });

  it("edits a custom provider's paths with their API styles, the choice made when it was added", async () => {
    const custom = {
      ...PROVIDER,
      type: "custom",
      name: "My LLM",
      baseUrl: "https://llm.example.com/v1/",
      auth: { header: "x-api-key", format: "{key}" },
      passthrough: [{ method: "POST", path: "chat/completions", style: "openai-chat" }],
    };
    const fetchMock = stub([custom]);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for My LLM" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /^paths$/i }));
    const box = (await screen.findByLabelText(/one path per line/i)) as HTMLTextAreaElement;
    expect(box.value).toBe("POST chat/completions openai-chat");
    expect(screen.queryByRole("checkbox", { name: /i understand/i })).toBeNull();
    await userEvent.click(box);
    await userEvent.paste("\nGET models");
    await userEvent.click(screen.getByRole("button", { name: /save paths/i }));
    await waitFor(() =>
      expect(bodyOf(fetchMock, "/v2/admin/providers/prov-1", "PUT")).toEqual({
        revision: 3,
        passthrough: [{ method: "POST", path: "chat/completions", style: "openai-chat" }, { method: "GET", path: "models" }],
      }),
    );
  });
});

describe("PathsDialog after a conflict", () => {
  it("keeps the revision it was opened at, shows the conflict, and saves only after a reload", async () => {
    const opened = { ...PROVIDER, passthrough: [{ method: "GET", path: "v1/files" }] };
    const changed = { ...PROVIDER, revision: 4, passthrough: [{ method: "GET", path: "v1/files" }, { method: "GET", path: "v1/batches" }] };
    let puts = 0;
    let lists = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        puts += 1;
        if (puts === 1) return new Response(JSON.stringify({ error: { code: "conflict", message: "changed" } }), { status: 409 });
        return new Response(JSON.stringify({ provider: changed }));
      }
      lists += 1;
      return new Response(JSON.stringify({ providers: [lists === 1 ? opened : changed] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const puts_ = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT").map(([, init]) => JSON.parse(String(init!.body)));
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /passthrough paths/i }));
    const box = (await screen.findByLabelText(/one path per line/i)) as HTMLTextAreaElement;
    await userEvent.click(box);
    await userEvent.paste("\nPOST v1/moderations");
    await userEvent.click(screen.getByRole("button", { name: /save paths/i }));
    expect(await screen.findByText(/these paths changed since you opened them/i)).toBeTruthy();
    expect(puts_()[0]).toMatchObject({ revision: 3 });
    // The list has reloaded at revision 4 by now; the draft is still from 3, so saving it is held back.
    await waitFor(() => expect(lists).toBeGreaterThan(1));
    expect((screen.getByRole("button", { name: /save paths/i }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: /reload paths/i }));
    expect(((await screen.findByLabelText(/one path per line/i)) as HTMLTextAreaElement).value).toBe("GET v1/files\nGET v1/batches");
    await userEvent.click(screen.getByRole("button", { name: /save paths/i }));
    await waitFor(() => expect(puts_()[1]).toMatchObject({ revision: 4, passthrough: [{ method: "GET", path: "v1/files" }, { method: "GET", path: "v1/batches" }] }));
  });
});

describe("safe defaults on listed paths", () => {
  const EXPIRY = { in: "body", name: "expires_after", value: { anchor: "created_at", seconds: 60 } };

  it("shows a new token path's safe defaults and the warning, and lets the server write them in", async () => {
    const listed = { ...PROVIDER, passthrough: [{ method: "GET", path: "v1/files" }] };
    const fetchMock = stub([listed]);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /passthrough paths/i }));
    const box = (await screen.findByLabelText(/one path per line/i)) as HTMLTextAreaElement;
    expect(screen.queryByText(/not metered, not capped/i)).toBeNull();
    await userEvent.click(box);
    await userEvent.paste("\nPOST v1/realtime/client_secrets");
    expect(await screen.findByText(/^live-session tokens are not metered, not capped$/i)).toBeTruthy();
    expect(screen.getByText(/elevenlabs' token carries a link that can start more calls within about 15 minutes/i)).toBeTruthy();
    expect(screen.getByText(/one openai client secret can start several calls before it expires/i)).toBeTruthy();
    expect(screen.getByText("Token expiry")).toBeTruthy();
    expect(screen.getByText(/set when you save/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /save paths/i }));
    await waitFor(() =>
      expect(bodyOf(fetchMock, "/v2/admin/providers/prov-1", "PUT")).toEqual({
        revision: 3,
        passthrough: [
          { method: "GET", path: "v1/files" },
          { method: "POST", path: "v1/realtime/client_secrets" },
        ],
      }),
    );
  });

  it("removes a suggested default before it is ever set: the path is sent with none", async () => {
    const fetchMock = stub([{ ...PROVIDER, passthrough: [{ method: "GET", path: "v1/files" }] }]);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /passthrough paths/i }));
    const box = (await screen.findByLabelText(/one path per line/i)) as HTMLTextAreaElement;
    await userEvent.click(box);
    await userEvent.paste("\nPOST v1/realtime/client_secrets");
    await userEvent.click(await screen.findByRole("button", { name: /^remove$/i }));
    await userEvent.click(screen.getByRole("button", { name: /save paths/i }));
    await waitFor(() =>
      expect(bodyOf(fetchMock, "/v2/admin/providers/prov-1", "PUT")).toMatchObject({
        passthrough: [{ method: "GET", path: "v1/files" }, { method: "POST", path: "v1/realtime/client_secrets", set_fields: [] }],
      }),
    );
  });

  it("shows a saved path's settings with their reason, keeps them when other lines change, and changes a value", async () => {
    const saved = { ...EXPIRY, value: { anchor: "created_at", seconds: 120 }, label: "Token expiry", reason: "A short expiry limits new calls.", suggested_value: EXPIRY.value };
    const fetchMock = stub([{ ...PROVIDER, passthrough: [{ method: "POST", path: "v1/realtime/client_secrets", set_fields: [saved] }] }]);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /passthrough paths/i }));
    const box = (await screen.findByLabelText(/one path per line/i)) as HTMLTextAreaElement;
    expect(box.value).toBe("POST v1/realtime/client_secrets");
    expect(screen.getByText("A short expiry limits new calls.")).toBeTruthy();
    expect(screen.getByText(/suggested:/i)).toBeTruthy();
    const value = screen.getByRole("textbox", { name: /value of token expiry/i }) as HTMLInputElement;
    await userEvent.clear(value);
    await userEvent.click(value);
    await userEvent.paste('{"anchor":"created_at","seconds":30}');
    await userEvent.click(box);
    await userEvent.paste("\nGET v1/files");
    await userEvent.click(screen.getByRole("button", { name: /save paths/i }));
    await waitFor(() =>
      expect(bodyOf(fetchMock, "/v2/admin/providers/prov-1", "PUT")).toEqual({
        revision: 3,
        passthrough: [
          { method: "POST", path: "v1/realtime/client_secrets", set_fields: [{ ...EXPIRY, value: { anchor: "created_at", seconds: 30 } }] },
          { method: "GET", path: "v1/files" },
        ],
      }),
    );
  });

  it("saves the value shown when Enter is pressed while the value is still focused", async () => {
    const saved = { ...EXPIRY, value: { anchor: "created_at", seconds: 120 }, label: "Token expiry", reason: "A short expiry limits new calls.", suggested_value: EXPIRY.value };
    const fetchMock = stub([{ ...PROVIDER, passthrough: [{ method: "POST", path: "v1/realtime/client_secrets", set_fields: [saved] }] }]);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /passthrough paths/i }));
    const value = (await screen.findByRole("textbox", { name: /value of token expiry/i })) as HTMLInputElement;
    await userEvent.clear(value);
    await userEvent.click(value);
    await userEvent.paste('{"anchor":"created_at","seconds":30}');
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(bodyOf(fetchMock, "/v2/admin/providers/prov-1", "PUT")).toEqual({
        revision: 3,
        passthrough: [{ method: "POST", path: "v1/realtime/client_secrets", set_fields: [{ ...EXPIRY, value: { anchor: "created_at", seconds: 30 } }] }],
      }),
    );
  });

  it("does not save while a value shown is not JSON", async () => {
    const saved = { ...EXPIRY, value: { anchor: "created_at", seconds: 120 }, label: "Token expiry", reason: "A short expiry limits new calls.", suggested_value: EXPIRY.value };
    const fetchMock = stub([{ ...PROVIDER, passthrough: [{ method: "POST", path: "v1/realtime/client_secrets", set_fields: [saved] }] }]);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /passthrough paths/i }));
    const value = (await screen.findByRole("textbox", { name: /value of token expiry/i })) as HTMLInputElement;
    await userEvent.clear(value);
    await userEvent.click(value);
    const error = vi.spyOn(toast, "error");
    await userEvent.paste("{seconds: 30");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringMatching(/write each value as json/i)));
    expect(bodyOf(fetchMock, "/v2/admin/providers/prov-1", "PUT")).toBeUndefined();
    error.mockRestore();
  });
});

describe("listed path lines", () => {
  it("read a method, a path, a price and, on a custom provider, an API style", () => {
    expect(parsePathLines("get v1/files/{id} $0.5\n\n  POST  chat/completions  openai-chat ", true)).toEqual({
      paths: [
        { method: "GET", path: "v1/files/{id}", per_request: 0.5 },
        { method: "POST", path: "chat/completions", style: "openai-chat" },
      ],
    });
    expect(parsePathLines("", false)).toEqual({ paths: [] });
  });

  it.each([
    ["HEAD v1/files", false, "Line 1: start with GET"],
    ["GET", false, "add the path"],
    ["GET v1/files $", false, "a price is $"],
    ["GET v1/files $-1", false, "a price is $"],
    ["POST chat openai-chat", false, "is not a price"],
    ["POST chat speakers", true, "not a price or an API style"],
    ["POST v1/realtime/client_secrets live-token", false, "is not a price"],
  ])("say what is wrong with %j", (text, custom, problem) => {
    const parsed = parsePathLines(text, custom);
    expect("problem" in parsed && parsed.problem).toContain(problem);
  });

  it("write a listed path back as the line it reads from", () => {
    for (const path of [
      { method: "GET" as const, path: "v1/files/{id}", per_request: 0.001 },
      { method: "POST" as const, path: "chat/completions", style: "openai-chat" as const },
    ]) {
      expect(parsePathLines(pathLine(path), true)).toEqual({ paths: [path] });
    }
  });
});

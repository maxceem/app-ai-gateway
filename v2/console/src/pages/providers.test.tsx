import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { parsePathLines, parsePricesText, pathLine, pricesText, ProvidersPage, testResultText } from "./providers";
import { renderAuthenticated, settled } from "@/test/render";
import { chooseOption } from "@/test/select";
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

  it("saves the connection's own prices, such as a flat price per job for a model off our list", async () => {
    const fal = { ...PROVIDER, id: "prov-fal", type: "fal", slug: "fal", name: "fal", pricing: { "fal-ai/old": { per_unit: 0.01 } } };
    const fetchMock = stub([fal]);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for fal" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /your prices/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit as JSON" }));
    const box = await screen.findByLabelText(/prices by model/i);
    expect((box as HTMLTextAreaElement).value).toContain("fal-ai/old");
    await userEvent.clear(box);
    await userEvent.click(box);
    await userEvent.paste('{"fal-ai/some-model": {"per_request": 0.02}}');
    await userEvent.click(screen.getByRole("button", { name: /save prices/i }));
    await waitFor(() =>
      expect(bodyOf(fetchMock, "/v2/admin/providers/prov-fal", "PUT")).toEqual({ revision: 3, pricing: { "fal-ai/some-model": { per_request: 0.02 } } }),
    );
  });

  it("reads the prices text as JSON, and empty as no prices of your own", () => {
    expect(pricesText(null)).toBe("");
    expect(parsePricesText("")).toEqual({ pricing: null });
    expect(parsePricesText("{}")).toEqual({ pricing: null });
    expect(parsePricesText('{"m": {"per_video": 0.02}}')).toEqual({ pricing: { m: { per_video: 0.02 } } });
    expect(parsePricesText("[1]")).toHaveProperty("problem");
    expect(parsePricesText("{not json")).toHaveProperty("problem");
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

describe("PricesDialog after a conflict", () => {
  it("keeps the revision it was opened at, shows the conflict, and saves only after a reload", async () => {
    const opened = { ...PROVIDER, id: "prov-fal", type: "fal", slug: "fal", name: "fal", pricing: { "fal-ai/old": { per_unit: 0.01 } } };
    const changed = { ...opened, revision: 4, pricing: { "fal-ai/old": { per_unit: 0.01 }, "fal-ai/theirs": { per_request: 0.05 } } };
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
    await userEvent.click(await screen.findByRole("button", { name: "Actions for fal" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /your prices/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit as JSON" }));
    const box = await screen.findByLabelText(/prices by model/i);
    await userEvent.clear(box);
    await userEvent.click(box);
    await userEvent.paste('{"fal-ai/mine": {"per_request": 0.02}}');
    await userEvent.click(screen.getByRole("button", { name: /save prices/i }));
    expect(await screen.findByText(/these prices changed since you opened them/i)).toBeTruthy();
    expect(puts_()[0]).toMatchObject({ revision: 3 });
    // The list has reloaded at revision 4 by now; the draft is still from 3, so saving it is held back.
    await waitFor(() => expect(lists).toBeGreaterThan(1));
    expect((screen.getByRole("button", { name: /save prices/i }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: /reload prices/i }));
    expect(((await screen.findByLabelText(/prices by model/i)) as HTMLTextAreaElement).value).toContain("fal-ai/theirs");
    await userEvent.click(screen.getByRole("button", { name: /save prices/i }));
    await waitFor(() => expect(puts_()[1]).toMatchObject({ revision: 4, pricing: changed.pricing }));
  });
});

describe("PricesDialog reload after a conflict", () => {
  const opened = { ...PROVIDER, id: "prov-fal", type: "fal", slug: "fal", name: "fal", pricing: { "fal-ai/old": { per_unit: 0.01 } } };
  const changed = { ...opened, revision: 4, pricing: { "fal-ai/old": { per_unit: 0.01 }, "fal-ai/theirs": { per_request: 0.05 } } };

  /** Opens the dialog, types a draft and saves it into a 409. */
  async function intoConflict() {
    await userEvent.click(await screen.findByRole("button", { name: "Actions for fal" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /your prices/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit as JSON" }));
    const box = await screen.findByLabelText(/prices by model/i);
    await userEvent.clear(box);
    await userEvent.click(box);
    await userEvent.paste('{"fal-ai/mine": {"per_request": 0.02}}');
    await userEvent.click(screen.getByRole("button", { name: /save prices/i }));
    expect(await screen.findByText(/these prices changed since you opened them/i)).toBeTruthy();
  }

  it("waits for the fresh list before it drops the draft, even when clicked while the list still loads", async () => {
    let lists = 0;
    let release: (() => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT") return new Response(JSON.stringify({ error: { code: "conflict", message: "changed" } }), { status: 409 });
        lists += 1;
        if (lists === 1) return new Response(JSON.stringify({ providers: [opened] }));
        // The refresh after the conflict is held until the test lets it go.
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return new Response(JSON.stringify({ providers: [changed] }));
      }),
    );
    renderAuthenticated(<ProvidersPage />);
    await intoConflict();
    await waitFor(() => expect(release).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: /reload prices/i }));
    // Still loading: the draft stays and saving stays held back.
    const box = (await screen.findByLabelText(/prices by model/i)) as HTMLTextAreaElement;
    expect(box.value).toContain("fal-ai/mine");
    expect((screen.getByRole("button", { name: /save prices/i }) as HTMLButtonElement).disabled).toBe(true);
    release!();
    await waitFor(() => expect(((screen.getByLabelText(/prices by model/i)) as HTMLTextAreaElement).value).toContain("fal-ai/theirs"));
    expect(screen.queryByText(/these prices changed since you opened them/i)).toBeNull();
  });

  it("makes the editor read-only while a reload is pending, so nothing typed is lost to its answer", async () => {
    let lists = 0;
    let release: (() => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT") return new Response(JSON.stringify({ error: { code: "conflict", message: "changed" } }), { status: 409 });
        lists += 1;
        if (lists === 1) return new Response(JSON.stringify({ providers: [opened] }));
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return new Response(JSON.stringify({ providers: [changed] }));
      }),
    );
    renderAuthenticated(<ProvidersPage />);
    await intoConflict();
    await waitFor(() => expect(release).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: /reload prices/i }));
    const box = (await screen.findByLabelText(/prices by model/i)) as HTMLTextAreaElement;
    await waitFor(() => expect(box.readOnly).toBe(true));
    await userEvent.click(box);
    await userEvent.paste("typed while loading");
    expect(box.value).not.toContain("typed while loading");
    release!();
    await waitFor(() => expect(((screen.getByLabelText(/prices by model/i)) as HTMLTextAreaElement).value).toContain("fal-ai/theirs"));
    expect(((screen.getByLabelText(/prices by model/i)) as HTMLTextAreaElement).readOnly).toBe(false);
  });

  it("keeps the draft and the notice when the fresh read fails", async () => {
    let lists = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT") return new Response(JSON.stringify({ error: { code: "conflict", message: "changed" } }), { status: 409 });
        lists += 1;
        if (lists === 1) return new Response(JSON.stringify({ providers: [opened] }));
        return new Response(JSON.stringify({ error: { code: "unavailable", message: "down" } }), { status: 503 });
      }),
    );
    renderAuthenticated(<ProvidersPage />);
    await intoConflict();
    await userEvent.click(screen.getByRole("button", { name: /reload prices/i }));
    await waitFor(() => expect(lists).toBeGreaterThan(2));
    expect(((screen.getByLabelText(/prices by model/i)) as HTMLTextAreaElement).value).toContain("fal-ai/mine");
    expect(screen.getByText(/these prices changed since you opened them/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /save prices/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("PricesDialog closed while its save is pending", () => {
  it("lets a late save close nothing, so another provider's open dialog keeps its draft", async () => {
    const fal = { ...PROVIDER, id: "prov-fal", type: "fal", slug: "fal", name: "fal", pricing: null };
    const other = { ...PROVIDER, id: "prov-other", type: "fal", slug: "fal-two", name: "fal-two", pricing: null };
    let release: (() => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT") {
          // The first provider's save is held until the test lets it go.
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return new Response(JSON.stringify({ provider: fal }));
        }
        return new Response(JSON.stringify({ providers: [fal, other] }));
      }),
    );
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for fal" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /your prices/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit as JSON" }));
    const first = await screen.findByLabelText(/prices by model/i);
    await userEvent.click(first);
    await userEvent.paste('{"fal-ai/a": {"per_request": 0.01}}');
    await userEvent.click(screen.getByRole("button", { name: /save prices/i }));
    await waitFor(() => expect(release).not.toBeNull());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByLabelText(/prices by model/i)).toBeNull());

    await userEvent.click(await screen.findByRole("button", { name: "Actions for fal-two" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /your prices/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit as JSON" }));
    const second = (await screen.findByLabelText(/prices by model/i)) as HTMLTextAreaElement;
    await userEvent.click(second);
    await userEvent.paste('{"fal-ai/b": {"per_request": 0.02}}');
    release!();
    // The first provider's save has finished; the second dialog is still open with its draft.
    await waitFor(() => expect(((screen.getByLabelText(/prices by model/i)) as HTMLTextAreaElement).value).toContain("fal-ai/b"));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(((screen.getByLabelText(/prices by model/i)) as HTMLTextAreaElement).value).toContain("fal-ai/b");
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

describe("field settings while paths are edited", () => {
  const LIMIT = { in: "query", name: "limit", value: 10 };
  const open = async () => {
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /passthrough paths/i }));
  };

  it("keeps a path's settings when one of its named parts is renamed", async () => {
    const fetchMock = stub([{ ...PROVIDER, passthrough: [{ method: "GET", path: "v1/files/{file_id}", set_fields: [LIMIT] }] }]);
    renderAuthenticated(<ProvidersPage />);
    await open();
    const lines = await screen.findByRole("textbox", { name: /one path per line/i });
    await userEvent.clear(lines);
    await userEvent.type(lines, "GET v1/files/{{id}");
    await userEvent.click(screen.getByRole("button", { name: "Save paths" }));
    await waitFor(() =>
      expect(bodyOf(fetchMock, "/v2/admin/providers/prov-1", "PUT")).toEqual({
        revision: 3,
        passthrough: [{ method: "GET", path: "v1/files/{id}", set_fields: [LIMIT] }],
      }),
    );
  });

  it("keeps a value's unfinished text while a path line is briefly wrong, and still will not save it", async () => {
    const fetchMock = stub([{ ...PROVIDER, passthrough: [{ method: "GET", path: "v1/files/{file_id}", set_fields: [LIMIT] }] }]);
    renderAuthenticated(<ProvidersPage />);
    await open();
    const value = await screen.findByRole("textbox", { name: /value of limit/i });
    await userEvent.clear(value);
    await userEvent.type(value, "[[1,");
    const lines = screen.getByRole("textbox", { name: /one path per line/i });
    await userEvent.type(lines, "\nXX");
    expect(screen.queryByRole("textbox", { name: /value of limit/i })).toBeNull();
    await userEvent.type(lines, "{Backspace}{Backspace}{Backspace}");
    expect(((await screen.findByRole("textbox", { name: /value of limit/i })) as HTMLInputElement).value).toBe("[1,");
    const error = vi.spyOn(toast, "error");
    await userEvent.click(screen.getByRole("button", { name: "Save paths" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringMatching(/write each value as json/i)));
    expect(bodyOf(fetchMock, "/v2/admin/providers/prov-1", "PUT")).toBeUndefined();
    error.mockRestore();
  });

  it("saves once a value that does not read as JSON is removed", async () => {
    const fetchMock = stub([{ ...PROVIDER, passthrough: [{ method: "GET", path: "v1/files/{file_id}", set_fields: [LIMIT] }] }]);
    renderAuthenticated(<ProvidersPage />);
    await open();
    await userEvent.clear(await screen.findByRole("textbox", { name: /value of limit/i }));
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await userEvent.click(screen.getByRole("button", { name: "Save paths" }));
    await waitFor(() =>
      expect(bodyOf(fetchMock, "/v2/admin/providers/prov-1", "PUT")).toEqual({
        revision: 3,
        passthrough: [{ method: "GET", path: "v1/files/{file_id}", set_fields: [] }],
      }),
    );
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

describe("provider gaps from v1", () => {
  it("renames a connection without touching its slug", async () => {
    const fetchMock = stub();
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /rename/i }));
    const box = await screen.findByLabelText(/^name$/i);
    await userEvent.clear(box);
    await userEvent.click(box);
    await userEvent.paste("OpenAI EU");
    await userEvent.click(screen.getByRole("button", { name: /^rename$/i }));
    await waitFor(() => expect(bodyOf(fetchMock, "/v2/admin/providers/prov-1", "PUT")).toEqual({ revision: 3, name: "OpenAI EU" }));
  });

  it("adds a built-in provider at another host, priced from our list", async () => {
    const fetchMock = stub([]);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: /add provider/i }));
    await chooseOption(screen.getByRole("combobox", { name: /provider/i }), "OpenAI");
    await userEvent.click(screen.getByLabelText(/^name$/i));
    await userEvent.paste("Azure");
    await userEvent.click(screen.getByLabelText(/base url/i));
    await userEvent.paste("http://insecure.example.com");
    expect(screen.getByText(/base url must use https/i)).toBeTruthy();
    await userEvent.clear(screen.getByLabelText(/base url/i));
    await userEvent.click(screen.getByLabelText(/base url/i));
    await userEvent.paste("https://my-azure.example.com/openai/v1");
    await userEvent.click(screen.getByLabelText(/api key/i));
    await userEvent.paste(SECRET);
    await userEvent.click(screen.getByRole("button", { name: /^add provider$/i }));
    await waitFor(() =>
      expect(bodyOf(fetchMock, "/v2/admin/providers", "POST")).toEqual({
        type: "openai",
        name: "Azure",
        secret: SECRET,
        baseUrl: "https://my-azure.example.com/openai/v1",
      }),
    );
  });

  it("moves a connection to another host only with a key typed for it, and back to the provider's own only when told to", async () => {
    const hosted = { ...PROVIDER, baseUrl: "https://my-azure.example.com/openai/v1" };
    const fetchMock = stub([hosted]);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /^host$/i }));
    const box = await screen.findByLabelText(/base url/i);
    await userEvent.clear(box);
    await userEvent.click(box);
    await userEvent.paste("https://other.example.com/v1");
    const save = screen.getByRole("button", { name: /^save$/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await userEvent.click(screen.getByLabelText(/api key/i));
    await userEvent.paste(SECRET);
    expect(save.disabled).toBe(false);
    // Another address: the key typed for the first one is gone.
    await userEvent.type(box, "2");
    expect((screen.getByLabelText(/api key/i) as HTMLInputElement).value).toBe("");
    expect(save.disabled).toBe(true);
    // Back to the provider's own host: nothing moves until the person says so.
    await userEvent.clear(box);
    expect(save.disabled).toBe(true);
    await userEvent.click(screen.getByRole("checkbox", { name: /send the current key to api\.openai\.com/i }));
    await userEvent.click(save);
    await waitFor(() => expect(bodyOf(fetchMock, "/v2/admin/providers/prov-1", "PUT")).toEqual({ revision: 3, baseUrl: null }));
  });

  it("goes back to the provider's own host with a replacement key instead", async () => {
    const hosted = { ...PROVIDER, baseUrl: "https://my-azure.example.com/openai/v1" };
    const fetchMock = stub([hosted]);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /^host$/i }));
    await userEvent.clear(await screen.findByLabelText(/base url/i));
    await userEvent.click(screen.getByLabelText(/replacement key/i));
    await userEvent.paste(SECRET);
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(bodyOf(fetchMock, "/v2/admin/providers/prov-1", "PUT")).toEqual({ revision: 3, baseUrl: null, secret: SECRET }));
  });

  it("clears a typed key in the add form when where it goes changes", async () => {
    stub([]);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: /add provider/i }));
    await chooseOption(screen.getByRole("combobox", { name: /provider/i }), "OpenAI");
    const key = () => screen.getByLabelText(/api key/i) as HTMLInputElement;
    await userEvent.click(screen.getByLabelText(/base url/i));
    await userEvent.paste("https://one.example.com");
    await userEvent.click(key());
    await userEvent.paste(SECRET);
    await userEvent.type(screen.getByLabelText(/base url/i), "x");
    expect(key().value).toBe("");
    await userEvent.click(key());
    await userEvent.paste(SECRET);
    await userEvent.click(screen.getByRole("checkbox", { name: /cloudflare/i }));
    expect(key().value).toBe("");
    await userEvent.click(screen.getByRole("checkbox", { name: /cloudflare/i }));
    await userEvent.click(key());
    await userEvent.paste(SECRET);
    await chooseOption(screen.getByRole("combobox", { name: /provider/i }), "Anthropic");
    expect(key().value).toBe("");
  });

  it("renames at the revision it opened at: a conflict asks for a reload, and only then saves", async () => {
    const changed = { ...PROVIDER, revision: 4, name: "Renamed elsewhere" };
    let puts = 0;
    let lists = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        puts += 1;
        if (puts === 1) return new Response(JSON.stringify({ error: { code: "conflict", message: "changed" } }), { status: 409 });
        return new Response(JSON.stringify({ provider: changed }));
      }
      lists += 1;
      return new Response(JSON.stringify({ providers: [lists === 1 ? PROVIDER : changed] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const putBodies = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT").map(([, init]) => JSON.parse(String(init!.body)));
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /rename/i }));
    const box = await screen.findByLabelText(/^name$/i);
    await userEvent.clear(box);
    await userEvent.click(box);
    await userEvent.paste("Mine");
    await userEvent.click(screen.getByRole("button", { name: /^rename$/i }));
    expect(await screen.findByText(/this connection changed since you opened it/i)).toBeTruthy();
    await waitFor(() => expect(lists).toBeGreaterThan(1));
    // The list is at revision 4 now; the dialog still holds 3, so it will not save.
    expect((screen.getByRole("button", { name: /^rename$/i }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: /^reload$/i }));
    await waitFor(() => expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe("Renamed elsewhere"));
    await userEvent.clear(screen.getByLabelText(/^name$/i));
    await userEvent.click(screen.getByLabelText(/^name$/i));
    await userEvent.paste("Mine");
    await userEvent.click(screen.getByRole("button", { name: /^rename$/i }));
    await waitFor(() => expect(putBodies()).toEqual([{ revision: 3, name: "Mine" }, { revision: 4, name: "Mine" }]));
  });

  it("lets a late rename close nothing once its dialog is gone", async () => {
    const other = { ...PROVIDER, id: "prov-2", slug: "openai-2", name: "OpenAI two" };
    let release: (() => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT") {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return new Response(JSON.stringify({ provider: PROVIDER }));
        }
        return new Response(JSON.stringify({ providers: [PROVIDER, other] }));
      }),
    );
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /rename/i }));
    await userEvent.type(await screen.findByLabelText(/^name$/i), " x");
    await userEvent.click(screen.getByRole("button", { name: /^rename$/i }));
    await waitFor(() => expect(release).not.toBeNull());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByLabelText(/^name$/i)).toBeNull());
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI two" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /^host$/i }));
    const box = await screen.findByLabelText(/base url/i);
    await userEvent.click(box);
    await userEvent.paste("https://draft.example.com");
    release!();
    await waitFor(() => expect(screen.getByRole("dialog", { name: /^host$/i })).toBeTruthy());
    expect((screen.getByLabelText(/base url/i) as HTMLInputElement).value).toBe("https://draft.example.com");
  });

  it("keeps several unit rates as stored: their controls are locked, and a token edit leaves them", async () => {
    const stored = { "m": { input: 1, output: 2, per_image: 0.04, per_megapixel: 0.01 } };
    const fetchMock = stub([{ ...PROVIDER, pricing: stored }]);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /your prices/i }));
    const row = await screen.findByRole("group", { name: "m" });
    expect(within(row).getByText(/several unit rates/i)).toBeTruthy();
    expect((within(row).getByRole("combobox", { name: /^unit$/i }) as HTMLButtonElement).disabled).toBe(true);
    const output = within(row).getByLabelText(/^output/i);
    await userEvent.clear(output);
    await userEvent.click(output);
    await userEvent.paste("3");
    await userEvent.click(screen.getByRole("button", { name: /save prices/i }));
    await waitFor(() =>
      expect(bodyOf(fetchMock, "/v2/admin/providers/prov-1", "PUT")).toEqual({ revision: 3, pricing: { m: { input: 1, output: 3, per_image: 0.04, per_megapixel: 0.01 } } }),
    );
  });

  it("opens prices the form cannot show as JSON, and says so rather than switching a JSON it cannot show", async () => {
    stub([{ ...PROVIDER, pricing: { tiny: { per_request: 1e-9 } } }]);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /your prices/i }));
    // A rate written with an exponent reads back as itself.
    const row = await screen.findByRole("group", { name: "tiny" });
    expect((within(row).getByLabelText(/unit rate/i) as HTMLInputElement).value).toBe("1e-9");
    expect((screen.getByRole("button", { name: /save prices/i }) as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Edit as JSON" }));
    const box = screen.getByLabelText(/prices by model/i);
    await userEvent.clear(box);
    await userEvent.click(box);
    await userEvent.paste('{"m": null}');
    await userEvent.click(screen.getByRole("button", { name: "Edit as a form" }));
    expect(screen.getByText(/not prices the form can show/i)).toBeTruthy();
    expect(screen.getByLabelText(/prices by model/i)).toBeTruthy();
  });

  it("opens stored prices the form cannot represent straight as JSON", async () => {
    stub([{ ...PROVIDER, pricing: { odd: { input: "1", output: 2 } } as never }]);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /your prices/i }));
    expect(((await screen.findByLabelText(/prices by model/i)) as HTMLTextAreaElement).value).toContain('"input": "1"');
  });

  it("edits a model's rates in the prices form and keeps what the form does not show", async () => {
    const stored = { "gpt-x": { input: 1, output: 4, modes: { flex: { factor: 0.5 } } } };
    const fetchMock = stub([{ ...PROVIDER, pricing: stored }]);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /your prices/i }));
    const row = await screen.findByRole("group", { name: "gpt-x" });
    expect(within(row).getByText(/also kept as saved: modes/i)).toBeTruthy();
    const output = within(row).getByLabelText(/^output/i);
    await userEvent.clear(output);
    await userEvent.click(output);
    await userEvent.paste("5");
    await userEvent.click(screen.getByRole("button", { name: /add a model/i }));
    const added = screen.getByRole("group", { name: "New model" });
    await userEvent.click(within(added).getByLabelText(/^model$/i));
    await userEvent.paste("fal-ai/new");
    expect((screen.getByRole("button", { name: /save prices/i }) as HTMLButtonElement).disabled).toBe(true);
    await chooseOption(within(screen.getByRole("group", { name: "fal-ai/new" })).getByRole("combobox", { name: /^unit$/i }), "per request or job");
    await userEvent.click(within(screen.getByRole("group", { name: "fal-ai/new" })).getByLabelText(/unit rate/i));
    await userEvent.paste("0.02");
    await userEvent.click(screen.getByRole("button", { name: /save prices/i }));
    await waitFor(() =>
      expect(bodyOf(fetchMock, "/v2/admin/providers/prov-1", "PUT")).toEqual({
        revision: 3,
        pricing: { "gpt-x": { input: 1, output: 5, modes: { flex: { factor: 0.5 } } }, "fal-ai/new": { per_request: 0.02 } },
      }),
    );
  });
});

describe("a typed key stays with where it was typed for", () => {
  /** A list that answers `before` first and `after` from then on, and a PUT that answers 409 once, then saves. */
  function moving(before: unknown, after: unknown) {
    let lists = 0;
    let puts = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        puts += 1;
        if (puts === 1) return new Response(JSON.stringify({ error: { code: "conflict", message: "changed" } }), { status: 409 });
        return new Response(JSON.stringify({ provider: after }));
      }
      lists += 1;
      return new Response(JSON.stringify({ providers: [lists === 1 ? before : after] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const putBodies = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT").map(([, init]) => JSON.parse(String(init!.body)));
    return { putBodies, lists: () => lists };
  }

  it("clears a replacement key once another admin moved the host, and saves nothing until a reload", async () => {
    const moved = { ...PROVIDER, revision: 4, baseUrl: "https://elsewhere.example.com/v1/" };
    const { putBodies, lists } = moving(PROVIDER, moved);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /replace key/i }));
    expect(await screen.findByText(/sent only to api\.openai\.com/i)).toBeTruthy();
    await userEvent.click(screen.getByLabelText(/new api key/i));
    await userEvent.paste(SECRET);
    await userEvent.click(screen.getByRole("button", { name: /^replace key$/i }));
    expect(await screen.findByText(/this connection changed since you opened it/i)).toBeTruthy();
    await waitFor(() => expect(lists()).toBeGreaterThan(1));
    // The key typed for api.openai.com is gone; nothing can be tested or saved until a reload.
    expect((screen.getByLabelText(/new api key/i) as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("button", { name: /^replace key$/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /test key/i }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: /^reload$/i }));
    await waitFor(() => expect(screen.getByText(/sent only to elsewhere\.example\.com\/v1/i)).toBeTruthy());
    expect((screen.getByLabelText(/new api key/i) as HTMLInputElement).value).toBe("");
    await userEvent.click(screen.getByLabelText(/new api key/i));
    await userEvent.paste(SECRET);
    await userEvent.click(screen.getByRole("button", { name: /^replace key$/i }));
    await waitFor(() => expect(putBodies()).toEqual([{ revision: 3, secret: SECRET }, { revision: 4, secret: SECRET }]));
  });

  it("does not bring a key back when the address returns to where it was typed", async () => {
    stub([]);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: /add provider/i }));
    await chooseOption(screen.getByRole("combobox", { name: /provider/i }), "OpenAI");
    const url = () => screen.getByLabelText(/base url/i) as HTMLInputElement;
    const key = () => screen.getByLabelText(/api key/i) as HTMLInputElement;
    await userEvent.click(url());
    await userEvent.paste("https://a.example.com");
    await userEvent.click(key());
    await userEvent.paste(SECRET);
    await userEvent.type(url(), "x");
    expect(key().value).toBe("");
    await userEvent.type(url(), "{Backspace}");
    expect(url().value).toBe("https://a.example.com");
    expect(key().value).toBe("");
  });

  it("names both of fal's hosts before the stored key goes back to them", async () => {
    const fal = { ...PROVIDER, id: "prov-fal", type: "fal", slug: "fal", name: "fal", baseUrl: "https://fal-proxy.example.com/" };
    const fetchMock = stub([fal]);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for fal" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /^host$/i }));
    await userEvent.clear(await screen.findByLabelText(/base url/i));
    await userEvent.click(screen.getByRole("checkbox", { name: "Send the current key to fal.run, queue.fal.run" }));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(bodyOf(fetchMock, "/v2/admin/providers/prov-fal", "PUT")).toEqual({ revision: 3, baseUrl: null }));
  });

  it("closes Host after a conflict when the connection now goes through Cloudflare", async () => {
    const hosted = { ...PROVIDER, baseUrl: "https://my-azure.example.com/openai/v1" };
    const viaCloudflare = { ...PROVIDER, revision: 4, cloudflareGateway: { accountId: "acct", gatewayId: "gw", tokenHint: "abcd" } };
    moving(hosted, viaCloudflare);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /^host$/i }));
    await userEvent.clear(await screen.findByLabelText(/base url/i));
    await userEvent.click(screen.getByRole("checkbox", { name: /send the current key to api\.openai\.com/i }));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByText(/this connection changed since you opened it/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^reload$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /^host$/i })).toBeNull());
  });

  it("clears the provider key and the token when the Cloudflare account or gateway changes", async () => {
    stub([{ ...PROVIDER, cloudflareGateway: { accountId: "acct", gatewayId: "gw", tokenHint: "abcd" } }]);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /cloudflare ai gateway/i }));
    const key = () => screen.getByLabelText(/^api key$/i) as HTMLInputElement;
    const token = () => screen.getByLabelText(/cloudflare token/i) as HTMLInputElement;
    await userEvent.click(token());
    await userEvent.paste("cf-token-0123456789");
    await userEvent.click(key());
    await userEvent.paste(SECRET);
    await userEvent.type(screen.getByLabelText(/cloudflare gateway id/i), "2");
    expect(key().value).toBe("");
    expect(token().value).toBe("");
  });

  it("asks for the provider's key, naming where it goes, before going direct again", async () => {
    const fetchMock = stub([{ ...PROVIDER, secretHint: null, cloudflareGateway: { accountId: "acct", gatewayId: "gw", tokenHint: "abcd" } }]);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /cloudflare ai gateway/i }));
    await userEvent.click(await screen.findByRole("button", { name: /stop using cloudflare ai gateway/i }));
    expect(screen.getByText(/sent only to api\.openai\.com/i)).toBeTruthy();
    const go = screen.getByRole("button", { name: /go direct/i }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await userEvent.click(screen.getByLabelText(/the provider's api key/i));
    await userEvent.paste(SECRET);
    await userEvent.click(go);
    await waitFor(() => expect(bodyOf(fetchMock, "/v2/admin/providers/prov-1", "PUT")).toEqual({ revision: 3, cloudflareGateway: null, secret: SECRET }));
  });

  it("names the hosts a base URL routes to as the gateway saves it: fal's queue under the regional host", async () => {
    stub([]);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: /add provider/i }));
    await chooseOption(screen.getByRole("combobox", { name: /provider/i }), "fal");
    await userEvent.click(screen.getByLabelText(/base url/i));
    await userEvent.paste("https://regional.example.com");
    expect(screen.getByText(/sent only to regional\.example\.com, regional\.example\.com\/queue\./i)).toBeTruthy();
  });

  it("judges the base URL only on the route that uses it: through Cloudflare it does not block adding", async () => {
    const fetchMock = stub([]);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: /add provider/i }));
    await chooseOption(screen.getByRole("combobox", { name: /provider/i }), "OpenAI");
    await userEvent.click(screen.getByLabelText(/^name$/i));
    await userEvent.paste("Via Cloudflare");
    await userEvent.click(screen.getByLabelText(/base url/i));
    await userEvent.paste("http://not-https.example.com");
    await userEvent.click(screen.getByRole("checkbox", { name: /send through cloudflare ai gateway/i }));
    await userEvent.click(screen.getByLabelText(/cloudflare account id/i));
    await userEvent.paste("acct");
    await userEvent.click(screen.getByLabelText(/cloudflare gateway id/i));
    await userEvent.paste("gw");
    await userEvent.click(screen.getByLabelText(/cloudflare token/i));
    await userEvent.paste("cf-token-0123456789");
    const add = screen.getByRole("button", { name: /^add provider$/i }) as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    await userEvent.click(add);
    await waitFor(() =>
      expect(bodyOf(fetchMock, "/v2/admin/providers", "POST")).toEqual({
        type: "openai",
        name: "Via Cloudflare",
        cloudflareGateway: { accountId: "acct", gatewayId: "gw", token: "cf-token-0123456789" },
      }),
    );
  });

  it("refuses a JSON price a float would read as another figure, before switching to the form or saving", async () => {
    stub();
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /your prices/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit as JSON" }));
    const box = screen.getByLabelText(/prices by model/i);
    await userEvent.click(box);
    await userEvent.paste('{"m": {"per_request": 1e-400}}');
    expect(screen.getByText(/per_request 1e-400: .*stored as 0/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /save prices/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Edit as a form" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("turns Cloudflare on for a connection with a base URL only once removing it is confirmed, in the same save", async () => {
    const hosted = { ...PROVIDER, baseUrl: "https://my-azure.example.com/openai/v1/" };
    const fetchMock = stub([hosted]);
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /cloudflare ai gateway/i }));
    await userEvent.click(await screen.findByLabelText(/cloudflare account id/i));
    await userEvent.paste("acct");
    await userEvent.click(screen.getByLabelText(/cloudflare gateway id/i));
    await userEvent.paste("gw");
    await userEvent.click(screen.getByLabelText(/cloudflare token/i));
    await userEvent.paste("cf-token-0123456789");
    await userEvent.click(screen.getByLabelText(/^api key$/i));
    await userEvent.paste(SECRET);
    const save = screen.getByRole("button", { name: /^save$/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await userEvent.click(screen.getByRole("checkbox", { name: /remove the base url https:\/\/my-azure\.example\.com\/openai\/v1\//i }));
    await userEvent.click(save);
    await waitFor(() =>
      expect(bodyOf(fetchMock, "/v2/admin/providers/prov-1", "PUT")).toEqual({
        revision: 3,
        cloudflareGateway: { accountId: "acct", gatewayId: "gw", token: "cf-token-0123456789" },
        baseUrl: null,
        secret: SECRET,
      }),
    );
  });

  it("refuses a model written twice in the JSON prices before parsing drops one", async () => {
    stub();
    renderAuthenticated(<ProvidersPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for OpenAI main" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /your prices/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Edit as JSON" }));
    await userEvent.click(screen.getByLabelText(/prices by model/i));
    await userEvent.paste('{"m": {"per_request": 1}, "m": {"per_request": 2}}');
    expect(screen.getByText(/"m" is written twice in one object/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /save prices/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});

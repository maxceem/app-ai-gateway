import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { toast } from "sonner";
import { AppDetailPage, routingOf, scopeOf } from "./app-detail";
import { testApp } from "@/test/fixtures";
import { renderAuthenticated } from "@/test/render";

const APP_URL = "/v2/admin/apps/my-app";

const PROVIDERS = {
  providers: [
    { id: "p1", type: "openai", slug: "openai", name: "OpenAI main", status: "active", secretHint: "abcd", baseUrl: null, pricing: null, revision: 1, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" },
    { id: "p2", type: "openai", slug: "openai-eu", name: "OpenAI EU", status: "active", secretHint: "efgh", baseUrl: null, pricing: null, revision: 1, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" },
  ],
};

const USERS = {
  app_id: "my-app",
  month: "2026-11",
  total: 2,
  limit: 50,
  offset: 0,
  users: [
    { id: "user-a", status: "active", installs: 0, is_install: false, created_at: "2026-11-01T00:00:00.000Z", last_seen_at: null, is_virtual: false, usage: { charges: 3, failed: 0, cost_nano: 1_500_000_000, input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    { id: "header-only", status: "active", installs: 0, is_install: false, created_at: null, last_seen_at: null, is_virtual: true, usage: { charges: 1, failed: 0, cost_nano: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } },
  ],
};

type Answer = { status?: number; body: unknown };

/** Routes by method and path; anything else is the app itself. */
function stub(routes: Record<string, Answer> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const answer = routes[`${method} ${url}`] ?? (url === "/v2/admin/providers" ? { body: PROVIDERS } : { body: { app: testApp() } });
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const putBody = (fetchMock: ReturnType<typeof stub>) => {
  const found = fetchMock.mock.calls.find(([input, init]) => String(input) === APP_URL && init?.method === "PUT");
  return found ? JSON.parse(String(found[1]!.body)) : undefined;
};

function renderTab(tab: string) {
  return renderAuthenticated(
    <Routes>
      <Route path="/apps/:appId/:tab" element={<AppDetailPage />} />
    </Routes>,
    { route: `/apps/my-app/${tab}` },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("routingOf and scopeOf", () => {
  it("saves a connection's draft as its routing entry, or nothing when it is not allowed", () => {
    expect(routingOf({ allowed: false, operations: ["openai.chat"], models: "", maxOutputTokens: "" })).toBeNull();
    expect(routingOf({ allowed: true, operations: ["openai.chat"], models: " gpt-a, gpt-b, gpt-a ", maxOutputTokens: "500" })).toEqual({
      operations: ["openai.chat"],
      models: ["gpt-a", "gpt-b"],
      max_output_tokens: 500,
    });
  });

  it("turns typed limits into numbers and nano-dollars, refusing what is not a number", () => {
    expect(scopeOf({ perMinute: "10", perDay: "", monthlyDollars: "2.5" })).toEqual({
      requests: { per_minute: 10, per_day: null },
      monthly_nano: 2_500_000_000,
    });
    expect(scopeOf({ perMinute: "0", perDay: "", monthlyDollars: "" })).toBeNull();
    expect(scopeOf({ perMinute: "", perDay: "", monthlyDollars: "lots" })).toBeNull();
  });
});

describe("AppDetailPage", () => {
  it("allows another connection with its first operation, saving at the read revision", async () => {
    const fetchMock = stub({ [`PUT ${APP_URL}`]: { body: { app: testApp({ revision: 3 }) } } });
    renderTab("providers");

    await userEvent.click(await screen.findByRole("checkbox", { name: "Allow openai-eu" }));
    await userEvent.click(screen.getByRole("button", { name: /save providers/i }));

    await waitFor(() => expect(putBody(fetchMock)).toBeTruthy());
    const body = putBody(fetchMock);
    expect(body.revision).toBe(2);
    expect(body.config.routing.providers).toEqual({
      openai: { operations: ["openai.chat"] },
      "openai-eu": { operations: ["openai.chat"] },
    });
  });

  it("saves limits in nano-dollars", async () => {
    const fetchMock = stub({ [`PUT ${APP_URL}`]: { body: { app: testApp({ revision: 3 }) } } });
    renderTab("limits");

    const budgets = await screen.findAllByLabelText(/monthly budget/i);
    await userEvent.type(budgets[0]!, "1.25");
    await userEvent.type(screen.getAllByLabelText(/requests per minute/i)[1]!, "600");
    await userEvent.click(screen.getByRole("button", { name: /save limits/i }));

    await waitFor(() => expect(putBody(fetchMock)).toBeTruthy());
    const { limits } = putBody(fetchMock).config;
    expect(limits.per_user.spending.monthly_nano).toBe(1_250_000_000);
    expect(limits.per_app.requests.per_minute).toBe(600);
  });

  it("explains a save refused because the app changed meanwhile", async () => {
    stub({ [`PUT ${APP_URL}`]: { status: 409, body: { error: { code: "app_revision_conflict", message: "stale" } } } });
    const error = vi.spyOn(toast, "error");
    renderTab("limits");
    await userEvent.type((await screen.findAllByLabelText(/requests per day/i))[1]!, "5");
    await userEvent.click(screen.getByRole("button", { name: /save limits/i }));
    await waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringMatching(/changed since you opened it/i)));
  });

  it("lists users with their spend, and blocks only real ones", async () => {
    const fetchMock = stub({
      "GET /v2/admin/apps/my-app/users?limit=50&offset=0": { body: USERS },
      "POST /v2/admin/apps/my-app/users/user-a/block": { body: { app_id: "my-app", user_id: "user-a", blocked: true } },
    });
    renderTab("users");

    const row = (await screen.findByText("user-a")).closest("tr")!;
    expect(within(row).getByText("$1.50")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Actions for header-only" })).toBeNull();

    await userEvent.click(within(row).getByRole("button", { name: "Actions for user-a" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /block/i }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input, init]) => String(input) === "/v2/admin/apps/my-app/users/user-a/block" && init?.method === "POST")).toBe(true),
    );
  });

  it("creates an app key and shows it once", async () => {
    stub({
      "GET /v2/admin/apps/my-app/keys": { body: { app_id: "my-app", keys: [] } },
      "POST /v2/admin/apps/my-app/keys": { body: { id: "k2", name: "CI", key: "agw_app_new", key_prefix: "agw_app_", created_at: "2026-11-01T00:00:00.000Z" } },
    });
    renderTab("keys");
    await userEvent.click(await screen.findByRole("button", { name: /new key/i }));
    await userEvent.type(screen.getByLabelText(/key name/i), "CI");
    await userEvent.click(screen.getByRole("button", { name: /create key/i }));
    expect(await screen.findByDisplayValue("agw_app_new")).toBeTruthy();
  });

  it("has no keys tab for an App Attest app", async () => {
    stub({
      [`GET ${APP_URL}`]: {
        body: {
          app: testApp({
            config: {
              ...testApp().config,
              authentication: { type: "apple_app_attest", end_user: { source: "app_install" }, app_attest: { team_id: "ABCDE12345", bundle_id: "com.example.app", environments: ["production"], verify_on: "every_request" } },
            },
          }),
        },
      },
    });
    renderTab("overview");
    expect(await screen.findByRole("link", { name: "Providers" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Keys" })).toBeNull();
  });

  it("sends an explicit null configuration as typed, for the gateway to refuse", async () => {
    const fetchMock = stub({ [`PUT ${APP_URL}`]: { status: 400, body: { error: { code: "invalid_request", message: "config: required" } } } });
    renderTab("settings");
    const editor = await screen.findByLabelText("Configuration");
    await userEvent.clear(editor);
    await userEvent.type(editor, "null");
    await userEvent.click(screen.getByRole("button", { name: /save configuration/i }));
    await waitFor(() => expect(putBody(fetchMock)).toMatchObject({ config: null }));
  });

  it("deletes the app only with the typed id, which the request repeats", async () => {
    const fetchMock = stub({ [`DELETE ${APP_URL}?confirm=my-app`]: { body: { deleted: true } } });
    renderTab("settings");
    await userEvent.click(await screen.findByRole("button", { name: /^delete app$/i }));
    await userEvent.type(await screen.findByLabelText(/to continue/i), "my-app");
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /^delete app$/i }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input, init]) => String(input) === `${APP_URL}?confirm=my-app` && init?.method === "DELETE")).toBe(true),
    );
  });

  it("keeps an unsaved configuration when the app changed meanwhile, and says so", async () => {
    // Someone else changed the configuration; the rename's answer and every
    // later read carry that change.
    const changed = testApp({ name: "Renamed", revision: 3, config: { ...testApp().config, routing: { providers: {} } } });
    let renamed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === APP_URL && init?.method === "PUT") renamed = true;
        if (url === "/v2/admin/providers") return new Response(JSON.stringify(PROVIDERS));
        return new Response(JSON.stringify({ app: renamed ? changed : testApp() }));
      }),
    );
    renderTab("settings");
    const editor = await screen.findByLabelText("Configuration");
    await userEvent.clear(editor);
    await userEvent.type(editor, '{{"mine":true}');
    const rename = screen.getByLabelText("Name");
    await userEvent.clear(rename);
    await userEvent.type(rename, "Renamed");
    await userEvent.click(screen.getByRole("button", { name: /^rename$/i }));
    expect(await screen.findByText(/changed since you started editing/i)).toBeTruthy();
    expect((screen.getByLabelText("Configuration") as HTMLTextAreaElement).value).toBe('{"mine":true}');
    await userEvent.click(screen.getByRole("button", { name: /discard my edits/i }));
    expect((screen.getByLabelText("Configuration") as HTMLTextAreaElement).value).toBe(JSON.stringify(changed.config, null, 2));
  });

  it("ends the conflict notice once the kept draft is saved, so a fresh edit does not bring it back", async () => {
    const changed = testApp({ name: "Renamed", revision: 3, config: { ...testApp().config, routing: { providers: {} } } });
    let current = testApp();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/v2/admin/providers") return new Response(JSON.stringify(PROVIDERS));
        if (url === APP_URL && init?.method === "PUT") {
          const body = JSON.parse(String(init.body));
          // The rename lands on top of someone else's change; a later save
          // stores what it sent.
          // Like the gateway, the stored config gets its omitted defaults.
          const withDefaults = (config: Record<string, unknown>) => ({ ...config, limits: testApp().config.limits });
          current = current.revision === 2 ? changed : testApp({ ...body, config: withDefaults(body.config), revision: current.revision + 1 });
        }
        return new Response(JSON.stringify({ app: current }));
      }),
    );
    renderTab("settings");
    // The draft leaves out `limits`, which the gateway fills in on save.
    const { limits: _omitted, ...withoutLimits } = testApp().config;
    const mine = { ...withoutLimits, routing: { providers: { openai: { operations: ["openai.chat"], models: ["gpt-a"] } } } };
    fireEvent.change(await screen.findByLabelText("Configuration"), { target: { value: JSON.stringify(mine) } });
    const rename = screen.getByLabelText("Name");
    await userEvent.clear(rename);
    await userEvent.type(rename, "Renamed");
    await userEvent.click(screen.getByRole("button", { name: /^rename$/i }));
    expect(await screen.findByText(/changed since you started editing/i)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /save configuration/i }));
    await waitFor(() => expect(screen.queryByText(/changed since you started editing/i)).toBeNull());
    const next = { ...mine, routing: { providers: { openai: { operations: ["openai.chat"], models: ["gpt-b"] } } } };
    fireEvent.change(screen.getByLabelText("Configuration"), { target: { value: JSON.stringify(next) } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(/changed since you started editing/i)).toBeNull();
  });

  it("locks the name and configuration while a save runs", async () => {
    let answer: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/v2/admin/providers") return new Response(JSON.stringify(PROVIDERS));
        if (url === APP_URL && init?.method === "PUT") return new Promise<Response>((resolve) => (answer = resolve));
        return new Response(JSON.stringify({ app: testApp() }));
      }),
    );
    renderTab("settings");
    const rename = await screen.findByLabelText("Name");
    await userEvent.clear(rename);
    await userEvent.type(rename, "Renamed");
    await userEvent.click(screen.getByRole("button", { name: /^rename$/i }));
    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(true));
    expect((screen.getByLabelText("Configuration") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /^check$/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /save configuration/i }) as HTMLButtonElement).disabled).toBe(true);
    answer(new Response(JSON.stringify({ app: testApp({ name: "Renamed", revision: 3 }) })));
    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(false));
  });

  it("locks the limits and providers forms while their save runs", async () => {
    let answer: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/v2/admin/providers") return new Response(JSON.stringify(PROVIDERS));
        if (url === APP_URL && init?.method === "PUT") return new Promise<Response>((resolve) => (answer = resolve));
        return new Response(JSON.stringify({ app: testApp() }));
      }),
    );
    const view = renderTab("limits");
    await userEvent.type((await screen.findAllByLabelText(/requests per minute/i))[1]!, "600");
    await userEvent.click(screen.getByRole("button", { name: /save limits/i }));
    await waitFor(() => expect((screen.getAllByLabelText(/requests per minute/i)[1] as HTMLInputElement).disabled).toBe(true));
    answer(new Response(JSON.stringify({ app: testApp({ revision: 3 }) })));
    view.unmount();

    renderTab("providers");
    await userEvent.click(await screen.findByLabelText("Allow openai-eu"));
    await userEvent.click(screen.getByRole("button", { name: /save providers/i }));
    await waitFor(() => expect((screen.getByLabelText("Allow openai") as HTMLButtonElement).disabled).toBe(true));
    answer(new Response(JSON.stringify({ app: testApp({ revision: 3 }) })));
  });

  it("keeps the conflict notice after a rename while the configuration draft is still unsaved", async () => {
    const changed = testApp({ name: "Renamed", revision: 3, config: { ...testApp().config, routing: { providers: {} } } });
    let current = testApp();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/v2/admin/providers") return new Response(JSON.stringify(PROVIDERS));
        if (url === APP_URL && init?.method === "PUT") {
          const body = JSON.parse(String(init.body));
          current = current.revision === 2 ? changed : testApp({ ...current, name: body.name, revision: current.revision + 1 });
        }
        return new Response(JSON.stringify({ app: current }));
      }),
    );
    renderTab("settings");
    const editor = await screen.findByLabelText("Configuration");
    await userEvent.clear(editor);
    await userEvent.type(editor, '{{"mine":true}');
    const rename = screen.getByLabelText("Name");
    await userEvent.clear(rename);
    await userEvent.type(rename, "Renamed");
    await userEvent.click(screen.getByRole("button", { name: /^rename$/i }));
    expect(await screen.findByText(/changed since you started editing/i)).toBeTruthy();

    await userEvent.clear(screen.getByLabelText("Name"));
    await userEvent.type(screen.getByLabelText("Name"), "Renamed again");
    await userEvent.click(screen.getByRole("button", { name: /^rename$/i }));
    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText(/changed since you started editing/i)).toBeTruthy();
  });

  it("says the providers could not load, rather than that every connection was removed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input) === "/v2/admin/providers"
          ? new Response(JSON.stringify({ error: { code: "internal_error", message: "boom" } }), { status: 500 })
          : new Response(JSON.stringify({ app: testApp() })),
      ),
    );
    renderTab("providers");
    expect(await screen.findByText(/could not load your providers/i)).toBeTruthy();
    expect(screen.queryByText(/was removed/i)).toBeNull();
  });

  it("keeps the conflict notice after a configuration save while the name draft is still unresolved", async () => {
    let current = testApp();
    let puts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/v2/admin/providers") return new Response(JSON.stringify(PROVIDERS));
        if (url === APP_URL && init?.method === "PUT") {
          puts += 1;
          if (puts === 1) {
            current = testApp({ name: "Production", revision: 3 });
            return new Response(JSON.stringify({ error: { code: "app_revision_conflict", message: "stale" } }), { status: 409 });
          }
          const body = JSON.parse(String(init.body));
          current = testApp({ ...current, config: body.config, revision: current.revision + 1 });
        }
        return new Response(JSON.stringify({ app: current }));
      }),
    );
    renderTab("settings");
    const rename = await screen.findByLabelText("Name");
    await userEvent.clear(rename);
    await userEvent.type(rename, "Mobile");
    fireEvent.change(screen.getByLabelText("Configuration"), {
      target: { value: JSON.stringify({ ...testApp().config, routing: { providers: {} } }) },
    });
    await userEvent.click(screen.getByRole("button", { name: /save configuration/i }));
    expect(await screen.findByText(/changed since you started editing/i)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /save configuration/i }));
    await waitFor(() => expect(puts).toBe(2));
    await waitFor(() => expect((screen.getByLabelText("Configuration") as HTMLTextAreaElement).disabled).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Mobile");
    expect(screen.getByText(/changed since you started editing/i)).toBeTruthy();
  });

  it("says the keys or users could not load, rather than that there are none", async () => {
    stub({
      "GET /v2/admin/apps/my-app/keys": { status: 503, body: { error: { code: "internal_error", message: "boom" } } },
      "GET /v2/admin/apps/my-app/users?limit=50&offset=0": { status: 503, body: { error: { code: "internal_error", message: "boom" } } },
    });
    const view = renderTab("keys");
    expect(await screen.findByText(/could not load the keys/i)).toBeTruthy();
    expect(screen.queryByText("No keys.")).toBeNull();
    view.unmount();
    renderTab("users");
    expect(await screen.findByText(/could not load the users/i)).toBeTruthy();
    expect(screen.queryByText(/no users yet/i)).toBeNull();
  });

  it("saves the whole configuration as typed", async () => {
    const fetchMock = stub({ [`PUT ${APP_URL}`]: { body: { app: testApp({ revision: 3 }) } } });
    renderTab("settings");
    const editor = await screen.findByLabelText("Configuration");
    await userEvent.clear(editor);
    // The editor takes braces literally only when escaped for userEvent.
    await userEvent.type(editor, '{{"authentication":{{"type":"api_key","end_user":{{"source":"none"}}}');
    await userEvent.click(screen.getByRole("button", { name: /save configuration/i }));
    await waitFor(() => expect(putBody(fetchMock)?.config).toEqual({ authentication: { type: "api_key", end_user: { source: "none" } } }));
  });
});

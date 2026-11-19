import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
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

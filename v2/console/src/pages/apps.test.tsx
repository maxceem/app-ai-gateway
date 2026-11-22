import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppsPage, newAppConfig } from "./apps";
import { testApp } from "@/test/fixtures";
import { renderAuthenticated } from "@/test/render";

afterEach(() => vi.unstubAllGlobals());

describe("newAppConfig", () => {
  it("starts an iOS app on App Attest, counting each install", () => {
    expect(newAppConfig({ kind: "ios", teamId: " ABCDE12345 ", bundleId: "com.example.app", userHeader: "" })).toEqual({
      authentication: {
        type: "apple_app_attest",
        end_user: { source: "app_install" },
        app_attest: { team_id: "ABCDE12345", bundle_id: "com.example.app" },
      },
    });
  });

  it("starts a server app with or without an end user header", () => {
    expect(newAppConfig({ kind: "server", teamId: "", bundleId: "", userHeader: "" })).toEqual({
      authentication: { type: "api_key", end_user: { source: "none" } },
    });
    expect(newAppConfig({ kind: "server", teamId: "", bundleId: "", userHeader: "x-user" })).toEqual({
      authentication: { type: "api_key", end_user: { source: "header", header: "x-user" } },
    });
  });
});

describe("AppsPage", () => {
  it("lists apps with their kind and providers, linking to each", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ apps: [testApp()] }))));
    renderAuthenticated(<AppsPage />);
    const link = await screen.findByRole("link", { name: "My app" });
    expect(link.getAttribute("href")).toBe("/apps/my-app");
    expect(screen.getByText("Server (app key)")).toBeTruthy();
    expect(screen.getByText("openai")).toBeTruthy();
  });

  it("shows the month's totals for all your apps, deleted ones included, and each app's line", async () => {
    const line = { charges: 0, failed: 0, unpriced: 0, cost_nano: 0, cost_usd: 0, input_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, output_tokens: 0, session_ms: 0 };
    const usage = {
      month: "2026-11",
      totals: { ...line, charges: 12, failed: 2, unpriced: 1, cost_nano: 3_500_000_000, cost_usd: 3.5, input_tokens: 1_000, output_tokens: 500 },
      apps: [
        { app_id: "my-app", name: "My app", deleted: false, ...line, charges: 7, failed: 2, unpriced: 3, cost_nano: 2_000_000_000, cost_usd: 2 },
        { app_id: "gone-app", name: null, deleted: true, ...line, charges: 5, cost_nano: 1_500_000_000, cost_usd: 1.5 },
      ],
      first_usage_day: "2026-10-03",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      new Response(JSON.stringify(String(input).startsWith("/v2/admin/usage") ? usage : { apps: [testApp()] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderAuthenticated(<AppsPage />);
    expect(await screen.findByText("$3.50")).toBeTruthy();
    expect(screen.getByText("includes 1 deleted app")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("2 failed", { selector: "p" })).toBeTruthy();
    // The app's own line: its charges and spend this month.
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("$2.00")).toBeTruthy();
    // So an app whose charges are unpriced does not just read as its dollars.
    expect(screen.getByText("3 unpriced")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => /^\/v2\/admin\/usage\?month=\d{4}-\d{2}$/u.test(String(input)))).toBe(true);
  });

  it("shows unavailable, never old figures, when the month's usage cannot be read (Neon 7b-6)", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith("/v2/admin/usage")
        ? new Response(JSON.stringify({ error: { code: "internal_error", message: "No" } }), { status: 500 })
        : new Response(JSON.stringify({ apps: [testApp()] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderAuthenticated(<AppsPage />);
    expect((await screen.findAllByText("unavailable")).length).toBe(4);
    expect(screen.queryByText("all your apps")).toBeNull();
    expect(screen.queryByText(/failed$/u)).toBeNull();
  });

  it("creates a server app and shows its first key once", async () => {
    const created = { app: testApp({ id: "new-app" }), api_key: { id: "k1", name: "Default", key: "agw_app_secret", key_prefix: "agw_app_", created_at: "2026-11-01T00:00:00.000Z" } };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify(created), { status: 201 })
        : new Response(JSON.stringify({ apps: [] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { router } = renderAuthenticated(<AppsPage />);

    await userEvent.click(await screen.findByRole("button", { name: /new app/i }));
    await userEvent.click(screen.getByLabelText(/^name$/i));
    await userEvent.paste("Backend");
    await userEvent.click(screen.getByRole("radio", { name: /server/i }));
    await userEvent.click(screen.getByRole("button", { name: /create app/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
      expect(post && JSON.parse(String(post[1]!.body))).toEqual({
        name: "Backend",
        config: { authentication: { type: "api_key", end_user: { source: "none" } } },
      });
    });
    expect(await screen.findByDisplayValue("agw_app_secret")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /saved this key/i }));
    await waitFor(() => expect(router.location.pathname).toBe("/apps/new-app"));
  });

  it("will not create an iOS app without a valid team id and bundle id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ apps: [] }))));
    renderAuthenticated(<AppsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /new app/i }));
    await userEvent.type(screen.getByLabelText(/^name$/i), "Phone");
    await userEvent.type(screen.getByLabelText(/team id/i), "short");
    await userEvent.type(screen.getByLabelText(/bundle id/i), "com.example.app");
    expect(screen.getByRole("button", { name: /create app/i }).hasAttribute("disabled")).toBe(true);
  });
});

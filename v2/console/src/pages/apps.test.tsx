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
    await userEvent.type(screen.getByLabelText(/^name$/i), "Backend");
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

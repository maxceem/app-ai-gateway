import { afterEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { screen } from "@testing-library/react";
import { AppDetailPage } from "./app-detail";
import { renderAuthenticated, stubApi } from "@/test/render";

const APP_ID = "my-app";

const APP_ROW = {
  id: APP_ID,
  name: "My app",
  status: "active",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  config: {
    authentication: { type: "api_key" },
    routing: { providers: { mode: "all" }, model_rewrites: {} },
  },
};

function renderSection(tab: string) {
  stubApi({
    // Longest prefixes first: `stubApi` matches the first key that prefixes the
    // URL, and the app row's own path prefixes all of these.
    [`/v1/admin/apps/${APP_ID}/usage`]: { body: { app_id: APP_ID, requests: 0 } },
    [`/v1/admin/apps/${APP_ID}/users`]: { body: { app_id: APP_ID, total: 0, users: [] } },
    [`/v1/admin/apps/${APP_ID}/keys`]: { body: { app_id: APP_ID, keys: [] } },
    [`/v1/admin/apps/${APP_ID}`]: { body: { app: APP_ROW, resolved: null, config_error: null } },
  });
  return renderAuthenticated(
    <Routes>
      <Route path="/apps/:appId/:tab/:section?" element={<AppDetailPage />} />
    </Routes>,
    { route: `/apps/${APP_ID}/${tab}` },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("AppDetailPage", () => {
  it("heads the content with the section the sidebar is pointing at", async () => {
    renderSection("auth");
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Auth policy");
  });

  it("keeps the app's own actions off the header", async () => {
    renderSection("overview");

    // Turning the app off and deleting it are Settings' business; a menu that
    // followed every section would say they belong to all of them.
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    expect(screen.queryByRole("button", { name: /more actions/i })).toBeNull();
  });

  it("names every section by the same words the rail uses", async () => {
    for (const [tab, label] of [
      ["overview", "Overview"],
      ["proxy", "Proxy policy"],
      ["limits", "Limits"],
      ["settings", "Settings"],
    ] as const) {
      const { unmount } = renderSection(tab);
      expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe(label);
      unmount();
    }
  });

  it("offers the month only where the page counts one", async () => {
    const overview = renderSection("overview");
    expect(await screen.findByLabelText("Month")).toBeTruthy();
    overview.unmount();

    renderSection("settings");
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    expect(screen.queryByLabelText("Month")).toBeNull();
  });
});

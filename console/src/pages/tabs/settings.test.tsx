import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { AppDetailPage } from "@/pages/app-detail";
import { renderAuthenticated, stubApi } from "@/test/render";

const APP = {
  id: "my-app",
  name: "My app",
  status: "active",
  config: {
    authentication: { type: "api_key", end_user: { source: "none" } },
    routing: { providers: { mode: "all" }, model_rewrites: {} },
  },
};

/** Rendered through the page, so the tab is reached the way the sidebar reaches it. */
function renderSettings(role: "owner" | "member", tab = "settings", apiBaseUrl?: string) {
  stubApi({
    "/v1/admin/apps/my-app/keys": { body: { app_id: APP.id, keys: [] } },
    "/v1/admin/apps/my-app": { body: { app: APP } },
  });
  return renderAuthenticated(
    <Routes>
      <Route path="/apps/:appId/:tab" element={<AppDetailPage />} />
    </Routes>,
    { session: { role }, route: `/apps/my-app/${tab}`, capabilities: { apiBaseUrl } },
  );
}

/** The "Client base URL" block; the page has other `code` elements before it. */
const baseUrl = () =>
  [...document.querySelectorAll("code")]
    .find((element) => element.textContent?.includes("/v1/apps/"))?.textContent ?? "";

afterEach(() => vi.unstubAllGlobals());

describe("SettingsTab", () => {
  it("holds the name, the id, the switch and the delete action", async () => {
    renderSettings("owner");

    expect(await screen.findByLabelText(/^name$/i)).toHaveProperty("value", "My app");
    // The id is read and copied, never typed: text with a copy control, not a field.
    expect(screen.getByText("my-app", { selector: "code" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /copy application id/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^copy$/i })).toBeNull();
    expect(screen.getByRole("switch", { name: /app enabled/i }).getAttribute("aria-checked"))
      .toBe("true");
    expect(screen.getByRole("button", { name: /delete app/i })).toHaveProperty("disabled", false);
  });

  it("builds the client base URL from the console's own origin by default", async () => {
    renderSettings("owner");

    await waitFor(() =>
      expect(baseUrl()).toBe(`${window.location.origin}/v1/apps/my-app/proxy/{provider}/{provider_path}`));
  });

  /**
   * A deployment that publishes a separate host for application clients is the
   * only thing that can tell the console about it, so the advertised origin
   * replaces the window's rather than being appended to it.
   */
  it("advertises the deployment's API host when one is configured", async () => {
    renderSettings("owner", "settings", "https://api.example.com");

    await waitFor(() =>
      expect(baseUrl()).toBe("https://api.example.com/v1/apps/my-app/proxy/{provider}/{provider_path}"));
    expect(baseUrl()).not.toContain(window.location.origin);
  });

  it("turns the app off through the draft, to be saved with everything else", async () => {
    renderSettings("owner");

    await userEvent.click(await screen.findByRole("switch", { name: /app enabled/i }));

    expect(screen.getByRole("switch", { name: /app enabled/i }).getAttribute("aria-checked"))
      .toBe("false");
    expect(await screen.findByText(/unsaved changes to/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /save changes/i })).toBeTruthy();
  });

  it("asks for the id before deleting", async () => {
    renderSettings("owner");

    await userEvent.click(await screen.findByRole("button", { name: /delete app/i }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Delete My app?");
    // The confirm button shares its name with the trigger; it is the one in the dialog.
    const confirm = [...dialog.querySelectorAll("button")]
      .find((button) => button.textContent === "Delete app")!;
    expect(confirm).toHaveProperty("disabled", true);
  });

  it("leaves the record read-only for a member, and says why", async () => {
    renderSettings("member");

    expect(await screen.findByLabelText(/^name$/i)).toHaveProperty("disabled", true);
    expect(screen.getByRole("switch", { name: /app enabled/i })).toHaveProperty("disabled", true);
    const remove = screen.getByRole("button", { name: /delete app/i });
    expect(remove).toHaveProperty("disabled", true);
    expect(document.getElementById(remove.getAttribute("aria-describedby")!)?.textContent)
      .toMatch(/read-only|cannot/i);
  });
});

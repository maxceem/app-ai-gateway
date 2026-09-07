import { describe, expect, it } from "vitest";
import { Route, Routes } from "react-router-dom";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsPage } from "./settings";
import { renderAuthenticated } from "@/test/render";

/** Settings is only reachable through its section routes, so tests mount them. */
function renderSettings(route = "/settings/account") {
  return renderAuthenticated(
    <Routes>
      <Route path="/settings/:section" element={<SettingsPage />} />
    </Routes>,
    { route },
  );
}

describe("SettingsPage", () => {
  it("opens on the account section and lists every section in the menu", () => {
    renderSettings();

    const menu = screen.getByRole("navigation", { name: /settings sections/i });
    expect(menu.querySelectorAll("a")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Account" })).toHaveProperty("ariaCurrent", "page");
    expect(screen.getByText("ada@example.test")).toBeTruthy();
  });

  it("swaps the panel for the section the operator picks", async () => {
    const { router } = renderSettings();

    // The password form belongs to its own section, not the account panel.
    expect(screen.queryByLabelText(/current password/i)).toBeNull();

    await userEvent.click(screen.getByRole("link", { name: /change password/i }));

    expect(router.location.pathname).toBe("/settings/password");
    expect(screen.getByLabelText(/current password/i)).toBeTruthy();
    expect(screen.queryByText("ada@example.test")).toBeNull();
  });

  it("falls back to the account section for an unknown one", () => {
    const { router } = renderSettings("/settings/nonsense");

    expect(router.location.pathname).toBe("/settings/account");
    expect(screen.getByText("ada@example.test")).toBeTruthy();
  });
});

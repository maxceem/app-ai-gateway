import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppShell } from "./app-shell";
import { membership, renderAuthenticated } from "@/test/render";

/** The account block at the foot of the sidebar holds the admin destinations. */
async function openAccountMenu() {
  await userEvent.click(screen.getByRole("button", { name: /ada lovelace/i }));
  return screen.findByRole("menu");
}

describe("AppShell navigation", () => {
  it("keeps the sidebar to the two primary destinations", () => {
    renderAuthenticated(<AppShell>content</AppShell>);

    const nav = screen.getByRole("navigation");
    expect(nav.querySelectorAll("a")).toHaveLength(2);
    expect(screen.getByRole("link", { name: /apps/i }).getAttribute("href")).toBe("/apps");
    expect(screen.getByRole("link", { name: /providers/i }).getAttribute("href")).toBe("/providers");
  });

  it("marks the destination matching the current route", () => {
    renderAuthenticated(<AppShell>content</AppShell>, { route: "/providers" });

    expect(screen.getByRole("link", { name: /providers/i })).toHaveProperty(
      "ariaCurrent",
      "page",
    );
    expect(screen.getByRole("link", { name: /apps/i }).getAttribute("aria-current")).toBeNull();
  });

  it("names only the operator in the sidebar, never their organization", async () => {
    renderAuthenticated(<AppShell>content</AppShell>);

    expect(screen.getByText("ada@example.test")).toBeTruthy();
    // Acme is the session's organization; the rail is the operator's, not the org's.
    expect(screen.queryByText("Acme")).toBeNull();

    // It reappears in the menu only for an operator who can act as another org.
    await openAccountMenu();
    expect(screen.queryByRole("menuitem", { name: /acme/i })).toBeNull();
  });

  it("offers the organizations a multi-org operator can act as, in the menu", async () => {
    renderAuthenticated(<AppShell>content</AppShell>, {
      session: { memberships: [membership("org-1", "Acme"), membership("org-2", "Globex")] },
    });

    expect(screen.queryByText("Globex")).toBeNull();

    await openAccountMenu();

    expect(screen.getByRole("menuitem", { name: /globex/i })).toBeTruthy();
  });

  it("moves account and organization administration into the user menu", async () => {
    renderAuthenticated(<AppShell>content</AppShell>);

    // Absent until the operator opens their account block.
    expect(screen.queryByRole("menuitem", { name: /management keys/i })).toBeNull();

    await openAccountMenu();

    expect(screen.getByRole("menuitem", { name: /settings/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /management keys/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /sign out/i })).toBeTruthy();
  });

  it("hides every billing trace when the deployment has billing off", async () => {
    renderAuthenticated(<AppShell>content</AppShell>, {
      capabilities: { billing: false },
      // Even a stale inactive status must not leak billing into a self-hosted console.
      billing: { status: "inactive", reason: "past_due" },
    });

    await openAccountMenu();

    expect(screen.queryByRole("menuitem", { name: /billing/i })).toBeNull();
    expect(screen.queryByText(/past due/i)).toBeNull();
    expect(screen.queryByText(/view plans/i)).toBeNull();
  });

  it("shows billing in the user menu when the capability is present", async () => {
    renderAuthenticated(<AppShell>content</AppShell>, {
      capabilities: { billing: true },
      billing: { status: "active" },
    });

    await openAccountMenu();

    expect(screen.getByRole("menuitem", { name: /billing/i })).toBeTruthy();
  });

  it("raises a banner with a route to plans when the subscription lapses", () => {
    renderAuthenticated(<AppShell>content</AppShell>, {
      capabilities: { billing: true },
      billing: { status: "inactive", reason: "past_due" },
    });

    expect(screen.getByText(/payment past due/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /view plans/i })).toBeTruthy();
  });

  it("offers Providers to every role, since credentials are readable by members", () => {
    renderAuthenticated(<AppShell>content</AppShell>, { session: { role: "member" } });

    expect(screen.getByRole("link", { name: /providers/i }).getAttribute("href"))
      .toBe("/providers");
  });

  it("flags a read-only member's role in the sidebar", () => {
    renderAuthenticated(<AppShell>content</AppShell>, { session: { role: "member" } });

    expect(screen.getByText(/read-only/i)).toBeTruthy();
  });

  it("leaves an admin unflagged", () => {
    renderAuthenticated(<AppShell>content</AppShell>, { session: { role: "admin" } });

    expect(screen.queryByText(/read-only/i)).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppShell } from "./app-shell";
import { membership, renderAuthenticated, stubApi } from "@/test/render";

afterEach(() => vi.unstubAllGlobals());

/** Opens an app so the rail is handed over to it. */
function renderInsideApp(route = "/apps/app-1/overview") {
  stubApi({
    "/v1/admin/apps/app-1": {
      body: {
        app: { id: "app-1", name: "My app", status: "active", config: {} },
        resolved: null,
        config_error: null,
      },
    },
  });
  return renderAuthenticated(<AppShell>content</AppShell>, { route });
}

/** The account block at the foot of the sidebar holds the admin destinations. */
async function openAccountMenu() {
  await userEvent.click(screen.getByRole("button", { name: /ada lovelace/i }));
  return screen.findByRole("menu");
}

describe("AppShell navigation", () => {
  it("keeps the sidebar to the two primary destinations", () => {
    renderAuthenticated(<AppShell>content</AppShell>, { route: "/apps" });

    const nav = screen.getByRole("navigation");
    // A destination's own sections stay folded away until it is the one open.
    expect(nav.querySelectorAll("a")).toHaveLength(2);
    expect(screen.getByRole("link", { name: /apps/i }).getAttribute("href")).toBe("/apps");
    expect(screen.getByRole("link", { name: /providers/i }).getAttribute("href")).toBe("/providers");
  });

  it("marks the destination matching the current route", () => {
    renderAuthenticated(<AppShell>content</AppShell>, { route: "/apps" });

    expect(screen.getByRole("link", { name: /apps/i })).toHaveProperty("ariaCurrent", "page");
    expect(screen.getByRole("link", { name: /providers/i }).getAttribute("aria-current"))
      .toBeNull();
  });

  it("opens Gateways under Providers in the rail, not in a menu of its own", () => {
    renderAuthenticated(<AppShell>content</AppShell>, { route: "/providers" });

    const nav = screen.getByRole("navigation");
    const links = [...nav.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    // Providers holds its own list, so only the gateways need a row.
    expect(links).toEqual(["/apps", "/providers", "/providers/gateways"]);
    expect(screen.getByRole("link", { name: "Providers" })).toHaveProperty("ariaCurrent", "page");
    expect(screen.getByRole("link", { name: "Gateways" }).getAttribute("aria-current")).toBeNull();
  });

  it("moves the mark onto Gateways when that is the list open", () => {
    renderAuthenticated(<AppShell>content</AppShell>, { route: "/providers/gateways" });

    expect(screen.getByRole("link", { name: "Gateways" })).toHaveProperty("ariaCurrent", "page");
    // Providers is still the destination the operator is inside, but it is no
    // longer the page they are on.
    expect(screen.getByRole("link", { name: "Providers" }).getAttribute("aria-current")).toBeNull();
  });

  it("hands the rail to an app, replacing the console's own destinations", async () => {
    renderInsideApp();

    // Providers is not a place to be while an app is open; the rail is the app's.
    expect(screen.queryByRole("link", { name: "Providers" })).toBeNull();
    expect(await screen.findByText("My app")).toBeTruthy();
    expect(screen.getByText("app-1")).toBeTruthy();

    const nav = screen.getByRole("navigation");
    const links = [...nav.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    expect(links).toEqual([
      "/apps/app-1/overview",
      "/apps/app-1/auth",
      "/apps/app-1/proxy",
      "/apps/app-1/endpoints",
      "/apps/app-1/users",
      "/apps/app-1/usage",
      "/apps/app-1/auth-events",
      "/apps/app-1/json",
    ]);
  });

  it("keeps the way back out above the record, where a provider's would also sit", () => {
    renderInsideApp();

    const back = screen.getByRole("link", { name: /^apps$/i });
    expect(back.getAttribute("href")).toBe("/apps");
    // Above the sections rather than among them, so it stays put whatever the
    // record is and whatever sections it has.
    expect(back.compareDocumentPosition(screen.getByRole("navigation")))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("marks the section being read", () => {
    renderInsideApp("/apps/app-1/users");

    expect(screen.getByRole("link", { name: "Users" })).toHaveProperty("ariaCurrent", "page");
    expect(screen.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBeNull();
  });

  it("names the app by its id until the record loads", () => {
    // No stub: the rail must still say which app it belongs to.
    renderAuthenticated(<AppShell>content</AppShell>, { route: "/apps/app-1/overview" });

    expect(screen.getAllByText("app-1").length).toBeGreaterThan(0);
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

    expect(screen.getByRole("link", { name: "Providers" }).getAttribute("href"))
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

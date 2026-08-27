import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { AppShell } from "./app-shell";
import { renderAuthenticated } from "@/test/render";

describe("AppShell navigation", () => {
  it("hides every billing trace when the deployment has billing off", () => {
    renderAuthenticated(<AppShell>content</AppShell>, {
      capabilities: { billing: false },
      // Even a stale inactive status must not leak billing into a self-hosted console.
      billing: { status: "inactive", reason: "past_due" },
    });

    expect(screen.queryByRole("link", { name: /billing/i })).toBeNull();
    expect(screen.queryByText(/past due/i)).toBeNull();
    expect(screen.queryByText(/view plans/i)).toBeNull();
  });

  it("shows the billing nav when the capability is present", () => {
    renderAuthenticated(<AppShell>content</AppShell>, {
      capabilities: { billing: true },
      billing: { status: "active" },
    });

    expect(screen.getByRole("link", { name: /billing/i })).toBeTruthy();
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

  it("hides the members nav from a read-only member and flags the role", () => {
    renderAuthenticated(<AppShell>content</AppShell>, { session: { role: "member" } });

    // The server refuses to list members for a member, so the nav would only 403.
    expect(screen.queryByRole("link", { name: /members/i })).toBeNull();
    expect(screen.getByText(/read-only/i)).toBeTruthy();
  });

  it("shows the members nav to an admin without the read-only flag", () => {
    renderAuthenticated(<AppShell>content</AppShell>, { session: { role: "admin" } });

    expect(screen.getByRole("link", { name: /members/i })).toBeTruthy();
    expect(screen.queryByText(/read-only/i)).toBeNull();
  });
});

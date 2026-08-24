import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OrganizationSwitcher } from "./org-switcher";
import { membership, renderAuthenticated } from "@/test/render";

afterEach(() => vi.unstubAllGlobals());

describe("OrganizationSwitcher", () => {
  it("shows a plain label, not a switcher, for a single membership", () => {
    renderAuthenticated(<OrganizationSwitcher />, {
      session: { memberships: [membership("org-1", "Acme")] },
    });

    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers a switcher listing every membership when there are several", async () => {
    renderAuthenticated(<OrganizationSwitcher />, {
      session: {
        memberships: [
          membership("org-1", "Acme", "owner"),
          membership("org-2", "Globex", "member"),
        ],
      },
    });

    const trigger = screen.getByRole("button", { name: /acme/i });
    await userEvent.click(trigger);

    expect(await screen.findByRole("menuitem", { name: /globex/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /acme/i })).toBeTruthy();
  });

  it("drops every organization-scoped cache when switching", async () => {
    const nextSession = {
      session: {
        user: { id: "user-1", email: "ada@example.test" },
        organization: { id: "org-2", name: "Globex" },
        role: "member",
        memberships: [],
        credentialType: "session",
      },
    };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(nextSession), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { client } = renderAuthenticated(<OrganizationSwitcher />, {
      session: {
        memberships: [
          membership("org-1", "Acme", "owner"),
          membership("org-2", "Globex", "member"),
        ],
      },
    });
    // Data belonging to the organization being switched away from.
    client.setQueryData(["apps", "2026-08"], { apps: [{ id: "acme-only-app" }] });

    await userEvent.click(screen.getByRole("button", { name: /acme/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /globex/i }));

    await waitFor(() => {
      // Keeping it would show the previous tenant's apps under the new org.
      expect(client.getQueryData(["apps", "2026-08"])).toBeUndefined();
      expect(client.getQueryData(["session"])).toMatchObject({
        organization: { id: "org-2" },
      });
    });
  });

  it("stays available to a read-only member", () => {
    renderAuthenticated(<OrganizationSwitcher />, {
      session: {
        role: "member",
        memberships: [
          membership("org-1", "Acme", "member"),
          membership("org-2", "Globex", "member"),
        ],
      },
    });

    expect(screen.getByRole("button", { name: /acme/i })).toHaveProperty("disabled", false);
  });
});

import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OrganizationSwitcher } from "./org-switcher";
import { membership, renderAuthenticated } from "@/test/render";

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

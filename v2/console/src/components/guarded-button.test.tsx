import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GuardedButton } from "./guarded-button";
import { renderAuthenticated } from "@/test/render";

describe("GuardedButton", () => {
  it("stays clickable for an owner", async () => {
    const onClick = vi.fn();
    renderAuthenticated(<GuardedButton onClick={onClick}>Create app</GuardedButton>, {
      session: { role: "owner" },
    });

    await userEvent.click(screen.getByRole("button", { name: /create app/i }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("stays clickable for an admin", async () => {
    const onClick = vi.fn();
    renderAuthenticated(<GuardedButton onClick={onClick}>Create app</GuardedButton>, {
      session: { role: "admin" },
    });

    await userEvent.click(screen.getByRole("button", { name: /create app/i }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("disables rather than hides the action for a read-only member", async () => {
    const onClick = vi.fn();
    renderAuthenticated(<GuardedButton onClick={onClick}>Create app</GuardedButton>, {
      session: { role: "member" },
    });

    const button = screen.getByRole("button", { name: /create app/i });
    // Visible, so the console does not look broken — but inert.
    expect(button).toBeTruthy();
    expect(button).toHaveProperty("disabled", true);

    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("keeps the action's own name and describes the restriction separately", () => {
    renderAuthenticated(<GuardedButton>Create app</GuardedButton>, {
      session: { role: "member" },
    });

    // Naming the button after the reason would lose what the action even is.
    const button = screen.getByRole("button", { name: /create app/i });
    expect(button.getAttribute("aria-disabled")).toBe("true");

    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/read-only/i);
  });

  it("does not nest an interactive role inside the action", () => {
    renderAuthenticated(<GuardedButton>Create app</GuardedButton>, {
      session: { role: "member" },
    });

    // The focusable wrapper exists for the tooltip only; a role here would be
    // a nested-interactive violation.
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("shows the reason on hover", async () => {
    renderAuthenticated(<GuardedButton>Create app</GuardedButton>, {
      session: { role: "member" },
    });

    await userEvent.hover(screen.getByRole("button", { name: /create app/i }).parentElement!);
    expect((await screen.findAllByText(/read-only/i)).length).toBeGreaterThan(0);
  });

  it("prefers an explicit reason over the default read-only copy", () => {
    renderAuthenticated(
      <GuardedButton reason="An organization must keep at least one owner.">Remove</GuardedButton>,
      { session: { role: "owner" } },
    );

    const button = screen.getByRole("button", { name: /remove/i });
    expect(button).toHaveProperty("disabled", true);
    const describedBy = button.getAttribute("aria-describedby");
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/at least one owner/i);
  });
});

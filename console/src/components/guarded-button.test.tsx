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

  it("explains the restriction on focus", async () => {
    renderAuthenticated(<GuardedButton>Create app</GuardedButton>, {
      session: { role: "member" },
    });

    await userEvent.tab();
    expect(await screen.findByText(/read-only/i)).toBeTruthy();
  });

  it("prefers an explicit reason over the default read-only copy", async () => {
    renderAuthenticated(
      <GuardedButton reason="An organization must keep at least one owner.">Remove</GuardedButton>,
      { session: { role: "owner" } },
    );

    const button = screen.getByRole("button", { name: /remove/i });
    expect(button).toHaveProperty("disabled", true);

    await userEvent.tab();
    expect(await screen.findByText(/at least one owner/i)).toBeTruthy();
  });
});

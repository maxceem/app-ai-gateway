import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FormDialog } from "./form-dialog";
import { renderAuthenticated } from "@/test/render";

function renderDialog(onOpenChange: (open: boolean) => void) {
  renderAuthenticated(
    <FormDialog
      open
      onOpenChange={onOpenChange}
      title="New provider"
      submitLabel="Create provider"
      onSubmit={() => {}}
    >
      <input aria-label="Name" defaultValue="half-typed" />
    </FormDialog>,
    { session: { role: "owner" } },
  );
}

describe("FormDialog", () => {
  // A stray click beside a half-filled form used to discard everything typed.
  it("stays open when the backdrop is clicked", async () => {
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);

    const overlay = document.querySelector("[data-slot=dialog-overlay]");
    expect(overlay).toBeTruthy();
    await userEvent.click(overlay as Element);

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "half-typed");
  });

  it("closes from Cancel", async () => {
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);

    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes from the close button", async () => {
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);

    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // Escape is a deliberate keystroke, and screen readers announce it as the way
  // out of a modal, so it keeps working.
  it("closes on Escape", async () => {
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);

    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

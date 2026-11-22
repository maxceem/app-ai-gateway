import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FullIds, shortId } from "./short-id";

afterEach(() => vi.useRealTimers());

const LONG = "user-0123456789abcdef0123456789";

describe("FullIds", () => {
  it("opens the full ids from the keyboard, and names them for a screen reader (Neon 7b-6)", async () => {
    const user = userEvent.setup();
    render(
      <FullIds ids={[{ label: "User", value: LONG }]}>
        <span>{shortId(LONG)}</span>
      </FullIds>,
    );
    const trigger = screen.getByRole("button", { name: `User ${LONG}` });
    await user.tab();
    expect(document.activeElement).toBe(trigger);
    await user.keyboard("{Enter}");
    expect(await screen.findByText(LONG)).toBeTruthy();
    // The copy button is reachable inside the open panel.
    expect(screen.getByRole("button", { name: "Copy user" })).toBeTruthy();
  });

  it("shows a short id as it is, with nothing to open", () => {
    render(
      <FullIds ids={[{ label: "User", value: "u1" }]}>
        <span>u1</span>
      </FullIds>,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});

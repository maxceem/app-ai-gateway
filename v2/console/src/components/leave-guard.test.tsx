import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Link } from "react-router-dom";
import { LeaveGuard } from "./leave-guard";
import { renderAuthenticated } from "@/test/render";

function Page() {
  const [text, setText] = useState("");
  return (
    <>
      <LeaveGuard dirty={text !== ""} />
      <label>
        Draft
        <input value={text} onChange={(event) => setText(event.target.value)} />
      </label>
      <Link to="/elsewhere">Elsewhere</Link>
    </>
  );
}

describe("LeaveGuard", () => {
  it("lets a clean page go without asking", async () => {
    const { router } = renderAuthenticated(<Page />, { route: "/here" });
    await userEvent.click(screen.getByRole("link", { name: "Elsewhere" }));
    await waitFor(() => expect(router.location.pathname).toBe("/elsewhere"));
  });

  it("asks before unsaved changes are left, and stays or leaves as chosen", async () => {
    const { router } = renderAuthenticated(<Page />, { route: "/here" });
    await userEvent.type(screen.getByLabelText("Draft"), "x");
    await userEvent.click(screen.getByRole("link", { name: "Elsewhere" }));
    expect(await screen.findByText(/leave without saving/i)).toBeTruthy();
    expect(router.location.pathname).toBe("/here");
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByText(/leave without saving/i)).toBeNull());
    expect(router.location.pathname).toBe("/here");
    await userEvent.click(screen.getByRole("link", { name: "Elsewhere" }));
    await userEvent.click(await screen.findByRole("button", { name: /^leave$/i }));
    await waitFor(() => expect(router.location.pathname).toBe("/elsewhere"));
  });

  it("asks the browser before a tab with unsaved changes is closed", async () => {
    renderAuthenticated(<Page />, { route: "/here" });
    const before = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(false);
    await userEvent.type(screen.getByLabelText("Draft"), "x");
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(true);
  });
});

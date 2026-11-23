import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountMenuItems } from "./account-switcher";
import { DropdownMenu, DropdownMenuContent } from "@/components/ui/dropdown-menu";
import { membership, renderAuthenticated, testSession } from "@/test/render";
import { tabAccount } from "@/lib/tab-account";

afterEach(() => vi.unstubAllGlobals());

/** The section only ever renders inside the account menu, so tests open one. */
function inOpenMenu() {
  return (
    <DropdownMenu open>
      <DropdownMenuContent>
        <AccountMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

describe("AccountMenuItems", () => {
  it("renders nothing for a single account", () => {
    renderAuthenticated(inOpenMenu(), {
      session: { accounts: [membership("acct-1", "Acme")] },
    });

    expect(screen.queryByText("Acme")).toBeNull();
    expect(screen.queryByText(/accounts/i)).toBeNull();
  });

  it("lists every account when there are several", async () => {
    renderAuthenticated(inOpenMenu(), {
      session: {
        accounts: [
          membership("acct-1", "Acme", "owner"),
          membership("acct-2", "Globex", "member"),
        ],
      },
    });

    expect(await screen.findByRole("menuitem", { name: /globex/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /acme/i })).toBeTruthy();
  });

  it("saves the account for this tab and reloads the page on it, taking nothing else meanwhile", async () => {
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    const fetchMock = vi.fn(async () => {
      await answered;
      return new Response(JSON.stringify({ session: testSession({ account: { id: "acct-2", name: "Globex" } }) }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });

    const { client } = renderAuthenticated(inOpenMenu(), {
      session: {
        accounts: [
          membership("acct-1", "Acme", "owner"),
          membership("acct-2", "Globex", "member"),
        ],
      },
    });
    await userEvent.click(await screen.findByRole("menuitem", { name: /globex/i }));
    // While the switch is in flight, the menu takes no other choice.
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /acme/i }).getAttribute("data-disabled")).not.toBeNull());
    answer();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(tabAccount()).toBe("acct-2");
    // Nothing was swapped in place: the page that reloads reads the new account.
    expect(client.getQueryData(["session"])).toBeUndefined();
    expect(screen.getByRole("menuitem", { name: /acme/i }).getAttribute("data-disabled")).not.toBeNull();
  });

  it("stays available to a read-only member", async () => {
    renderAuthenticated(inOpenMenu(), {
      session: {
        role: "member",
        accounts: [
          membership("acct-1", "Acme", "member"),
          membership("acct-2", "Globex", "member"),
        ],
      },
    });

    const item = await screen.findByRole("menuitem", { name: /globex/i });
    expect(item.getAttribute("data-disabled")).toBeNull();
  });
});

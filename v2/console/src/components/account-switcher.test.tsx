import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountMenuItems } from "./account-switcher";
import { DropdownMenu, DropdownMenuContent } from "@/components/ui/dropdown-menu";
import { act, fireEvent } from "@testing-library/react";
import { toast } from "sonner";
import { membership, renderAuthenticated, testSession } from "@/test/render";
import { beginAccountSwitch, tabAccount } from "@/lib/tab-account";
import { call } from "@/lib/api";
import { useStartCheckout } from "@/lib/queries";
import { AppShell } from "./app-shell";
import { SidebarContent } from "./app-sidebar";

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
    const real = window.location;
    vi.stubGlobal("location", { get pathname() { return real.pathname; }, get search() { return real.search; }, reload });

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

  it("takes no switch while a checkout that may open a payment page is pending (Sol 7b-8)", async () => {
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    vi.stubGlobal("fetch", vi.fn(async () => {
      await answered;
      return new Response(JSON.stringify({ url: "https://checkout.example/pay" }), { status: 200 });
    }));
    function Pay() {
      const checkout = useStartCheckout();
      return <button type="button" onClick={() => void checkout.mutateAsync({ planKey: "pro", billingPeriod: "month" }).catch(() => undefined)}>Pay</button>;
    }
    renderAuthenticated(<>{inOpenMenu()}<Pay /></>, {
      session: { accounts: [membership("acct-1", "Acme", "owner"), membership("acct-2", "Globex", "member")] },
    });
    const globex = await screen.findByRole("menuitem", { name: /globex/i });
    expect(globex.getAttribute("data-disabled")).toBeNull();
    // The open menu blocks pointer events on the page behind it, as a menu does.
    fireEvent.click(screen.getByRole("button", { name: "Pay", hidden: true }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /globex/i }).getAttribute("data-disabled")).not.toBeNull());
    answer();
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /globex/i }).getAttribute("data-disabled")).toBeNull());
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

describe("the console during an account switch", () => {
  it("is inert, and a form submitted by keyboard sends nothing (Sol 7b-8)", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const refused = vi.fn();
    function Form() {
      return (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void call("listApps").catch(refused);
          }}
        >
          <input aria-label="App name" />
        </form>
      );
    }
    const { container } = renderAuthenticated(<AppShell><Form /></AppShell>);
    const input = screen.getByLabelText("App name");
    input.focus();
    act(() => beginAccountSwitch());
    expect(container.querySelector("[inert]")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/switching account/i);
    fetchMock.mockClear();
    await userEvent.keyboard("{Enter}");
    // Whether or not the inert shell let the key through, nothing leaves the page.
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/v2/admin/apps"))).toEqual([]);
  });
});

describe("signing out", () => {
  function openUserMenu() {
    return userEvent.click(screen.getByText("Ada Lovelace"));
  }

  it("goes to sign-in only once signing out succeeded, and says so when it failed (Sol 7b-8)", async () => {
    const error = vi.spyOn(toast, "error");
    let fail = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/sign-out") && fail
        ? new Response(JSON.stringify({ message: "Sign-out is unavailable" }), { status: 503 })
        : new Response(JSON.stringify({ success: true }), { status: 200 })));
    const { router } = renderAuthenticated(<SidebarContent />, { route: "/apps" });
    await openUserMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: /sign out/i }));
    await waitFor(() => expect(error).toHaveBeenCalledWith("Sign-out is unavailable"));
    expect(router.location.pathname).toBe("/apps");

    fail = false;
    await openUserMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: /sign out/i }));
    await waitFor(() => expect(router.location.pathname).toBe("/login"));
  });
});

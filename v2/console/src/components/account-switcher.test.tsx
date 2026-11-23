import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountMenuItems } from "./account-switcher";
import { DropdownMenu, DropdownMenuContent } from "@/components/ui/dropdown-menu";
import { fireEvent } from "@testing-library/react";
import { toast } from "sonner";
import { membership, renderAuthenticated, testSession } from "@/test/render";
import { isLeavingForAccountSwitch, resetTabAccountForTests, tabAccount } from "@/lib/tab-account";
import { LeaveGuard } from "./leave-guard";
import { useStartCheckout } from "@/lib/queries";
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

  it("saves the account for this tab and reloads the page on it, with the menu disabled meanwhile", async () => {
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

describe("switching accounts with unsaved changes", () => {
  afterEach(() => resetTabAccountForTests());

  /** The account menu beside a page that has unsaved changes. */
  function withUnsavedPage() {
    return (
      <>
        <LeaveGuard dirty />
        {inOpenMenu()}
      </>
    );
  }

  function setup() {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ session: testSession({ account: { id: "acct-2", name: "Globex" } }) }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const reload = vi.fn();
    const real = window.location;
    vi.stubGlobal("location", { get pathname() { return real.pathname; }, get search() { return real.search; }, reload });
    renderAuthenticated(withUnsavedPage(), {
      session: { accounts: [membership("acct-1", "Acme", "owner"), membership("acct-2", "Globex", "member")] },
    });
    return { fetchMock, reload };
  }

  it("asks first, and staying leaves everything as it was: nothing is sent and requests still work", async () => {
    const { fetchMock, reload } = setup();
    fireEvent.click(await screen.findByRole("menuitem", { name: /globex/i }));
    expect(await screen.findByText(/leave without saving/i)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByText(/leave without saving/i)).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(isLeavingForAccountSwitch()).toBe(false);
    expect(screen.getByRole("menuitem", { name: /globex/i }).getAttribute("data-disabled")).toBeNull();
  });

  it("switches once the person confirms, and reloads without the browser asking again", async () => {
    const { fetchMock, reload } = setup();
    fireEvent.click(await screen.findByRole("menuitem", { name: /globex/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^leave$/i }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tabAccount()).toBe("acct-2");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
  });
});

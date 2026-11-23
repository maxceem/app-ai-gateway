/**
 * Each console tab keeps its own account: every management call names it, a
 * new tab opens on the account the session selects, a switch moves only this
 * tab, and a checkout return opens the tab on the account it was for.
 */
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { call } from "./api";
import { readSession, useSelectAccount } from "./queries";
import { resetTabAccountForTests, setTabAccount, tabAccount } from "./tab-account";
import { testQueryClient, testSession } from "@/test/render";

/** A gateway whose session answers for the account a request names, or, naming none, for the one the shared cookie selects. */
function stubGateway(cookie: { selected: string }, members: readonly string[] = ["acct-1", "acct-2"]) {
  const sent: { url: string; account: string | null }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const account = new Headers(init?.headers).get("x-account-id");
    sent.push({ url, account });
    if (url.includes("/get-session")) return new Response(JSON.stringify({ session: {} }), { status: 200 });
    if (url.includes("/v2/admin/session")) {
      if (account !== null && !members.includes(account)) {
        return new Response(JSON.stringify({ error: { code: "account_forbidden", message: "You are not a member of this account" } }), { status: 403 });
      }
      const id = account ?? cookie.selected;
      return new Response(JSON.stringify({ session: testSession({ account: { id, name: id } }) }), { status: 200 });
    }
    if (url.includes("/v2/admin/accounts/select")) {
      const { accountId } = JSON.parse(String(init?.body)) as { accountId: string };
      cookie.selected = accountId;
      return new Response(JSON.stringify({ session: testSession({ account: { id: accountId, name: accountId } }) }), { status: 200 });
    }
    return new Response(JSON.stringify({ apps: [] }), { status: 200 });
  }));
  return { sessionReads: () => sent.filter((entry) => entry.url.includes("/v2/admin/session")).map((entry) => entry.account), sent };
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("a console tab's account", () => {
  it("is named on every management call once the tab has one, and not before", async () => {
    const { sent } = stubGateway({ selected: "acct-1" });
    await call("listApps");
    expect(sent.at(-1)!.account).toBeNull();
    setTabAccount("acct-2");
    await call("listApps");
    expect(sent.at(-1)!.account).toBe("acct-2");
  });

  it("opens on the account the session selects, and keeps it after another tab switches the shared one", async () => {
    const cookie = { selected: "acct-1" };
    const { sessionReads } = stubGateway(cookie);
    expect((await readSession())?.account.id).toBe("acct-1");
    expect(tabAccount()).toBe("acct-1");
    // Another tab switches: the shared cookie now selects acct-2. This tab still names acct-1.
    cookie.selected = "acct-2";
    expect((await readSession())?.account.id).toBe("acct-1");
    expect(sessionReads()).toEqual([null, "acct-1"]);
  });

  it("moves when switched in this tab, and the switch becomes the account new tabs open on", async () => {
    const cookie = { selected: "acct-1" };
    stubGateway(cookie);
    setTabAccount("acct-1");
    const client = testQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useSelectAccount(), { wrapper });
    await act(() => result.current.mutateAsync("acct-2"));
    expect(tabAccount()).toBe("acct-2");
    expect(cookie.selected).toBe("acct-2");
  });

  it("opens on the default account when it names one the person is not a member of", async () => {
    const { sessionReads } = stubGateway({ selected: "acct-1" });
    setTabAccount("acct-gone");
    expect((await readSession())?.account.id).toBe("acct-1");
    expect(tabAccount()).toBe("acct-1");
    expect(sessionReads()).toEqual(["acct-gone", null]);
  });

  it("opens on the account a checkout return names", () => {
    window.history.replaceState(null, "", "/v2/apps?checkout=success&plan=pro&account=acct-2");
    resetTabAccountForTests();
    expect(tabAccount()).toBe("acct-2");
  });
});

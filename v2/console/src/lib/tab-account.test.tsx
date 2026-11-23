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
import { membership, testQueryClient, testSession } from "@/test/render";
import { keys } from "./queries";

/** A gateway whose session answers for the account a request names, or, naming none, for the one the shared cookie selects. */
function stubGateway(
  cookie: { selected: string },
  members: readonly string[] = ["acct-1", "acct-2"],
  hold: (account: string | null) => Promise<void> = async () => undefined,
) {
  const sent: { url: string; account: string | null }[] = [];
  const accounts = members.map((id) => membership(id, id));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const account = new Headers(init?.headers).get("x-account-id");
    sent.push({ url, account });
    if (url.includes("/v2/admin/session")) await hold(account);
    if (url.includes("/get-session")) return new Response(JSON.stringify({ session: {} }), { status: 200 });
    if (url.includes("/v2/admin/session")) {
      if (account !== null && !members.includes(account)) {
        return new Response(JSON.stringify({ error: { code: "account_forbidden", message: "You are not a member of this account" } }), { status: 403 });
      }
      const id = account ?? cookie.selected;
      return new Response(JSON.stringify({ session: testSession({ account: { id, name: id }, accounts }) }), { status: 200 });
    }
    if (url.includes("/v2/admin/accounts/select")) {
      const { accountId } = JSON.parse(String(init?.body)) as { accountId: string };
      cookie.selected = accountId;
      return new Response(JSON.stringify({ session: testSession({ account: { id: accountId, name: accountId }, accounts }) }), { status: 200 });
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

  it("keeps the account shown and the account named together when a session read for the account left lands after a switch (Sol 7b-8)", async () => {
    const cookie = { selected: "acct-1" };
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    stubGateway(cookie, ["acct-1", "acct-2"], (account) => (account === "acct-1" ? held : Promise.resolve()));
    setTabAccount("acct-1");
    const client = testQueryClient();
    // A session read for acct-1 is out.
    const late = client.fetchQuery({ queryKey: keys.session, queryFn: () => readSession(), staleTime: 0 }).catch(() => undefined);
    await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/v2/admin/session"))).toBe(true));
    // The tab switches to acct-2, then the old read answers for acct-1.
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useSelectAccount(), { wrapper });
    await act(() => result.current.mutateAsync("acct-2"));
    release();
    await late;
    expect(tabAccount()).toBe("acct-2");
    expect((client.getQueryData(keys.session) as { account: { id: string } }).account.id).toBe("acct-2");
  });

  it("ignores an account id of the wrong shape from the address or from storage, and keeps working (Sol 7b-8)", async () => {
    const { sent } = stubGateway({ selected: "acct-1" });
    window.history.replaceState(null, "", "/v2/apps?checkout=success&plan=pro&account=bad%0Aid");
    resetTabAccountForTests();
    expect(tabAccount()).toBeNull();
    // A reload with a bad value already stored: it is dropped, and requests still go out.
    window.history.replaceState(null, "", "/v2/apps");
    resetTabAccountForTests();
    sessionStorage.setItem("agw.tab-account", "bad\nid");
    expect(tabAccount()).toBeNull();
    expect(sessionStorage.getItem("agw.tab-account")).toBeNull();
    expect((await readSession())?.account.id).toBe("acct-1");
    expect(sent.every((entry) => entry.account === null || entry.account === "acct-1")).toBe(true);
  });

  it("opens on the account a checkout return names after signing in, only if the person is a member of it (Sol 7b-8)", async () => {
    stubGateway({ selected: "acct-1" });
    // Signed out on the return, so the console sent the person to sign in, carrying the return.
    window.history.replaceState(null, "", `/v2/login?from=${encodeURIComponent("/apps?checkout=success&plan=pro&account=acct-2")}`);
    setTabAccount(null);
    expect((await readSession())?.account.id).toBe("acct-2");
    expect(tabAccount()).toBe("acct-2");
    // An account the person is not a member of is not opened on.
    window.history.replaceState(null, "", `/v2/login?from=${encodeURIComponent("/apps?checkout=success&plan=pro&account=acct-9")}`);
    setTabAccount(null);
    expect((await readSession())?.account.id).toBe("acct-1");
    expect(tabAccount()).toBe("acct-1");
  });
});

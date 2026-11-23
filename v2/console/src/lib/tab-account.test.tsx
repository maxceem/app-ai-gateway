/**
 * Each console tab keeps its own account: every management call names it, a
 * new tab opens on the account the session selects, and any change of account
 * saves it for the tab and reloads the page on it.
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { call } from "./api";
import { readSession, SWITCH_DEADLINE_MS, useSelectAccount, useSignOut } from "./queries";
import { goToPaymentPage, reopenTabForTests, resetTabAccountForTests, setTabAccount, switchTabAccount, tabAccount } from "./tab-account";
import { membership, testQueryClient, testSession } from "@/test/render";

interface Gateway {
  /** The account the shared cookie selects. */
  selected: string;
  /** Whether the browser is signed in. */
  signedIn: boolean;
}

/** A gateway whose session answers for the account a request names, or, naming none, for the one the shared cookie selects. */
function stubGateway(gateway: Gateway, members: readonly string[] = ["acct-1", "acct-2"]) {
  const sent: { url: string; account: string | null }[] = [];
  const accounts = members.map((id) => membership(id, id));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const account = new Headers(init?.headers).get("x-account-id") || null;
    sent.push({ url, account });
    if (url.includes("/get-session")) return new Response(JSON.stringify(gateway.signedIn ? { session: {} } : null), { status: 200 });
    if (url.includes("/sign-out")) {
      gateway.signedIn = false;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (url.includes("/billing/status") && account !== null && !members.includes(account)) {
      return new Response(JSON.stringify({ error: { code: "account_forbidden", message: "You are not a member of this account" } }), { status: 403 });
    }
    if (url.includes("/v2/admin/session")) {
      if (account !== null && !members.includes(account)) {
        return new Response(JSON.stringify({ error: { code: "account_forbidden", message: "You are not a member of this account" } }), { status: 403 });
      }
      const id = account ?? gateway.selected;
      return new Response(JSON.stringify({ session: testSession({ account: { id, name: id }, accounts }) }), { status: 200 });
    }
    if (url.includes("/v2/admin/accounts/select")) {
      if (account !== null && !members.includes(account)) {
        return new Response(JSON.stringify({ error: { code: "account_forbidden", message: "You are not a member of this account" } }), { status: 403 });
      }
      const { accountId } = JSON.parse(String(init?.body)) as { accountId: string };
      gateway.selected = accountId;
      return new Response(JSON.stringify({ session: testSession({ account: { id: accountId, name: accountId }, accounts }) }), { status: 200 });
    }
    return new Response(JSON.stringify({ apps: [] }), { status: 200 });
  }));
  return {
    sent,
    sessionReads: () => sent.filter((entry) => entry.url.includes("/v2/admin/session")).map((entry) => entry.account),
  };
}

let reload: ReturnType<typeof vi.fn>;
let replace: ReturnType<typeof vi.fn>;
let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  reload = vi.fn();
  replace = vi.fn();
  assign = vi.fn();
  // The page's own address, as `history.replaceState` moves it, with a reload that only records itself.
  const real = window.location;
  vi.stubGlobal("location", {
    get href() { return real.href; },
    get pathname() { return real.pathname; },
    get search() { return real.search; },
    get origin() { return real.origin; },
    reload,
    replace,
    assign,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Checks a session read reloads the page instead of answering: nothing renders from the page it leaves. */
async function reloadsInstead(read: Promise<unknown>): Promise<void> {
  let settled = false;
  void read.then(() => (settled = true), () => (settled = true));
  await vi.waitFor(() => expect(reload).toHaveBeenCalled());
  await Promise.resolve();
  expect(settled).toBe(false);
}

/** Loads the page again, as the reload does: the tab's account comes back from storage. */
function reloadPage(at = "/v2/apps"): void {
  window.history.replaceState(null, "", at);
  reopenTabForTests();
}

describe("a console tab's account", () => {
  it("is named on every management call once the tab has one, and not before", async () => {
    const { sent } = stubGateway({ selected: "acct-1", signedIn: true });
    await call("listApps");
    expect(sent.at(-1)!.account).toBeNull();
    setTabAccount("acct-2");
    await call("listApps");
    expect(sent.at(-1)!.account).toBe("acct-2");
  });

  it("opens on the account the session selects, and keeps it after another tab switches the shared one", async () => {
    const gateway = { selected: "acct-1", signedIn: true };
    const { sessionReads } = stubGateway(gateway);
    expect((await readSession())?.account.id).toBe("acct-1");
    expect(tabAccount()).toBe("acct-1");
    gateway.selected = "acct-2";
    reloadPage();
    expect((await readSession())?.account.id).toBe("acct-1");
    expect(sessionReads()).toEqual([null, "acct-1"]);
    expect(reload).not.toHaveBeenCalled();
  });

  it("switches by saving the account and reloading: the new page names the new account and holds nothing from the old one", async () => {
    const gateway = { selected: "acct-1", signedIn: true };
    const { sessionReads } = stubGateway(gateway);
    setTabAccount("acct-1");
    const before = testQueryClient();
    before.setQueryData(["apps"], { apps: [{ id: "acme-only-app" }] });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={before}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useSelectAccount(), { wrapper });
    act(() => void result.current.mutateAsync("acct-2"));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(tabAccount()).toBe("acct-2");
    // The gateway now opens new tabs on it too.
    expect(gateway.selected).toBe("acct-2");

    // The page loads again, with a fresh cache.
    reloadPage();
    const after = testQueryClient();
    expect(after.getQueryData(["apps"])).toBeUndefined();
    expect((await readSession())?.account.id).toBe("acct-2");
    expect(sessionReads().at(-1)).toBe("acct-2");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("falls back to the session's account when the saved one is no longer the person's, reloading once without looping", async () => {
    const { sessionReads } = stubGateway({ selected: "acct-1", signedIn: true });
    setTabAccount("acct-gone");
    await reloadsInstead(readSession());
    expect(reload).toHaveBeenCalledTimes(1);
    expect(tabAccount()).toBeNull();

    reloadPage();
    expect((await readSession())?.account.id).toBe("acct-1");
    expect(tabAccount()).toBe("acct-1");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionReads()).toEqual(["acct-gone", null]);
  });

  it("opens a tab with no saved account on a checkout return's account, if the person is a member of it", async () => {
    const gateway = { selected: "acct-1", signedIn: true };
    const { sessionReads } = stubGateway(gateway);
    window.history.replaceState(null, "", "/v2/apps?checkout=success&plan=pro&account=acct-2");
    await reloadsInstead(readSession());
    expect(tabAccount()).toBe("acct-2");
    expect(gateway.selected).toBe("acct-2");

    reloadPage("/v2/apps?checkout=success&plan=pro&account=acct-2");
    expect((await readSession())?.account.id).toBe("acct-2");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionReads()).toEqual([null, "acct-2"]);
  });

  it("ignores an account id of the wrong shape from the address or from storage, and keeps working (Sol 7b-8)", async () => {
    const { sent } = stubGateway({ selected: "acct-1", signedIn: true });
    window.history.replaceState(null, "", "/v2/apps?checkout=success&plan=pro&account=bad%0Aid");
    expect((await readSession())?.account.id).toBe("acct-1");
    expect(reload).not.toHaveBeenCalled();
    // A reload with a bad value already stored: it is dropped, and requests still go out.
    resetTabAccountForTests();
    sessionStorage.setItem("agw.tab-account", "bad\nid");
    reloadPage();
    expect(tabAccount()).toBeNull();
    expect(sessionStorage.getItem("agw.tab-account")).toBeNull();
    expect((await readSession())?.account.id).toBe("acct-1");
    expect(sent.every((entry) => entry.account === null || entry.account === "acct-1")).toBe(true);
  });

  it("keeps its saved account through an expired session, and comes back to it on signing in; a checkout return does not replace it (Sol 7b-8)", async () => {
    const gateway = { selected: "acct-1", signedIn: false };
    const { sessionReads } = stubGateway(gateway);
    setTabAccount("acct-2");
    // Signed out on the sign-in page, which carries a checkout return for acct-1.
    reloadPage(`/v2/login?from=${encodeURIComponent("/apps?checkout=success&plan=pro&account=acct-1")}`);
    expect(await readSession()).toBeNull();
    expect(tabAccount()).toBe("acct-2");
    // Signing in, with both accounts the person's: the saved one is checked and kept.
    gateway.signedIn = true;
    expect((await readSession())?.account.id).toBe("acct-2");
    expect(tabAccount()).toBe("acct-2");
    expect(reload).not.toHaveBeenCalled();
    expect(sessionReads()).toEqual(["acct-2"]);
  });

  it("opens on a checkout return carried through sign-in when it has no saved account, only if the person is a member of it", async () => {
    const gateway = { selected: "acct-1", signedIn: false };
    stubGateway(gateway);
    reloadPage(`/v2/login?from=${encodeURIComponent("/apps?checkout=success&plan=pro&account=acct-2")}`);
    expect(await readSession()).toBeNull();
    gateway.signedIn = true;
    await reloadsInstead(readSession());
    expect(tabAccount()).toBe("acct-2");

    // An account the person is not a member of is not opened on.
    resetTabAccountForTests();
    reload.mockClear();
    reloadPage(`/v2/login?from=${encodeURIComponent("/apps?checkout=success&plan=pro&account=acct-9")}`);
    expect((await readSession())?.account.id).toBe("acct-2");
    expect(reload).not.toHaveBeenCalled();
  });

  it("is forgotten on signing out, and kept when signing out fails (Sol 7b-8)", async () => {
    const gateway = { selected: "acct-1", signedIn: true };
    stubGateway(gateway);
    setTabAccount("acct-2");
    const client = testQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useSignOut(), { wrapper });
    // The sign-out fails: the person is still signed in, on the same account.
    const answer = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementationOnce(async () => new Response(JSON.stringify({ message: "down" }), { status: 503 }));
    await act(() => expect(result.current.mutateAsync()).rejects.toThrow());
    expect(tabAccount()).toBe("acct-2");
    vi.mocked(fetch).mockImplementation(answer);
    await act(() => result.current.mutateAsync());
    expect(tabAccount()).toBeNull();
  });

  it("names the account the page shows while a switch request is out, and sends nothing once the page is leaving: the old page never writes to the new account (Sol 7b-8)", async () => {
    const { sent } = stubGateway({ selected: "acct-1", signedIn: true });
    setTabAccount("acct-1");
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    const real = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("/accounts/select")) await answered;
      return real(input, init);
    });
    const client = testQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useSelectAccount(), { wrapper });
    act(() => void result.current.mutateAsync("acct-2").catch(() => undefined));
    await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/accounts/select"))).toBe(true));
    // The switch request is out: a request still names the account the page shows.
    await call("listApps");
    expect(sent.filter((entry) => entry.url.includes("/apps")).map((entry) => entry.account)).toEqual(["acct-1"]);
    answer();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    // The tab now names acct-2, but this page shows acct-1: it sends nothing more.
    expect(tabAccount()).toBe("acct-2");
    await expect(call("listApps")).rejects.toMatchObject({ code: "account_switching" });
    expect(sent.filter((entry) => entry.url.includes("/apps"))).toHaveLength(1);
  });

  it("lets the page carry on when the switch request fails", async () => {
    stubGateway({ selected: "acct-1", signedIn: true }, ["acct-1"]);
    setTabAccount("acct-1");
    const real = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input).includes("/accounts/select")
        ? new Response(JSON.stringify({ error: { code: "forbidden", message: "no" } }), { status: 403 })
        : real(input, init));
    const client = testQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useSelectAccount(), { wrapper });
    await act(() => expect(result.current.mutateAsync("acct-2")).rejects.toThrow());
    expect(tabAccount()).toBe("acct-1");
    expect(reload).not.toHaveBeenCalled();
    await expect(call("listApps")).resolves.toBeDefined();
  });

  it("goes to Billing instead of reloading the checkout landing, replacing it in history, so no checkout starts for the new account (Sol 7b-8)", () => {
    window.history.replaceState(null, "", "/v2/checkout?plan=pro");
    setTabAccount("acct-1");
    switchTabAccount("acct-2");
    expect(replace).toHaveBeenCalledWith("/v2/billing");
    expect(reload).not.toHaveBeenCalled();
    expect(tabAccount()).toBe("acct-2");
  });

  it("forgets an account the person was removed from mid-session, on any request, reloading once (Sol 7b-8)", async () => {
    stubGateway({ selected: "acct-1", signedIn: true }, ["acct-1"]);
    setTabAccount("acct-2");
    await expect(call("getBillingStatus")).rejects.toMatchObject({ code: "account_forbidden" });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(tabAccount()).toBeNull();
    // The page is reloading: nothing more is sent, and nothing reloads it twice.
    await expect(call("getBillingStatus")).rejects.toMatchObject({ code: "account_switching" });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("stays locked once a failed switch has started the page's reload: nothing more is sent (Sol 7b-8)", async () => {
    const { sent } = stubGateway({ selected: "acct-1", signedIn: true }, ["acct-1", "acct-2"]);
    // The tab still names an account the person was removed from.
    setTabAccount("acct-gone");
    const client = testQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useSelectAccount(), { wrapper });
    await act(() => expect(result.current.mutateAsync("acct-2")).rejects.toMatchObject({ code: "account_forbidden" }));
    expect(reload).toHaveBeenCalledTimes(1);
    const before = sent.length;
    await expect(call("listApps")).rejects.toMatchObject({ code: "account_switching" });
    expect(sent.length).toBe(before);
  });

  it("gives up a switch request that takes too long, and lets the page carry on (Sol 7b-8)", async () => {
    stubGateway({ selected: "acct-1", signedIn: true });
    setTabAccount("acct-1");
    const real = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (!String(input).includes("/accounts/select")) return real(input, init);
      // A gateway that never answers; only the deadline ends the request.
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const client = testQueryClient();
      const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
      const { result } = renderHook(() => useSelectAccount(), { wrapper });
      let outcome: unknown;
      act(() => void result.current.mutateAsync("acct-2").catch((error: unknown) => (outcome = error)));
      await vi.advanceTimersByTimeAsync(SWITCH_DEADLINE_MS - 1);
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(outcome).toBeInstanceOf(Error));
      expect((outcome as Error).message).toBe("Switching account took too long. Try again.");
      expect(tabAccount()).toBe("acct-1");
      expect(reload).not.toHaveBeenCalled();
      await expect(call("listApps")).resolves.toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens a payment page, but not once the page is leaving for an account switch", () => {
    setTabAccount("acct-1");
    goToPaymentPage("https://pay.example/one");
    expect(assign).toHaveBeenCalledWith("https://pay.example/one");
    // A checkout answered after the switch began belongs to the account being left.
    switchTabAccount("acct-2");
    goToPaymentPage("https://pay.example/two");
    expect(assign).toHaveBeenCalledTimes(1);
  });
});

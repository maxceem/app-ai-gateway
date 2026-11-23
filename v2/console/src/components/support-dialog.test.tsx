/**
 * Human support in the console (v1's app shell tests, ported): the Support
 * menu in the account block, offered where the deployment names an inbox and
 * the plan includes support, and the dialog that sends a message. The gateway
 * is stubbed: nothing is sent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SidebarContent } from "./app-sidebar";
import { renderAuthenticated } from "@/test/render";
import type { BillingAccess } from "@/lib/types";
import { CONSOLE_BASE } from "@/lib/auth-redirect";

const PAID: BillingAccess = { state: "billed", plan: { planKey: "pro", planName: "Pro", isDefault: false }, subscription: null };

/** The gateway as the menu reads it: the plan's features, or billing that cannot be read; and the support call. */
function stub(features: { humanSupport: boolean } | "unreachable") {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/billing/status")) {
      if (features === "unreachable") return new Response(JSON.stringify({ error: { code: "billing_unavailable", message: "Billing is unavailable" } }), { status: 503 });
      return new Response(
        JSON.stringify({ access: PAID, allowance: null, limits: {}, features: { conversationStorage: true, ...features }, actions: { cancel: false, resume: false, manual: false } }),
        { status: 200 },
      );
    }
    if (url.includes("/v2/admin/support")) {
      return new Response(JSON.stringify({ status: "sent", reference: "SUP-7F3K2Q", replyTo: "ada@example.test", duplicate: false }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const SUPPORTED = { billing: true, supportEmail: "support@example.test" };

function openUserMenu() {
  return userEvent.click(screen.getByText("Ada Lovelace"));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the Support menu", () => {
  it("offers support on a plan that includes it, saying so, and sends a message from the dialog with the page it was written on", async () => {
    const fetchMock = stub({ humanSupport: true });
    // The router as production runs it, below the console's `/v2` base: the ticket names the page as the browser shows it.
    renderAuthenticated(<SidebarContent />, { route: "/v2/apps/demo", basename: CONSOLE_BASE, capabilities: SUPPORTED });
    await openUserMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Human Support" }));
    expect(await screen.findByText("Included with your Pro plan")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Contact Support" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Send Feedback" })).toBeTruthy();
    await userEvent.click(screen.getByRole("menuitem", { name: "Report a Bug" }));

    const dialog = await screen.findByRole("dialog", { name: "Report a bug" });
    expect(dialog).toBeTruthy();
    // The person's own mail app is offered too, with the topic as the subject.
    expect(screen.getByRole("link", { name: "support@example.test" }).getAttribute("href")).toBe("mailto:support@example.test?subject=Bug%20report");
    await userEvent.click(screen.getByLabelText("Message"));
    await userEvent.paste("Streams stop halfway.");
    expect(screen.getByRole("link", { name: "support@example.test" }).getAttribute("href")).toBe(
      "mailto:support@example.test?subject=Bug%20report&body=Streams%20stop%20halfway.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Send report" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Report a bug" })).toBeNull());
    const sent = fetchMock.mock.calls.find(([input]) => String(input).includes("/v2/admin/support"));
    // With who started the draft, so the gateway refuses it if the browser has signed in as someone else since.
    expect(JSON.parse(String(sent![1]!.body))).toEqual({ kind: "bug", message: "Streams stop halfway.", page: "/v2/apps/demo", sender: "user-1" });
  });

  it("still offers support while billing cannot be read, as the gateway still accepts a message", async () => {
    stub("unreachable");
    renderAuthenticated(<SidebarContent />, { capabilities: SUPPORTED });
    await openUserMenu();
    expect(await screen.findByRole("menuitem", { name: "Human Support" })).toBeTruthy();
  });

  it("offers no support on a plan without it, or where the deployment names no inbox", async () => {
    stub({ humanSupport: false });
    const first = renderAuthenticated(<SidebarContent />, { capabilities: SUPPORTED });
    await openUserMenu();
    await screen.findByRole("menuitem", { name: /sign out/i });
    // The plan's reading has come back by now: the menu has had its chance to appear.
    await waitFor(() => expect(first.client.isFetching()).toBe(0));
    expect(screen.queryByRole("menuitem", { name: /support/i })).toBeNull();
    first.unmount();

    const fetchMock = stub({ humanSupport: true });
    renderAuthenticated(<SidebarContent />, { capabilities: { billing: true } });
    await openUserMenu();
    await screen.findByRole("menuitem", { name: /sign out/i });
    expect(screen.queryByRole("menuitem", { name: /support/i })).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/v2/admin/support"))).toBe(false);
  });
});

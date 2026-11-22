import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { continuePath, tokenFromHash, VerifyEmailPage } from "./verify-email";
import { renderPublic, stubApi, testQueryClient } from "@/test/render";

const CONFIRM_URL = "/v2/console/email-verification/confirm";

afterEach(() => vi.unstubAllGlobals());

/** Presses Verify, the only thing that confirms the token. */
const pressVerify = async () => userEvent.click(await screen.findByRole("button", { name: /verify email/i }));

describe("VerifyEmailPage", () => {
  it("confirms the token from the link's fragment once on Verify, takes it out of the address bar, and offers where to continue", async () => {
    const fetchMock = stubApi({ [CONFIRM_URL]: { body: { email: "person@example.test", returnTo: "/apps" } } });
    const { router } = renderPublic(<VerifyEmailPage />, { route: "/verify-email#token=abc.def", path: "/verify-email" });
    await pressVerify();
    expect(await screen.findByText(/person@example.test is verified/i)).toBeTruthy();
    const continueLink = screen.getByRole("link", { name: /continue/i });
    expect(continueLink.getAttribute("href")).toBe("/apps");
    const confirms = fetchMock.mock.calls.filter(([url]) => String(url).startsWith(CONFIRM_URL));
    expect(confirms).toHaveLength(1);
    expect(JSON.parse(String(confirms[0]![1]?.body))).toEqual({ token: "abc.def" });
    await waitFor(() => expect(router.location.hash).toBe(""));
  });

  it("confirms nothing when the page only loads, as a mail scanner opening the link would (Fable 7b-7)", async () => {
    const fetchMock = stubApi({ [CONFIRM_URL]: { body: { email: "person@example.test", returnTo: null } } });
    const { router } = renderPublic(<VerifyEmailPage />, { route: "/verify-email#token=abc.def", path: "/verify-email" });
    expect(await screen.findByRole("button", { name: /verify email/i })).toBeTruthy();
    // The token is off the address bar, and still nothing has been posted.
    await waitFor(() => expect(router.location.hash).toBe(""));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith(CONFIRM_URL))).toHaveLength(0);
  });

  it("never reads a token from the query string, where request logs would keep it (Sol 7b-7)", () => {
    stubApi({});
    renderPublic(<VerifyEmailPage />, { route: "/verify-email?token=abc.def", path: "/verify-email" });
    expect(screen.getByText(/missing its token/i)).toBeTruthy();
    expect(tokenFromHash("#token=a.b")).toBe("a.b");
    expect(tokenFromHash("")).toBeNull();
  });

  it("continues at the console path the server names, under the router's /v2 base (Sol 7b-7)", async () => {
    expect(continuePath("/v2/apps")).toBe("/apps");
    expect(continuePath("/v2/apps/my-app?tab=usage")).toBe("/apps/my-app?tab=usage");
    expect(continuePath("/v2")).toBe("/");
    expect(continuePath("//evil.test/")).toBeNull();
    // Safe-looking before /v2 comes off, protocol-relative after: the landing page instead (Sol 7b-7 round 2).
    expect(continuePath("/v2//evil.test")).toBe("/apps");
    expect(continuePath("/v2/\\evil.test")).toBe("/apps");
    expect(continuePath("/v2//evil.test/path?x=1")).toBe("/apps");
    stubApi({ [CONFIRM_URL]: { body: { email: "person@example.test", returnTo: "/v2/apps" } } });
    const router = createMemoryRouter([{ path: "*", element: <VerifyEmailPage /> }], {
      basename: "/v2",
      initialEntries: ["/v2/verify-email#token=abc"],
    });
    render(
      <QueryClientProvider client={testQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await pressVerify();
    expect(await screen.findByText(/person@example.test is verified/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /continue/i }).getAttribute("href")).toBe("/v2/apps");
  });

  it("says a refused link did not work", async () => {
    stubApi({ [CONFIRM_URL]: { status: 400, body: { error: { code: "invalid_request", message: "This verification link is not valid any more." } } } });
    renderPublic(<VerifyEmailPage />, { route: "/verify-email#token=old", path: "/verify-email" });
    await pressVerify();
    expect(await screen.findByText(/this link did not work/i)).toBeTruthy();
    expect(screen.getByText(/not valid any more/i)).toBeTruthy();
  });

  it("offers Try again on a passing failure, with the token kept in memory (Neon 7b-7)", async () => {
    const bodies: unknown[] = [];
    const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).startsWith(CONFIRM_URL)) return json({}, 404);
        bodies.push(JSON.parse(String(init?.body)));
        return bodies.length === 1
          ? json({ error: { code: "service_unavailable", message: "Busy" } }, 503)
          : json({ email: "person@example.test", returnTo: null }, 200);
      }),
    );
    renderPublic(<VerifyEmailPage />, { route: "/verify-email#token=abc.def", path: "/verify-email" });
    await pressVerify();
    await userEvent.click(await screen.findByRole("button", { name: /try again/i }));
    expect(await screen.findByText(/person@example.test is verified/i)).toBeTruthy();
    expect(bodies).toEqual([{ token: "abc.def" }, { token: "abc.def" }]);
  });

  it("asks for the link again when it carries no token", () => {
    stubApi({});
    renderPublic(<VerifyEmailPage />, { route: "/verify-email", path: "/verify-email" });
    expect(screen.getByText(/missing its token/i)).toBeTruthy();
  });

  it("never continues off the console", async () => {
    stubApi({ [CONFIRM_URL]: { body: { email: "person@example.test", returnTo: "//evil.test/" } } });
    renderPublic(<VerifyEmailPage />, { route: "/verify-email#token=abc", path: "/verify-email" });
    await pressVerify();
    expect(await screen.findByText(/person@example.test is verified/i)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /continue/i })).toBeNull();
    expect(screen.getByRole("link", { name: /open the console/i }).getAttribute("href")).toBe("/apps");
  });
});

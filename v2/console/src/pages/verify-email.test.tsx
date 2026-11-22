import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { continuePath, tokenFromHash, VerifyEmailPage } from "./verify-email";
import { renderPublic, stubApi, testQueryClient } from "@/test/render";

const CONFIRM_URL = "/v2/console/email-verification/confirm";

afterEach(() => vi.unstubAllGlobals());

describe("VerifyEmailPage", () => {
  it("confirms the token from the link's fragment once, takes it out of the address bar, and offers where to continue", async () => {
    const fetchMock = stubApi({ [CONFIRM_URL]: { body: { email: "person@example.test", returnTo: "/apps" } } });
    const { router } = renderPublic(<VerifyEmailPage />, { route: "/verify-email#token=abc.def", path: "/verify-email" });
    expect(await screen.findByText(/person@example.test is verified/i)).toBeTruthy();
    const continueLink = screen.getByRole("link", { name: /continue/i });
    expect(continueLink.getAttribute("href")).toBe("/apps");
    const confirms = fetchMock.mock.calls.filter(([url]) => String(url).startsWith(CONFIRM_URL));
    expect(confirms).toHaveLength(1);
    expect(JSON.parse(String(confirms[0]![1]?.body))).toEqual({ token: "abc.def" });
    await waitFor(() => expect(router.location.hash).toBe(""));
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
    expect(await screen.findByText(/person@example.test is verified/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /continue/i }).getAttribute("href")).toBe("/v2/apps");
  });

  it("says a refused link did not work", async () => {
    stubApi({ [CONFIRM_URL]: { status: 400, body: { error: { code: "invalid_request", message: "This verification link is not valid any more." } } } });
    renderPublic(<VerifyEmailPage />, { route: "/verify-email#token=old", path: "/verify-email" });
    expect(await screen.findByText(/this link did not work/i)).toBeTruthy();
    expect(screen.getByText(/not valid any more/i)).toBeTruthy();
  });

  it("asks for the link again when it carries no token", () => {
    stubApi({});
    renderPublic(<VerifyEmailPage />, { route: "/verify-email", path: "/verify-email" });
    expect(screen.getByText(/missing its token/i)).toBeTruthy();
  });

  it("never continues off the console", async () => {
    stubApi({ [CONFIRM_URL]: { body: { email: "person@example.test", returnTo: "//evil.test/" } } });
    renderPublic(<VerifyEmailPage />, { route: "/verify-email#token=abc", path: "/verify-email" });
    expect(await screen.findByText(/person@example.test is verified/i)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /continue/i })).toBeNull();
    expect(screen.getByRole("link", { name: /open the console/i }).getAttribute("href")).toBe("/apps");
  });
});

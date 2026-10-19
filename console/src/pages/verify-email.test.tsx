import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { VerifyEmailPage } from "./verify-email";
import { renderPublic, stubApi } from "@/test/render";

const CONFIRM_URL = "/v1/console/email-verification/confirm";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("VerifyEmailPage", () => {
  it("confirms the link once, takes the token out of the address bar and continues where it was asked from", async () => {
    const fetchMock = stubApi({ [CONFIRM_URL]: { body: { email: "person@example.test", returnTo: "/apps" } } });
    const { router } = renderPublic(<VerifyEmailPage />, { route: "/verify-email?token=signed.link" });

    expect(await screen.findByText(/person@example.test is verified/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /continue/i }).getAttribute("href")).toBe("/apps");
    const confirms = fetchMock.mock.calls.filter(([url]) => String(url).startsWith(CONFIRM_URL));
    expect(confirms).toHaveLength(1);
    expect(JSON.parse(String(confirms[0]![1]?.body))).toEqual({ token: "signed.link" });
    await waitFor(() => expect(router.location.search).toBe(""));
  });

  it("says when a link did not work", async () => {
    stubApi({
      [CONFIRM_URL]: {
        status: 400,
        body: { error: { code: "invalid_request", message: "This verification link is not valid any more. Send a new one from the console." } },
      },
    });
    renderPublic(<VerifyEmailPage />, { route: "/verify-email?token=stale" });
    expect(await screen.findByText(/this link did not work/i)).toBeTruthy();
    expect(screen.getByText(/not valid any more/i)).toBeTruthy();
  });

  it("asks for the email again when the link has no token", () => {
    const fetchMock = stubApi({});
    renderPublic(<VerifyEmailPage />, { route: "/verify-email" });
    expect(screen.getByText(/missing its token/i)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
